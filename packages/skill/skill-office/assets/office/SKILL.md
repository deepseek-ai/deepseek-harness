---
name: office
description: Create or edit Office files; inspect Office files and PDFs. Load before rendering, conversion, or recalculation to enable office_render, office_convert, and office_recalculate next step.
---

# Office task routing

Load `office-docx`, `office-pptx`, or `office-xlsx` to create, read, or edit, or `office-pdf` for PDF inputs; operations alone need no format skill.

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

- `office_render`: Office or PDF images, visual checks, and appearance or slide checks required by the format skill; skip when asked.
- `office_recalculate`: formulas, with `format: "xlsx"` or `"ods"`.
- `office_convert` with `format`; Office inputs only, not PDFs. PDF export alone: check the copy starts with `%PDF-`, then deliver it without rendering or `office-pdf`.

Copy temporary outputs to the destination; keep existing files unless told to replace them.
