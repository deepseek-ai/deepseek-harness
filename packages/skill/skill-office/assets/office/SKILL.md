---
name: office
description: Create, edit, inspect, or convert Office documents, spreadsheets, presentations, and PDFs. Load to choose the relevant workflow.
---

# Office task routing

Before creating, reading, or editing Office files, load the format skill with `skill`: `office-docx` (Word), `office-pptx` (PowerPoint), or `office-xlsx` (Excel). Call the `office` tool for operations; standalone ones skip format skills:

- Images, visual inspection, or tasks mainly about layout, spacing, sizing, or alignment: `operation: "render"`, even without a visual-check request.
- Recalculate formulas: `operation: "recalculate"`, `format: "xlsx"` or `"ods"`.
- Export to PDF: `operation: "convert"`, `format: "pdf"`.

Copy returned temporary files to the destination. Honor requests to skip rendering. New files, content edits, formulas, and incidental formatting such as bold headers need no render unless visual inspection is requested. Do not reload skills.
