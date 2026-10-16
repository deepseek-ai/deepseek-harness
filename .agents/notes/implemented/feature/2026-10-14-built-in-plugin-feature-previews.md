# Agent Note: Built-in plugin feature previews

Status: implemented

English | [中文](2026-10-14-built-in-plugin-feature-previews.zh.md)

## Problem

A one-line plugin description does not always show what a plugin produces. Users deciding whether to enable an official bundle benefit from a picture of its result, such as a document ending with the badge that the DSH badge skill adds. A picture of this kind needs an owner, a localization rule, and a delivery path to the Client.

## Decision

In this note, built-in plugins are the official bundles that ship with DSH. Plugin Manager owns every feature preview of these bundles. [PluginManagerPage.tsx](../../../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) maps package names to `{ en, zh }` images, in the same file and with the same hardcoding that defines its optional bundle lists. The images live under `packages/client/ui-plugin-manager/src/client/assets/`. The shared [client tsdown preset](../../../../packages/client/tsdown.client.ts) embeds them in the Plugin Manager client bundle as data URLs. The bundle details page shows the image for the UI language below the description and status notices, whether or not the bundle is enabled.

Every built-in feature preview is an entry in this map. Packages cannot declare a preview, so the map is not a plugin-author interface and can change without a compatibility path.

## Alternatives considered

**A `preview` field in the package manifest.** Declaring `preview` in `DshPackageManifest` and `PluginLocalizedMeta`, read through app-boot package metadata and checked by the publication and catalog gates, makes image paths, the language map, size limits, and design rules a public contract for every plugin author before any third-party plugin needs one. One official bundle has artwork, which does not justify a public format.

**Keeping the images in each bundle package and fetching them from the Host.** This keeps artwork beside its feature, but it still requires a Host read path and a resource interface between bundles and Plugin Manager.

## Consequences

Built-in feature previews need no metadata reader, manifest validation, publication rule, or catalog field. Adding one means adding an image and a map entry in Plugin Manager. Each preview adds its encoded size to the Plugin Manager client bundle; the badge skill images add about 207 KB.

Third-party plugins cannot show a preview or other introduction before they are enabled; a bundle's own `plugins.bundle.config` content appears only while its Client half is loaded. The long-term plan is a way for third-party plugins to present their README in Plugin Manager. That design will define its own format and trust rules, and built-in feature previews may move to it then.
