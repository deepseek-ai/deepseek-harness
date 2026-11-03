---
name: office
description: Create or edit Office files; inspect Office files and PDFs. Load before rendering, conversion, or recalculation to enable office_render, office_convert, and office_recalculate next step.
---

# Office task routing

To create, read, or edit, load `office-docx`, `office-pptx`, or `office-xlsx`. Standalone operations skip format skills.

If `office_render`, `office_convert`, or `office_recalculate` is unavailable, call `skill` to load `office`; the tools appear next step.

- Images, visual inspection, or appearance edits: `office_render`, even without a separate render request.
- Recalculate formulas: `office_recalculate`, `format: "xlsx"` or `"ods"`.
- Convert: `office_convert` with `format`. For PDF, check the copy is nonempty and starts with `%PDF-`; PDF export alone stops there.

Copy temporary files to the destination. Honor requests to skip rendering. New files, content, formulas, and incidental formatting need no render unless requested. Otherwise reuse loaded skills.
