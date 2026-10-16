# Cookbook: Add a built-in plugin feature preview

English | [中文](adding-a-plugin-preview.zh.md)

Plugin Manager owns optional feature illustrations for built-in bundles. Follow this guide when editing its internal `BUNDLE_PREVIEWS` map. Packages cannot declare illustrations through their manifest or exports; third-party plugins have no preview interface.

## 1. Decide whether an image helps

Show one concrete result or recognizable capability. Omit the map entry when the description is enough: no image is required, and omission reserves no space. Essential instructions stay in localized text or configuration outside the illustration.

## 2. Draw one fixed-size SVG

| Item | Requirement |
|---|---|
| Count | Zero or one logical feature image per bundle. English and Chinese files are alternatives for that image, not a gallery or carousel. |
| Format | SVG only: `width="640" height="300" viewBox="0 0 640 300"` (32:15). Raster preview files and other dimensions are unsupported. |
| Languages | Supply both `en` and `zh`. Translate headings, annotations, and example content; preserve official brand assets and names. No single strings, arrays, or extra languages. |
| Composition | One main example, optionally with one close-up. Keep important content about 32 canvas units from the edges. Review text at the page's actual size. |
| Typography | Outline lettering into paths using a suitable font. Match the feature and neighboring UI; do not rely on browser font substitution. |
| Theme | Compare light and dark themes. One illustration serves both; avoid transparent dark text that disappears on dark backgrounds. |

The SVG is self-contained: no fonts, remote resources, scripts, handlers, animation, stylesheets, `text`, or `foreignObject`. An `image` element may embed an unchanged official PNG/JPEG/WebP brand asset as a base64 data URL. Small plugin icons remain geometry-only. This exception preserves brand artwork and does not permit raster preview files. Validation checks the data-URL envelope, not decoded pixels; the page renders the SVG through `<img>`. Both raw language files together must stay within 1 MiB. They are embedded as base64 data URLs in the Plugin Manager client bundle, so keep them small.

## 3. Register the internal pair

Put `<feature>-preview.svg` and `<feature>-preview.zh.svg` under [Plugin Manager assets](../../packages/client/ui-plugin-manager/src/client/assets/). Import both into [PluginManagerPage.tsx](../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx), then add one exact built-in package name to `BUNDLE_PREVIEWS`:

```ts ignore-check
import examplePreview from './assets/example-preview.svg'
import examplePreviewZh from './assets/example-preview.zh.svg'

// One entry in the existing Map<string, Readonly<Record<'en' | 'zh', string>>>.
['@deepseek-ai/dsh-example-bundle', { en: examplePreview, zh: examplePreviewZh }]
```

Keep the map's required `en` and `zh` type. Do not add package metadata, a Host read method, exported preview resources, or a third-party declaration path. Use the [badge skill](../../packages/client/ui-plugin-manager/src/client/assets/badge-skill-preview.svg) and [voice input](../../packages/client/ui-plugin-manager/src/client/assets/voice-input-preview.svg) illustrations as examples. The voice transcript is explanatory sample content, not a recording result.

## 4. Keep the page contract

| Item | Current behavior |
|---|---|
| Position | Below the description and status notices, above components and source information; aligned with the description. |
| Spacing | 24 px above the image; 32 px before the following details section. |
| Display | One `<img>`, natural 640×300 canvas, at most the available width and 320 px high; proportional scaling. The page supplies border and 16 px corners. |
| Language | The current UI language selects one of the required files. Alternative text uses the localized plugin name. |
| Availability | Visible before activation. Decode failure shows a localized notice without blocking controls. Lists and component rows retain their small icons. |

## 5. Validate and review

Run `pnpm exec vitest run scripts/builtin-plugin-preview.spec.ts packages/client/ui-plugin-manager/tests/components.client.spec.tsx scripts/client-bundle-css.spec.ts`, then `pnpm run build`. The asset test checks every registered pair, fixed SVG dimensions, self-contained content, and combined size. Type checking requires both languages. These checks enforce format; visual quality and equivalent meaning in both languages still require review.

Open the real plugin details in English and Chinese before activation. Decode the image and confirm 640×300 natural dimensions, placement, light/dark readability, and no horizontal overflow at 390 px. Also check a built-in without artwork and a third-party plugin. Follow [record-browser-gif](../../.agents/skills/record-browser-gif/SKILL.md) for PR evidence; record from the final clean commit and label the demonstrated flow accurately.
