---
name: office-pdf
description: Read, extract, inspect, split, merge, protect, or fill an existing PDF; PDF to Word (.pdf).
---

# PDF files

Use `pypdf` for text, metadata, pages, protection, and form fields unless an explicit user or applicable AGENTS.md requirement names another library. Run Python as described in the Python environment section below. Do not install command-line PDF tools or OCR engines.

Keep scripts and outputs in the task workspace; runtime and skill resources are read-only. Write results to a new file and leave the source PDF unchanged unless an in-place edit is requested.

Name Python scripts for their task, such as `split_pdf.py`; avoid module names such as `pypdf.py` or `inspect.py` that shadow imported libraries.

## Read and inspect

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

Start with text; a page image costs many times more context than its text:

```python
from pypdf import PdfReader

reader = PdfReader("input.pdf")
print(len(reader.pages), reader.metadata)
for number, page in enumerate(reader.pages, start=1):
    print(f"--- page {number} ---")
    print(page.extract_text())
```

`extract_text(extraction_mode="layout")` keeps horizontal positions for tables. Extracted text can lose reading order and formatting and omits images; `page.images` yields embedded images with `.name` and `.data`.

Call `office_render` with `pages` for pages whose text is empty or garbled, which marks a scan or an image-only page; for layout, figures, charts, stamps, or signatures; or when the user asks for images or visual inspection. Render only the pages you need, a few at a time; raise `dpi` above the default 144 only for small print. Text you read from rendered pages is a transcription; say so. No OCR engine is available, so a scan gains no searchable text layer and a long scan is read selectively.

An encrypted file needs `reader.decrypt(password)` before reading. pypdf alone opens RC4-protected files; AES-protected files, which most current producers write, also need the `cryptography` package. When it is missing, report that the file cannot be opened.

## Pages, protection, and forms

`PdfWriter` builds the result and never modifies its inputs. Page selections are zero-based with an exclusive end:

```python
from pypdf import PdfWriter

writer = PdfWriter()
writer.append("report.pdf", pages=(0, 2))  # pages 1-2
writer.append("appendix.pdf")
writer.pages[0].rotate(90)
writer.add_metadata({"/Title": "Report with appendix"})
writer.write("combined.pdf")
```

`PdfWriter(clone_from="input.pdf")` copies one file for single-file edits; one writer per page splits a file. Cloning a decrypted reader into a new writer removes protection. The recommended AES encryption needs the missing `cryptography` package; when the user asks to protect a file, explain this limit. Call `writer.encrypt("password", algorithm="RC4-128")` only if the user accepts insecure RC4, and name RC4-128 on delivery. `page.merge_transformed_page(stamp, Transformation().scale(0.5))`, with `Transformation` imported from pypdf, overlays a watermark or stamp page taken from another PDF, which `office_convert` can produce from a document.

For a form, list fields with `reader.get_fields()`; a checkbox lists its states under `/_States_`. Fill every page of a cloned writer with `writer.update_page_form_field_values(page, {"name": "Ada Lovelace", "agree": "/Yes"}, auto_regenerate=False)`. A printed form without fields cannot be filled this way, and XFA forms are unsupported; place `pypdf.annotations.FreeText` notes by coordinates only when the user accepts annotations.

pypdf cannot retype or reflow existing text or remove content permanently. To change the wording of a PDF, edit its source document and convert it again; without a source, offer annotations or explain the limit.

## Create and convert

To create a PDF, write the content with `office-docx` or `office-pptx`, call `office_convert` with `format: "pdf"`, and copy the temporary file to the destination. `office_convert` does not accept PDF input.

PDF to Word is a reconstruction: extract text with pypdf, load `office-docx` and build the document with python-docx, keeping the headings, paragraphs, and simple tables you can recognize. Layout, fonts, embedded images, and scanned pages do not carry over; deliver the result as a text reconstruction, never as a faithful conversion.

## Check and deliver

Reopen the written file with `PdfReader` and verify page count and order, rotation, text of changed pages, field values, and encryption state against the request; confirm the source bytes are unchanged. Call `office_render` on the changed pages when their appearance is the deliverable, such as a stamp or a filled form, or when the user asks; a request to skip rendering takes precedence.

A fully transparent or uniformly blank image of populated content means the renderer failed, which ends visual checks for the task and leaves the source as it is. When content and structure checks pass, state the visual status only as "Content and structure checks passed; visual inspection was not completed." or "内容与结构检查通过；视觉检查未完成。".

Report what was not possible: image-only pages, transcribed text, dropped formatting, unfilled fields. Call `present({"files":[{"path":"combined.pdf"}]})` with the actual final PDF or DOCX path. It exposes the current file without copying or preserving its bytes; keep it in place and omit scripts and intermediate files unless requested. If `present` is unavailable, use the session's supported file delivery method.
