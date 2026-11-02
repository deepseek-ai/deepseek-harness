---
name: office
description: Create, edit, inspect, or convert Office documents, spreadsheets, presentations, and PDFs. Load to choose the relevant workflow.
---

# Office task routing

To create, read, or edit Office files, load the format skill: `office-docx`, `office-pptx`, or `office-xlsx`. Standalone operations skip format skills and call the `office` tool:

- Images, visual inspection, or tasks mainly about layout, spacing, sizing, or alignment: `operation: "render"`, even when not requested.
- Recalculate formulas: `operation: "recalculate"`, `format: "xlsx"` or `"ods"`.
- Export to PDF: `operation: "convert"`, `format: "pdf"`; check the copy is nonempty and starts with `%PDF-`. For PDF export alone, stop after this check.

Copy returned temporary files to the destination. Honor requests to skip rendering. New files, content edits, formulas, and incidental formatting such as bold headers need no render unless requested. Do not reload skills.
