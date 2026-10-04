# Bundles and Host plugins

A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch inserts plugin entries. Give the package and rows unique names; use the Loader's existing YAML syntax, including `!!js` where expressions are needed. Read an existing patch before editing it: a matching override replaces the complete `config`.

## Manifest

A Host-only bundle needs no dependencies, install scripts, or build tool:

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

## Display metadata and icon

Plugin Manager and Settings read `meta.title` and `meta.description` from exported locale JSON and an icon from exported resources without activating plugins. Complete this checklist before installation:

- Write a recognizable title and a description of the capability in `locale/en.json` under `meta.title` and `meta.description`. Add the same fields for the user's language and other supported locales, such as `locale/zh.json`; do not leave template copy unrelated to the delivered plugin.
- Create an original icon or use artwork whose license permits redistribution, retaining any required attribution.
- Export `./locale/*.json` and `./icon`; retain existing runtime exports. Keep the patch, locales, icon, and every runtime file in `files`, updating it whenever you add modules or assets. For a packed or published bundle, verify the actual packed file list. Local directory installation links the checkout instead, so check the files directly; `files` does not filter a linked directory.
- Check that the icon is a valid image of the declared format and satisfies the path and size limits below. An accepted filename alone does not establish that its bytes render.

For example, the locale file contains:

```json
{ "meta": { "title": "My Decoration", "description": "Draws a badge under the composer." } }
```

```json
{
  "exports": { "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]
}
```

A package-root plugin may instead declare a top-level `icon` in `package.json`; it takes priority over `./icon` and is a path relative to the manifest directory. A subpath plugin such as `my-plugins/search` is not a package and never reads a `package.json`; it exports `./search/locale/*.json` and `./search/icon` instead. Icons may be SVG, PNG, JPEG, or WebP up to 256 KiB and must stay inside the package; absolute paths, URLs, and symlinks leaving it are rejected. Missing fields of a package-root plugin fall back to `package.json` `name` and `description`, and missing images use the panel's default artwork; malformed metadata produces a diagnostic and keeps the valid text.

After installation, verify the intended title and description in bundle details and plugin rows, plus the rendered icons, in English and the user's locale where supplied. Check for metadata diagnostics and unintended fallbacks, and that each plugin row shows its own exported icon or, when it has none, the generic artwork. Without browser control, inspect the installed resources and report that rendered display remains unverified; do not claim visual success from installation alone.

An existing plugin's metadata may remain unchanged when it still describes the requested result. A disposable test fixture or an explicitly requested metadata-free package may omit resources, but explain each omission in the delivery report. A Host-only or configuration-only bundle still has a visible inventory entry; neither is an exception by itself.

## Host plugin export forms

`index.js` exports one of these forms; do not mix them:

- `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
- A service class as the default export.

Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.

## Install, enable, and observe

`plugin_manager` `install_bundle` performs package installation and bundle selection; do not reproduce those steps with shell commands. Only pass `approvedBuilds` after the user explicitly approves the reported pending build scripts. Preserve returned failures and pending states; report success only after observing the requested capability.

`list_plugins` and `list_bundles` return exact identifiers for existing installations. `set_plugin` and `set_bundle` toggle them; `remove_bundle` removes a bundle. Inspect saved-state and activation outcomes separately: `failed` requires diagnosis, `overridden` means a higher-priority layer wins, and `restart-required` means the change is not live. Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation. Do not infer updated browser code from an unchanged slot id.
