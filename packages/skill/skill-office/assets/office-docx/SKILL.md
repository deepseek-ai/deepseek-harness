---
name: office-docx
description: Create, read, edit, and validate Word documents (.docx).
---

# Word documents

Use `python-docx` for DOCX creation and ordinary edits unless an explicit user or applicable AGENTS.md requirement names another library. Run Python as described in the Python environment section below.

Keep scripts, intermediate files, and final documents in the workspace; runtime and skill resources are read-only. Use the requested language and preserve the document's design unless a redesign is requested.

Name Python scripts for their task, such as `edit_docx.py`; avoid module names such as `inspect.py`, `docx.py`, or `zipfile.py` that shadow imported libraries.

## Create and edit

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

python-docx cannot read legacy `.doc` files. Use `office_convert` with `format: "docx"`, copy the result into the workspace, then edit the copy.

For text edits, locate the target by its text or position and inspect only its runs and formatting. A title can be an ordinary paragraph without a Title style or document-property title. Update the relevant runs; assigning paragraph `.text` destroys run formatting. Save a new file unless an in-place edit is requested. For ordinary text edits, do not unzip the document, enumerate ZIP members, dump raw XML, or inspect core properties, headers, or footers unrelated to the target. Investigate these only for a concrete failure, an ambiguous target, an unsupported feature, or an explicit user requirement. Rebuilding a document can lose unsupported features.

Use paragraph styles for headings and body text. Size tables for the section that contains them, and account for merged cells and nested tables. Chinese, Japanese, and Korean text may need an explicit `w:eastAsia` font assignment in addition to `run.font.name`; font names alone do not establish glyph availability or rendered appearance.

For a new document, use the selected Python executable:

```python
from docx import Document

document = Document()
document.add_heading("Project report", level=0)
document.add_paragraph("Summary", style="Heading 1")
document.add_paragraph("The requested findings go here.")
document.save("report.docx")
```

python-docx does not paginate or render documents. Do not represent ordinary replacement, colored text, or comments as tracked changes. When real revisions or unsupported OOXML features matter, preserve their package parts and verify the requested operation rather than silently discarding them. When writing package parts directly, create a new ZIP and copy each unchanged member once; appending a replacement member duplicates its name and corrupts the package.

## Check and deliver

Reopen the saved document with python-docx and verify the requested content, related formatting, and unchanged content that must be preserved. These checks complete routine validation; deliver the file once they pass. ZIP integrity, package inventories, and metadata matter only for a concrete failure.

Call `office_render` on the changed page when the user asks for images or visual inspection, or when styling, font color, spacing, sizing, or text alignment is the requested edit; a request to skip rendering takes precedence. New documents and content edits, with incidental basic formatting, are checked with python-docx alone. For PDF output, call `office_convert` with `format: "pdf"`, then copy the returned temporary file to the destination.

A fully transparent or uniformly blank image of populated content means the renderer failed, which ends visual checks for the task and leaves the source as it is. When content and structure checks pass, state the visual status only as "Content and structure checks passed; visual inspection was not completed." or "内容与结构检查通过；视觉检查未完成。".

Call `present({"files":[{"path":"report.docx"}]})` with the actual final DOCX path. It exposes the current file without copying or preserving its bytes; keep it in place and omit temporary QA reports unless requested. If `present` is unavailable, deliver the final workspace path with the session's supported method.
