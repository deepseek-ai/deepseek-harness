---
name: office-render
description: Render requested document images or inspect visual layout with the office tool.
---

# Document images and visual inspection

Call the `office` tool with `operation: "render"`. Its result contains the page images for you to view; you do not save, read, or delete image files. The tool refuses when the current model cannot view images: then finish the applicable content and structure checks and report the requested visual check as unavailable. The tool returns images only for viewing. For a requested image export, explain that saving page images as files is not available and offer a PDF export. If the tool reports that LibreOffice Kit is unavailable, report that rendering is unavailable in this deployment; do not invoke system soffice, use npx, install a replacement renderer, or build an alternative rendering pipeline.

## Render the saved deliverable

Render the final saved file. For DOCX, PPTX, or PDF, pass the requested pages or slides as `pages` in one call; render all pages only for a requested whole-document review. For worksheets, pass the exact `sheet` and the affected `range`, including chart and drawing regions; worksheet numbers are not PDF page numbers. Reuse earlier images of an unchanged source, and render again only after source changes or for regions not yet rendered. Change print areas or scaling only when the user requests print layout.

Check clipping, alignment, headings, table widths, contrast, chart labels, and number formats as relevant to the task. Note fonts the result reports as substituted. A successful call alone does not establish a usable preview; guessed text geometry does not establish overflow.

## Failed or blank previews

For populated content, a fully transparent or uniformly blank image is a renderer failure. Stop visual checks for the task immediately after a blank result: do not render again, even after editing or copying the source, or try another range, page, sheet, DPI, output format, or print setting. Preserve the usable source and requested outputs and finish applicable content and data checks.

If content and structure checks pass, name the saved file and verified edits as needed, then include exactly one visual-status sentence: "Content and structure checks passed; visual inspection was not completed." in English, or "内容与结构检查通过；视觉检查未完成。" in Chinese. Do not add a render or preview bullet, explain why inspection stopped, or describe the image or pixels. Report content or structure failures separately; never say all checks passed or claim visual verification.

LibreOffice output can differ from Word, PowerPoint, or Excel. Images do not certify animation or media playback, refresh formula caches in the source workbook, or guarantee native application fidelity. Deliver requested files through `present` when available; keep the files in place.
