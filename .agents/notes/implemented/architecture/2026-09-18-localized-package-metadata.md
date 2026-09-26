# Agent Note: Plugin-owned localized display metadata

Status: implemented

English | [中文](2026-09-18-localized-package-metadata.zh.md)

## Problem

Plugin Manager needs readable titles and descriptions for installed bundles and individual plugins, including disabled plugins. One npm package can export several plugins with different purposes; a package-level introduction cannot describe each one. Registering introductions only during activation also leaves disabled or failed plugins without display text.

## Decision

Each plugin supplies optional `meta.title` and `meta.description` strings in its `locale/<language>.json` resources, starting with `locale/en.json`. These strings directly provide its display title and description. Other top-level locale content belongs to its existing consumers and is not included in metadata responses.

```json
{
  "meta": {
    "title": "File Search",
    "description": "Search files in your workspace."
  }
}
```

The configured Cordis plugin name owns the resource address. Node module resolution selects files through the applicable profile and package exports without evaluating plugin code:

| Plugin form | Locale resource |
|---|---|
| npm package `my-plugins` | `my-plugins/locale/en.json`, exposed by `./locale/*.json` |
| npm subpath `my-plugins/search` | `my-plugins/search/locale/en.json`, exposed by `./search/locale/*.json` |
| JavaScript path `./plugins/search.js` | No sibling-resource lookup; the configured path is the final title fallback |

Locale addresses are not derived from a resolved JavaScript filename or an owning package directory. File paths and file URLs, including Windows drive and UNC paths, skip resource resolution and return no metadata; a file address alone is not a metadata error. They supply neither sibling locale metadata nor a neighboring package manifest. The [package cookbook](../../../../docs/cookbook/adding-a-package.md#plugin-display-metadata) owns directory examples, export declarations, publication entries, and author verification.

Language files for one plugin share a directory. The Host resolves `en.json`, discovers language filenames in that directory, and resolves each resource using the same plugin specifier and parent URL. The English resource anchors discovery, but any language may omit either display field. Language identifiers are case-insensitive and duplicates are rejected. Present locale display fields must be non-empty strings.

The Host reads installed bundles and their declared plugin rows without importing or activating them. Remotes carry multilingual values or literal fallback text for the two display fields. The Client reuses its existing language selection and fallback chain at render time, without adding language registration, plugin-specific language defaults, or another language fallback policy.

Each field falls back independently before view-specific name formatting:

| Field | Existing locale fallback chain | Same-address package fallback | Final fallback |
|---|---|---|---|
| Title | `meta.title` | Non-empty `name` from `<plugin specifier>/package.json` | Complete configured Cordis plugin name |
| Description | `meta.description` | Non-empty `description` from `<plugin specifier>/package.json` | No package description |

The package fallback obeys resource exports and belongs to the same plugin address; a subpath does not inherit its owning package's introduction. The Host supplies the package or final value as the English fallback for a field that has translations but no English value, preserving the existing Client locale API. Missing or unexported resources and missing fields use these fallbacks; invalid locale fields or malformed files report a diagnostic instead of silently falling back, while retaining management operations.

Plugin Manager uses this metadata on installed bundle cards and details, component lists, and component configuration details, preserving complete technical-name fallbacks. Settings uses it in the plugin inventory, including preset plugins, but shortens literal package-name and module-name fallbacks by removing their npm scope and Cordis/DSH prefixes. Translated titles remain verbatim in both views; full module names, entry ids, search identities, and operation targets stay unchanged. The [Settings inventory README](../../../../packages/client/ui-settings-plugin-inventory/README.md#use-this-package) owns the prefix rules.

A row configuration page uses its registered `summary` view only when the plugin has no display description. The bundle's raw `description` field remains available to Host and model consumers; it is not an additional UI fallback around resource exports. These rules preserve one displayed description while keeping configuration summaries available for plugins without one.

Disabled plugins remain readable without activation. The Install view still uses registry information from `pnpm view`; it does not replace that information with locale metadata. Registry, Git, and tarball inspection before installation does not read remote package contents for translation. Model tool results retain their existing package information and exclude multilingual UI dictionaries. Session events remain unchanged.

Built-in bundle introductions live in their exported language files. Beta markers, page grouping, configuration slot ownership, and enablement targets remain unchanged. Plugin introductions and component interaction copy retain separate owners.

## Existing decisions

[Public package declarations](../../implemented/architecture/2026-09-10-public-package-manifest.md) still govern manifest type and reader responsibilities; [locale-owned UI copy](../../implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md) still governs component wording and display identity; [plugin configuration pages](../../implemented/architecture/2026-09-16-plugin-configuration-on-the-plugins-page.md) still determine configuration slot ownership. Plugin metadata extends display data without replacing those decisions.

## Alternatives considered

**Keep built-in package dictionaries in Plugin Manager.** Every package addition requires changing the manager, and external plugins cannot independently supply translations.

**Declare references in package.json.** This duplicates the declaration between a manifest and locale files, and one package-level declaration cannot distinguish its exported plugins.

**Read locale beside the resolved JavaScript file.** Build tools can put several plugin entries in the same directory. Resource exports preserve each plugin's identity independently of its compiled layout.

**Register copy when the displayed plugin activates.** Disabled packages, packages without a Client half, and packages that fail to load still need readable introductions.

**Add base.json or package-specific fallback.** This introduces a second policy alongside the existing English fallback and extension-language fallback chains.

**Download remote packages for pre-installation previews.** This expands lookup cost and the package contents that must be handled; this phase only reads files already present locally.

## Verification

- Bundles, child plugins, and read-only inventory display local metadata; disabled packages need no activation for reading.
- Language switching updates titles and descriptions; Settings shortens only literal technical-name fallbacks, not translated titles, and keeps module identities and operation targets intact.
- Direct metadata, unrelated locale content, absent resources, malformed JSON, missing display fields, and conflicting language identifiers have focused coverage.
- Separate exports in one package and same-named packages under different parents retain independent metadata without executing plugin entries.
- Windows drive paths, UNC paths, relative and absolute file paths, and file URLs return no metadata without invoking resource resolution.
- Missing locale resources and individual fields fall back independently to address-local package fields, then the complete module specifier without a description.
- Publication checks require readable resource exports and included language files, without duplicate ownership of built-in copy in the manager and plugins.
- Management tools preserve existing model output, and pre-installation inspection adds no package-content lookup.
- Focused tests and the complete `pnpm run build` succeed.

## Consequences

Omitted language files or exports can make metadata unavailable after publication, so verification covers both resolution and packaged files. Metadata errors remain per-plugin diagnostics without removing the manager's repair controls; file diagnostics retain their absolute paths. Display metadata is read per request without a metadata cache. Lookup retains the complete module specifier and its resolution parent; package-name-only caching cannot distinguish exported plugins or different installations.
