# Plugin details

Use the bundle's `meta.description` to explain what the plugin does and how to use it, including where to find or trigger it with exact UI labels. Keep essential instructions and limitations there or in the plugin's configuration: added model requests, data read or sent elsewhere, risks, and what changes when the plugin is turned off. For bundles delivered with this skill, declare `meta.detail` only for a document containing one feature image. When the description is enough, omit `meta.detail` and accept the package README fallback; a preview is optional for UI, Host-only, and configuration-only bundles alike.

The templates include a single-image detail document and a text-free example SVG. Adapt the illustration and alternative text to the delivered feature; keep functionality and usage in `meta.description`. When omitting the preview, remove the template's `meta.detail` from every locale and remove unused detail files and their `files` entry.

## Declare the document

Set `meta.detail` in `locale/en.json` to `"docs/DETAIL.md"`, and supply a document in the user's language when it differs from English. For example, Japanese uses `"docs/DETAIL.ja.md"` in `locale/ja.json`; Chinese uses `"docs/DETAIL.zh.md"` in `locale/zh.json`. Update any template value that points to English. Preserve localized `meta.title` and `meta.description`, adding them when creating a locale file.

Each path is relative to the package root, uses `/`, stays inside the package, and ends in `.md` or `.markdown`. Use `docs/` to publish the document and its images together; a subdirectory is a packaging convention, not a runtime path restriction. Other locales may omit `meta.detail` and fall back through the language chain to English, or explicitly point to the English document. The page uses the package README only when no locale in that chain declares a detail document.

Keep each image beside its document. Make `docs/DETAIL.md` exactly one image line with meaningful alternative text, adapted to the feature:

```markdown
![Feature result](preview.svg)
```

The user's localized document references its corresponding image, such as `preview.ja.svg` or `preview.zh.svg`, with localized alternative text. Put functionality and usage in `meta.description`, not headings, repeated descriptions, or installation instructions beneath the image. Use zero or one feature image per bundle; language variants are alternatives, not a gallery or carousel.

Include `"docs"` in the manifest's `files` array, preserving runtime files, the patch, and the icon; array order does not affect npm packaging. Include every declared document and its image. No `./detail` export is needed. For a published bundle, inspect the packed file list; for a linked local bundle, check the files directly. A declared document must exist: a missing file is an error, not a README fallback.

## Compose the image

Use a self-contained SVG with `width="640" height="300" viewBox="0 0 640 300"`. Show one main example, optionally with one close-up, and keep important content about 32 canvas units from the edges. Match the actual feature and preserve any assets it produces. Do not build mock pages or screenshot tooling before the plugin works; use the installed feature as the first preview.

Supply English and user-language variants when the preview has localized content; text-free illustrations may share one SVG across localized detail documents. An English-speaking user needs only English. Translate annotations and example content while preserving official names and brand assets. If the image has lettering, outline it into paths using an available suitable font. When that is impractical, use an illustration without text or omit the preview; do not build font-conversion tooling or hand-draw glyphs just for it. Avoid fonts, remote resources, scripts, event handlers, animation, stylesheets, `text`, and `foreignObject`; an `image` element may embed an unchanged, redistribution-permitted brand asset as a base64 PNG/JPEG/WebP data URL. Aim for at most 1 MiB across the variants as a size recommendation. The Host enforces `pluginManager.detailImageMaxBytes` per image (5 MiB by default). The same illustration must remain readable in light and dark themes.

## Verify the detail page

Open the installed bundle's details in English and the user's language. Confirm that the description explains the capability, the correct image loads below it, and no unintended English or README fallback or metadata diagnostic appears when a localized `meta.detail` is declared. Check text at its displayed size, light and dark themes, and no horizontal overflow at 390 px. The document is available without enabling the bundle; keep the user's activation state unchanged. Without browser control, check the declared paths, packaged resources, and image contents, then report that rendered details remain unverified, following `references/verification.md`.
