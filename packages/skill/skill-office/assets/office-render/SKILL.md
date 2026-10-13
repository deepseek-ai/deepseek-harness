---
name: office-render
description: Render requested document images or inspect visual layout with LibreOffice Kit.
---

# Document images and visual inspection

Use the installed LibreOffice Kit CLI through the shell with the absolute Node and CLI paths supplied below. In Bash, invoke `"<node>" "<cli>"`; in PowerShell, invoke `& "<node>" "<cli>"`. Prefer bundled LibreOffice unless the user requests another installation. If the Office sidecar is missing, follow [sidecar setup](../office/references/sidecar.md): ask whether the user wants to download it and install only after they agree. Do not invoke system soffice, use npx, install a replacement renderer, or build an alternative rendering pipeline to work around a failed render with an installed sidecar.

Before generating images only for inspection, establish that the current model accepts images. Otherwise finish the applicable content and structure checks and report the requested visual check as unavailable. Do not generate unreadable previews, retry image reads, or choose a second model. Requested image exports can still be delivered.

## Render the saved deliverable

Keep the saved deliverable in the task workspace. For requested image exports, use the requested output directory and retain the images. For inspection-only previews, create a private, uniquely named temporary parent inside that workspace and pass a child path that does not yet exist as `--output-dir`; the CLI creates that child. On POSIX, use `preview_root=$(mktemp -d "./.dsh-office.XXXXXXXX")` (owner-only permissions) and `--output-dir "$preview_root/render"`. On PowerShell, create a parent named `.dsh-office-` plus `[guid]::NewGuid().ToString('N')` under the task workspace and pass an uncreated `render` child; it inherits the workspace ACL. Quote each input and output path. Retain the parent until image inspection finishes, then remove only that parent, including after a failed render. Never use a fixed directory name or remove the workspace itself.

```text
"<node>" "<cli>" render --input <final-file> --output-dir <new-directory> --pages "1,3,4"
"<node>" "<cli>" render --input <final-workbook.xlsx> --output-dir <new-directory> --sheet <exact-name> --range <A1-range>
```

For DOCX, PPTX, or PDF, batch requested pages/slides in one call. In PowerShell, quote comma-separated `--pages` values so they remain one argument. Inspect all pages only for a requested whole-document review. For worksheets, choose the exact affected range, including chart/drawing regions; worksheet numbers are not PDF page numbers. Inspect the final saved file, reuse existing images for an unchanged source, and rerender only after requested source changes or for previously unrendered regions. Change print areas or scaling only when the user requests print layout.

Read the returned JSON manifest for image paths, page counts, fragment rectangles, and missing-font diagnostics. Use the session's image-reading tool to inspect the requested images. Check clipping, alignment, headings, table widths, contrast, chart labels, and number formats as relevant to the task. A successful command or image read alone does not establish a usable preview; guessed text geometry does not establish overflow.

## Failed or blank previews

For populated content, a fully transparent or uniformly blank image is a renderer failure. If a pixel check is needed, composite RGBA onto white first; raw RGB under transparent pixels can look nonblank. Check once and do not reread the same image. Stop visual checks for the task immediately after a blank result. This overrides the rerender-after-edit guidance above: do not render or read images again, even after editing or copying the source, or try another range, page, sheet, DPI, output format, diagnostic export, or print setting. Preserve the usable source and requested outputs and finish applicable content/data checks.

If content and structure checks pass, name the saved file and verified edits as needed, then include exactly one visual-status sentence: "Content and structure checks passed; visual inspection was not completed." in English, or "内容与结构检查通过；视觉检查未完成。" in Chinese. Do not add a render or preview bullet, explain why inspection stopped, or describe the image or pixels. Report content or structure failures separately; never say all checks passed or claim visual verification.

LibreOffice output can differ from Word, PowerPoint, or Excel. Images do not certify animation/media playback, refresh formula caches in the source workbook, or guarantee native application fidelity. Deliver requested files through `present` when available; keep the files in place. Do not deliver inspection images or reports unless requested.
