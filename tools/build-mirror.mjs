#!/usr/bin/env node
// Prepares a built copy of the site for publishing on a public static host.
//
//   node tools/build-mirror.mjs            apply changes in place
//   node tools/build-mirror.mjs --check    change nothing; exit 1 if the tree is not publish-safe
//   options: --root <dir>  (default: cwd)   --origin <https://host>  (default: ORIGIN below)
//
// It does three things, all idempotent:
//   1. Sanitises data/*.json: removes editorial/provenance fields that the app never
//      renders, and drops references to image files that are not part of this build.
//   2. Writes an HTML shell per route (so deep links answer 200 and unfurl with their
//      own title/description/image instead of falling through to 404.html).
//   3. Verifies that no editorial working notes are left in what gets published.
//
// The tool owns index.html, 404.html, robots.txt, assets/mirror.css and every route
// shell (<route>.html plus the .html files under projects/, exhibitions/ and atlas/);
// it rewrites them on each run and removes sitemap.xml, which a noindex mirror must not ship.
// Zero dependencies — safe to drop into any build pipeline as a last step.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);

const CHECK = flag('--check');
const ROOT = option('--root', process.cwd());
const ORIGIN = option('--origin', 'https://amdf01-debug.github.io').replace(/\/+$/, '');

// ── What must never be published ────────────────────────────────────────────

// Editorial bookkeeping written by the curation pipeline. None of it is read by the app.
const ITEM_INTERNAL_KEYS = [
  'image_audit_note', 'source_note', 'note', 'provenance', 'source', 'source_url',
  'official_title', 'official_slug_aliases',
];
const IMAGE_INTERNAL_KEYS = ['provenance', 'hash'];

// Phrases that only ever appear in working notes. Checked against every remaining string.
const INTERNAL_MARKERS = [
  /rights[- ]pending/i, /not licensed/i, /sourcing mandate|per artist mandate/i, /\bminted \d{4}-/i,
  /vision-checked/i, /wall-detective/i, /travel-log/i, /photo-harvest/i, /pending wave/i,
  /\bgapfill\b/i, /\blovable\b/i, /\bsupabase\b/i, /google drive/i, /local archive/i,
  /canon record/i, /\b(?:TODO|FIXME)\b/,
];
// Captions are shown on the page, so they are held to a stricter standard.
const CAPTION_MARKERS = [
  /\bRIGHTS:/, /clearance required/i, /watermark/i, /unverified/i, /flag before publish/i,
  /names no individual photographer/i, /^merged from /i,
];

// Provenance classes the pipeline appends to captions, e.g. "Photo: Jane Doe (venue-press)".
const SOURCE_CLASS_TAGS = [
  'official / web source', 'official venue', 'official-exhibition-documentation', 'official',
  'venue-press', 'venue/press', 'web-research', 'web/gallery', 'web', 'gallery-site', 'own-gallery',
  'press', 'cms', 'library', 'book', 'Drive',
];

// ── Site constants ──────────────────────────────────────────────────────────

const SITE_NAME = 'VHILS — Alexandre Farto';
const SITE_DESCRIPTION =
  'World archive of subtraction, memory and public surface. The works, exhibitions and public interventions of Alexandre Farto (Vhils).';
const DEFAULT_IMAGE = '/images/d587a02142d58af2e509793d0fdd165d-1600.webp';

// Routes defined by the app's router that are not backed by a data record.
const STATIC_ROUTES = [
  { path: '/projects', label: 'Projects' },
  { path: '/work', label: 'Work' },
  { path: '/exhibitions', label: 'Exhibitions' },
  { path: '/films', label: 'Films' },
  { path: '/atlas', label: 'Atlas' },
  { path: '/atlas/tours', label: 'Atlas — Tours' },
  { path: '/about', label: 'About' },
  { path: '/studio', label: 'Studio' },
  { path: '/contact', label: 'Contact' },
];
// Directories in which every .html file is a generated route shell.
const OWNED_DIRS = ['projects', 'exhibitions', 'atlas'];

// A preview mirror must not compete with the official site in search results.
// Crawling stays allowed so that the noindex directive can actually be read.
const ROBOTS = 'noindex, follow';
const ROBOTS_TXT = 'User-agent: *\nAllow: /\nDisallow: /data/\n';
const FORBIDDEN_FILES = ['sitemap.xml'];

// Small corrections layered over the built stylesheet.
const MIRROR_CSS = `/* The app renders a skip link but the built stylesheet never styles it. */
.skip-link{position:absolute;left:var(--pad,16px);top:-80px;z-index:1000;padding:10px 14px;background:var(--ink,#090909);color:var(--bg,#f1f0ec);font:12px/1 ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;text-decoration:none}
.skip-link:focus{top:12px}
`;

// Everything the app loads is same-origin, so the policy can be strict.
// (frame-ancestors cannot be set from a <meta> tag; it needs a real response header.)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// ── Helpers ─────────────────────────────────────────────────────────────────

const problems = [];   // things a human has to fix; always fatal
const pending = [];    // differences between disk and desired state (fatal only with --check)
const stats = { strippedFields: 0, cleanedCaptions: 0, droppedImages: 0, repointedImages: 0, shells: 0 };

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(join(ROOT, rel));

function emit(rel, content) {
  const current = exists(rel) ? read(rel) : null;
  if (current === content) return;
  pending.push(`${current === null ? 'missing' : 'out of date'}: ${rel}`);
  if (CHECK) return;
  mkdirSync(dirname(join(ROOT, rel)), { recursive: true });
  writeFileSync(join(ROOT, rel), content);
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function summarise(text, max = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).replace(/[\s,;:—-]+$/, '')}…`;
}

// ── 1. Data ─────────────────────────────────────────────────────────────────

const availableImages = new Set(readdirSync(join(ROOT, 'images')));
const imageExists = (src) => typeof src === 'string' && availableImages.has(src.split('/').pop());

function parseSrcset(srcset) {
  return String(srcset ?? '')
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .filter(([url]) => url)
    .map(([url, descriptor]) => ({ url, descriptor, width: Number.parseInt(descriptor, 10) || 0 }));
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SOURCE_CLASS_SUFFIX = new RegExp(
  `\\s*\\((?:${SOURCE_CLASS_TAGS.map(escapeRegExp).join('|')}|(?:ig-canon|canon-official) \\([^()]*\\))\\)(?=[\\s.]*$)`,
);

/** Keeps the public part of a caption: description and credit, without pipeline bookkeeping. */
function publicCaption(caption) {
  let text = caption.replace(/\s*(?:RIGHTS:|Rights-pending\b)[\s\S]*$/, ''); // clearance notes always run to the end
  for (let previous; previous !== text;) { // tags can be stacked: "… (official) (web)"
    previous = text;
    text = text.replace(SOURCE_CLASS_SUFFIX, '');
  }
  text = text
    .replace(/^(?:studio )?hi-res$/i, '') // a file-quality label is not a caption
    .replace(/\s+\.$/, '.')
    .trim();
  // The pipeline appends "Photo: <credit>" even when the caption already ends with that credit.
  const lastCredit = text.lastIndexOf(' Photo: ');
  if (lastCredit > 0 && text.slice(0, lastCredit).includes(text.slice(lastCredit + 1))) {
    text = text.slice(0, lastCredit).trimEnd();
  }
  return text;
}

/** Returns the image with only resolvable sources, or null when nothing of it is published. */
function resolveImage(image) {
  if (!image || typeof image !== 'object') return image;
  for (const key of IMAGE_INTERNAL_KEYS) {
    if (key in image) { delete image[key]; stats.strippedFields += 1; }
  }
  if (typeof image.caption === 'string') {
    const cleaned = publicCaption(image.caption);
    if (cleaned !== image.caption) {
      stats.cleanedCaptions += 1;
      if (cleaned) image.caption = cleaned; else delete image.caption;
    }
  }
  if (!image.src) return image; // deliberately image-less record; the app renders a placeholder

  const candidates = parseSrcset(image.srcset).filter((c) => imageExists(c.url));
  if (!imageExists(image.src)) {
    if (candidates.length === 0) return null;
    const best = candidates.reduce((a, b) => (b.width > a.width ? b : a));
    if (best.width && image.w && image.h) {
      image.h = Math.round((image.h * best.width) / image.w);
      image.w = best.width;
    }
    image.src = best.url;
    stats.repointedImages += 1;
  }
  if (candidates.length > 0) {
    image.srcset = candidates.map((c) => [c.url, c.descriptor].filter(Boolean).join(' ')).join(', ');
  } else {
    delete image.srcset;
  }
  return image;
}

function sanitiseItem(item, file) {
  for (const key of ITEM_INTERNAL_KEYS) {
    if (key in item) { delete item[key]; stats.strippedFields += 1; }
  }
  if (item.hero) {
    const hero = resolveImage(item.hero);
    if (hero === null) problems.push(`${file}: "${item.slug}" hero image is not in images/ (${item.hero.src})`);
  }
  if (Array.isArray(item.gallery)) {
    let kept = item.gallery.map(resolveImage).filter((image) => image !== null);
    // A gallery reduced to copies of the hero would only show the same picture twice.
    if (kept.every((image) => image.src === item.hero?.src)) kept = [];
    stats.droppedImages += item.gallery.length - kept.length;
    item.gallery = kept;
  }
  return item;
}

function findMarkers(value, path, file) {
  if (typeof value === 'string') {
    const markers = path.endsWith('.caption') ? [...INTERNAL_MARKERS, ...CAPTION_MARKERS] : INTERNAL_MARKERS;
    const hit = markers.find((marker) => marker.test(value));
    if (hit) problems.push(`${file}: working-note text (${hit}) at ${path}: "${summarise(value, 90)}"`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, i) => findMarkers(entry, `${path}[${i}]`, file));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) findMarkers(entry, `${path}.${key}`, file);
  }
}

function sanitiseDataFile(file) {
  const data = JSON.parse(read(file));
  data.items = data.items.map((item) => sanitiseItem(item, file));
  data.items.forEach((item) => findMarkers(item, item.slug, file));
  emit(file, JSON.stringify(data));
  return data.items;
}

const projects = sanitiseDataFile('data/projects.json');
const exhibitions = sanitiseDataFile('data/exhibitions.json');
JSON.parse(read('data/index.json')).items.forEach((item) => findMarkers(item, item.slug, 'data/index.json'));

// Build placeholder that some app versions fetch; keep the file, drop its build comment.
if (exists('data/manual-edits.json')) {
  const edits = JSON.parse(read('data/manual-edits.json'));
  delete edits._note;
  emit('data/manual-edits.json', JSON.stringify(edits));
}

// ── 2. Route shells ─────────────────────────────────────────────────────────

// Reuse the hashed asset tags of the current build rather than hard-coding them.
const builtHead = read('index.html');
const assetTags = [
  ...builtHead.matchAll(/<link rel="modulepreload"[^>]*>|<script type="module"[^>]*><\/script>|<link rel="stylesheet"[^>]*>/g),
].map((match) => match[0]).filter((tag) => !tag.includes('/assets/mirror.css'));
if (!assetTags.some((tag) => tag.startsWith('<script'))) problems.push('index.html: could not find the app entry <script type="module">');

function shell({ path, title, heading, description, image }) {
  const url = `${ORIGIN}${path}`;
  const imageUrl = `${ORIGIN}${imageExists(image) ? image : DEFAULT_IMAGE}`;
  const e = escapeHtml;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${e(CSP)}" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f1f0ec" />
    <title>${e(title)}</title>
    <meta name="description" content="${e(description)}" />
    <meta name="robots" content="${ROBOTS}" />

    <!-- Open Graph -->
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${e(SITE_NAME)}" />
    <meta property="og:title" content="${e(heading)}" />
    <meta property="og:description" content="${e(description)}" />
    <meta property="og:url" content="${e(url)}" />
    <meta property="og:image" content="${e(imageUrl)}" />
    <meta property="og:locale" content="en" />

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${e(heading)}" />
    <meta name="twitter:description" content="${e(description)}" />
    <meta name="twitter:image" content="${e(imageUrl)}" />
    ${assetTags.join('\n    ')}
    <link rel="stylesheet" href="/assets/mirror.css">
  </head>
  <body>
    <div id="root"></div>
    <noscript>This site needs JavaScript to display the archive.</noscript>
  </body>
</html>
`;
}

const home = shell({ path: '/', title: SITE_NAME, heading: SITE_NAME, description: SITE_DESCRIPTION, image: DEFAULT_IMAGE });

const routes = [
  // The app sets document.title itself where it wants one. Shells of list pages keep the
  // site title so that client-side navigation can never leave a stale page title behind.
  ...STATIC_ROUTES.map(({ path, label }) => ({
    path, title: SITE_NAME, heading: `${label} · VHILS`, description: SITE_DESCRIPTION, image: DEFAULT_IMAGE,
  })),
  ...[['projects', projects], ['exhibitions', exhibitions]].flatMap(([section, items]) =>
    items.map((item) => ({
      path: `/${section}/${item.slug}`,
      title: `${item.title} · VHILS`,
      heading: `${item.title} · VHILS`,
      description: summarise(item.description) || SITE_DESCRIPTION,
      image: item.hero?.src,
    })),
  ),
];

const expectedShells = new Set();
function emitShell(rel, html) {
  expectedShells.add(rel);
  emit(rel, html);
  stats.shells += 1;
}

emit('index.html', home);
emit('404.html', home); // unknown paths still boot the app, which renders its own not-found view
emit('robots.txt', ROBOTS_TXT);
emit('assets/mirror.css', MIRROR_CSS);
for (const route of routes) {
  const html = shell(route);
  emitShell(`${route.path.slice(1)}.html`, html);
  // A section that also exists as a directory needs an index so /section/ resolves too.
  if (OWNED_DIRS.includes(route.path.slice(1))) emitShell(`${route.path.slice(1)}/index.html`, html);
}

// Files that must not be published: shells of records that no longer exist, and FORBIDDEN_FILES.
function listHtml(dir) {
  if (!exists(dir)) return [];
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listHtml(`${dir}/${entry.name}`) : entry.name.endsWith('.html') ? [`${dir}/${entry.name}`] : [],
  );
}
const unwanted = [
  ...OWNED_DIRS.flatMap(listHtml).filter((rel) => !expectedShells.has(rel)),
  ...FORBIDDEN_FILES.filter(exists),
];
for (const rel of unwanted) {
  pending.push(`must not be published: ${rel}`);
  if (!CHECK) rmSync(join(ROOT, rel));
}

// ── 3. Report ───────────────────────────────────────────────────────────────

const label = CHECK ? 'check' : 'build';
console.log(
  `[${label}] ${projects.length} projects, ${exhibitions.length} exhibitions, ${stats.shells} route shells; ` +
  `${stats.strippedFields} internal fields, ${stats.cleanedCaptions} captions cleaned, ` +
  `${stats.droppedImages} unpublished gallery images, ${stats.repointedImages} repointed sources`,
);
for (const line of problems) console.error(`  ✗ ${line}`);
if (CHECK) for (const line of pending.slice(0, 20)) console.error(`  ✗ ${line}`);
if (CHECK && pending.length > 20) console.error(`  … and ${pending.length - 20} more`);

if (problems.length > 0 || (CHECK && pending.length > 0)) {
  console.error(`[${label}] FAILED — ${problems.length} problem(s)${CHECK ? `, ${pending.length} file(s) not up to date (run: node tools/build-mirror.mjs)` : ''}`);
  process.exit(1);
}
console.log(`[${label}] ok${CHECK ? '' : ` — ${pending.length} file(s) written`}`);
