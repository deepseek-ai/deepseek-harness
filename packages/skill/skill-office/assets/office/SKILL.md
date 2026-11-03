---
name: office
description: Create or edit Office files; inspect Office files and PDFs. Load before rendering, conversion, or recalculation to enable office_render, office_convert, and office_recalculate next step.
---

# Office task routing

To create, read, or edit, load `office-docx`, `office-pptx`, or `office-xlsx`. Operations alone skip format skills.

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

- Images, visual checks, or appearance edits: `office_render`, even unrequested.
- Recalculate formulas: `office_recalculate`, `format: "xlsx"` or `"ods"`.
- Convert: `office_convert` with `format`. For PDF export alone, copy the file, check it is nonempty and starts with `%PDF-`, then deliver it without rendering.

Copy temporary files to the destination; never overwrite existing files unless asked. Skip rendering when asked. New files, content, formulas, and incidental formatting need no render unless requested. Otherwise reuse loaded skills.
