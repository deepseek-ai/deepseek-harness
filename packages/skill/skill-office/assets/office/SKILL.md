---
name: office
description: Create, read, edit, and validate Word, PowerPoint, and Excel files; render Office files and PDFs; convert or recalculate. Load first to enable office_render, office_convert, and office_recalculate.
---

# Office tasks

To create, read, or edit a file, first use the `read` tool, not shell commands, to read its format file: `docx.md` for Word, `pptx.md` for PowerPoint, or `xlsx.md` for Excel. Rendering, conversion, or recalculation alone needs no format file.

Bundled Python includes `pypdf` for existing PDFs.

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

- `office_render`: Office or PDF images, visual checks, and appearance or slide checks required by the format file; skip it when asked.
- `office_recalculate`: formulas, with `format: "xlsx"` or `"ods"`.
- `office_convert` with `format`; Office inputs only, not PDFs. For PDF export alone, check the copy is nonempty and starts with `%PDF-`, then deliver it without rendering.

Copy outputs to the destination; keep existing files unless asked to replace them. Reuse loaded skills and files already read.
