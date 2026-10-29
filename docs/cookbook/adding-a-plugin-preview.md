# Cookbook: Add a plugin feature preview

English | [中文](adding-a-plugin-preview.zh.md)

A feature preview is an optional illustration in a bundle's detail document, the document that its page in **Plugins** shows below the description. Follow this guide when drawing one for an official bundle. The detail document itself is declared through [`meta.detail`](adding-a-package.md#plugin-display-metadata).

## 1. Decide whether an image helps

Show one concrete result or recognizable capability. Omit the image when the description is enough: no image is required. Essential instructions stay in the bundle's description or in configuration outside the illustration.

## 2. Draw one fixed-size SVG

| Item | Requirement |
|---|---|
| Count | Zero or one feature image per bundle. English and Chinese files are alternatives for that image, not a gallery or carousel. |
| Format | SVG: `width="640" height="300" viewBox="0 0 640 300"` (32:15). |
| Languages | Supply both an English and a Chinese file. Translate headings, annotations, and example content; preserve official brand assets and names. |
| Composition | One main example, optionally with one close-up. Keep important content about 32 canvas units from the edges. Review text at the page's actual size. |
| Typography | Outline lettering into paths using a suitable font. Match the feature and neighboring UI; do not rely on browser font substitution. |
| Theme | Compare light and dark themes. One illustration serves both; avoid transparent dark text that disappears on dark backgrounds. |

The SVG is self-contained: no fonts, remote resources, scripts, handlers, animation, stylesheets, `text`, or `foreignObject`. An `image` element may embed an unchanged official PNG/JPEG/WebP brand asset as a base64 data URL. Small plugin icons remain geometry-only. The page renders the SVG through `<img>`. Keep each file small; the Host refuses images above plugin-manager's `detailImageMaxBytes`, 5 MiB by default.

## 3. Make it the detail document

Save the pair as `docs/preview.svg` and `docs/preview.zh.svg` in the bundle package, beside `docs/DETAIL.md` and `docs/DETAIL.zh.md`, and make the image the only line of each document:

```markdown
![Example feature preview](preview.svg)
```

The Chinese document references `preview.zh.svg` with Chinese alternative text. Use the [badge skill](../../packages/experimental/badge-skill-bundle/docs/DETAIL.md) and [voice input](../../packages/experimental/voice-input-bundle/docs/DETAIL.md) documents as examples. The voice transcript is explanatory sample content, not a recording result. Describe what the bundle does and how to use it, at the level of behavior, in `meta.description`, which the page shows above the image.

## 4. Page behavior

| Item | Current behavior |
|---|---|
| Position | First in the detail document, which is the first section of the bundle page, below the description and status notices. |
| Display | The detail document renders the image at most its own width, inside its height-bounded scroll area. |
| Language | The document for the UI language references its own file. |
| Availability | Visible before activation. Lists and component rows keep their small icons. |

## 5. Validate and review

`scripts/plugin-preview-assets.spec.ts` checks every preview pair in a bundle's `docs` directory: the fixed canvas, absent scripts, stylesheets, text elements, and external references, the 1 MiB pair limit, and English and Chinese files that differ. Then open the real plugin details in English and Chinese before activation and confirm the image loads, its placement, light/dark readability, and no horizontal overflow at 390 px; review owns visual quality and equivalent meaning in both languages. Follow [record-browser-gif](../../.agents/skills/record-browser-gif/SKILL.md) for PR evidence; record from the final clean commit and label the demonstrated flow accurately.
