# Static preview mirror

This repository holds a **built copy** of a site, served as-is by GitHub Pages.
It is a preview mirror: it is marked `noindex` and is not the official site.
Nothing here is edited by hand — the source lives elsewhere and is built into this tree.

## Publishing a new build

After copying a fresh build into this tree, run the last step and commit the result:

```sh
node tools/build-mirror.mjs          # sanitise data, write route shells
node tools/build-mirror.mjs --check  # what CI runs; must exit 0
```

`tools/build-mirror.mjs` has no dependencies and can equally run against any build
output directory before it is deployed anywhere:

```sh
node tools/build-mirror.mjs --root path/to/dist --origin https://example.org
```

## What the step guarantees

- **No working notes in public data.** Editorial and provenance fields are removed from
  `data/*.json`, clearance notes and source tags are removed from captions, and the build
  fails if note-like text is still present anywhere.
- **No dead image references.** Images that are not part of the build are dropped from
  the data instead of rendering as broken tiles.
- **Deep links work.** Every route has its own HTML shell, so links answer `200` and
  unfurl with the right title, description and image.
- **Preview stays a preview.** Pages are `noindex`, there is no sitemap, and a
  Content-Security-Policy restricts the page to same-origin resources.

A file that the app needs and this step does not know about is left untouched.
