---
name: office
description: Create or edit Office files; inspect Office files and PDFs. Load before rendering, conversion, or recalculation to enable office_render, office_convert, and office_recalculate next step.
---

# Office task routing

Load `office-docx`, `office-pptx`, or `office-xlsx` to create, read, or edit; operations alone need no format skill.

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

- `office_render`: images of Office or PDF pages, visual checks, appearance edits, and new or changed slide content, even unrequested; skip it when asked.
- `office_recalculate`: formulas, with `format: "xlsx"` or `"ods"`.
- `office_convert` with `format`; Office inputs only, not PDFs. For PDF export alone, check the copy is nonempty and starts with `%PDF-`, then deliver it without rendering.

Copy temporary outputs to the destination, keeping existing files unless asked to replace them. Reuse loaded skills.
