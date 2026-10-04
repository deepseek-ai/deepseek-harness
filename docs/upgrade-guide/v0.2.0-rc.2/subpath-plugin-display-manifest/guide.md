---
kind: upgrade-guide
description: "Subpath plugins no longer read display text or icons from an exported <subpath>/package.json; they use locale meta and <subpath>/icon."
---

# Subpath plugins read `<subpath>/icon` instead of `<subpath>/package.json`

English | [中文](guide.zh.md)

## Change

In v0.2.0-rc.2, Plugin Manager and Settings read a subpath plugin such as `my-plugins/search` through `my-plugins/search/package.json` when the package exported it: `name` and `description` filled missing locale fields, and `icon` supplied the row image. A subpath is not a package, so the next release never reads a `package.json` for it. Its title and description come only from `my-plugins/search/locale/*.json`, and its image comes from the exported `my-plugins/search/icon` resource. Package-root plugins keep their `package.json` text and `icon`; when `icon` is omitted, an exported `./icon` supplies the image. Authors of packages that export subpath `package.json` files are affected.

## Migration

1. Move the subpath manifest's `name` and `description` into `meta.title` and `meta.description` of the subpath locale files, and export them, for example `"./search/locale/*.json": "./locale/search/*.json"`.
2. Replace the subpath manifest's `icon` with an icon export and publish its target:

   ```json
   {
     "exports": { "./search/icon": "./assets/search.svg" },
     "files": ["assets/search.svg"]
   }
   ```

3. Remove the `./search/package.json` export and its file.
4. Run `pnpm run verify-package-meta` in a DSH checkout, or open Plugin Manager, and confirm the subpath row shows its title, description, and image.
