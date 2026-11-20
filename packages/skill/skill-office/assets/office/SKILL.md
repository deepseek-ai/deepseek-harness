---
name: office
description: Create, read, edit, and validate Word, PowerPoint, and Excel files; render Office files and PDFs; convert or recalculate. Load first to enable office_render, office_convert, and office_recalculate.
---

# Office tasks

`office_render`, `office_convert`, and `office_recalculate` become available on the next step; if one is missing later, load `office` again. Bundled Python includes `pypdf` for existing PDFs.

- python-docx, python-pptx, and openpyxl cannot open legacy `.doc`, `.ppt`, or `.xls` files; convert them with `office_convert` first.
- Word: change text inside runs; assigning `paragraph.text` drops the paragraph's run formatting. Chinese, Japanese, and Korean text needs a `w:eastAsia` font in addition to `run.font.name`.
- PowerPoint: python-pptx cannot measure whether text fits its box; render changed slides to check overflow and overlap.
- Excel: openpyxl writes formulas without calculated values; use `office_recalculate` when results must show. Writing a pandas DataFrame over an existing workbook drops its other sheets, formulas, and formatting.

Keep the original file unless the user asks to replace it.
