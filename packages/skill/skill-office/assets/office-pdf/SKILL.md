---
name: office-pdf
description: Read, extract, inspect, split, merge, protect, or fill an existing PDF; PDF to Word (.pdf).
---

# PDF files

Use `pypdf` unless an explicit user or applicable AGENTS.md requirement names another library. Run Python as described in the Python environment section below. Do not install command-line PDF tools or OCR engines.

Keep scripts and outputs in the task workspace; runtime and skill resources are read-only. Write results to a new file and leave the source PDF unchanged unless an in-place edit is requested. Name Python scripts for their task, such as `split_pdf.py`; avoid module names such as `pypdf.py` or `inspect.py` that shadow imported libraries.

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

Rules for every capability below:

- An encrypted file needs `reader.decrypt(password)` first. pypdf alone opens RC4-protected files; AES-protected files, which most current producers write, also need the `cryptography` package, which is not installed. When it is missing, report that the file cannot be opened.
- pypdf cannot retype or reflow existing text, and nothing here removes content permanently: cropped, covered, or de-annotated areas keep their text and images in the file, so none of these is a redaction. To change wording, edit the source document and convert it again; without a source, offer annotations or explain the limit.
- New pages, such as a cover, stamp, or header, come from `office-docx` or `office-pptx` plus `office_convert` with `format: "pdf"`; copy the temporary file into the workspace. `office_convert` does not accept PDF input.
- User page numbers start at 1; pypdf indexes start at 0, and a range such as `pages=(0, 2)` excludes its end.

## Read and extract content

Start with text; a page image costs many times more context than its text:

```python
from pypdf import PdfReader

reader = PdfReader("input.pdf")
print(len(reader.pages), reader.metadata)
for number, page in enumerate(reader.pages, start=1):
    print(f"--- page {number} ---")
    print(page.extract_text())
```

`extract_text(extraction_mode="layout")` keeps approximate horizontal positions for tables; `orientations=(0,)` keeps upright text only; `visitor_text=lambda text, cm, tm, font, size: ...` receives each run with its position `(tm[4], tm[5])` for filtering by region. `page.images` yields embedded images with `.name` and `.data`: the pictures placed on a page, not an image of the page. Extraction performs no OCR and can lose reading order, table structure, and formatting.

## Render and read pages

Call `office_render` with `pages` for pages whose text is empty or garbled, which marks a scan or an image-only page; for layout, figures, charts, stamps, or signatures; to check a changed page; or when the user asks for images or visual inspection. Render only the pages you need, a few at a time; raise `dpi` above the default 144 only for small print. Text you read from rendered pages is a transcription; say so. It adds no text layer to the PDF, and a long scan is read selectively.

## Organize pages

`PdfWriter` builds the result without modifying its inputs; `PdfWriter(clone_from="input.pdf")` copies one file for single-file edits, and one writer per range splits a file:

```python
from pypdf import PdfWriter

writer = PdfWriter()
writer.append("cover.pdf")
writer.append("report.pdf", pages=[2, 0, 1])  # pages 3, 1, 2
writer.merge(1, "appendix.pdf", pages=(0, 2))  # pages 1-2, after the cover
del writer.pages[-1]
writer.write("combined.pdf")
```

Take a repeated page from a reader again; inserting an existing `writer.pages` entry shares one object, so a later rotation or overlay changes every copy.

## Transform page geometry

`page.rotate(90)` turns the displayed page clockwise. `page.mediabox` is the paper and `page.cropbox` the visible area, in points from the lower-left corner of the unrotated page; set `page.cropbox.lower_left` and `.upper_right` to trim margins. `page.scale_to(595, 842)` resizes page and content to A4; `page.add_transformation(Transformation().scale(0.9).translate(30, 40))` moves content inside unchanged boxes. Render changed pages to check for clipped or out-of-bounds content.

## Overlay page content

Draw a page from another PDF over or under each target page:

```python
from pypdf import PdfReader, PdfWriter, Transformation

stamp = PdfReader("stamp.pdf").pages[0]
writer = PdfWriter(clone_from="input.pdf")
for page in writer.pages:
    page.merge_transformed_page(stamp, Transformation().scale(0.5).translate(400, 20), over=True)
writer.write("stamped.pdf")
```

`over=False` places a watermark beneath the content. Create overlay pages with the rule above; visible page numbers need one generated page per target page. For several pages per sheet, merge scaled pages onto `writer.add_blank_page(width, height)`.

## Annotations and links

Read `page.get("/Annots", [])`, calling `.get_object()` on each entry for `/Subtype`, `/Rect`, and `/Contents`. Add with `writer.add_annotation(page_index, annotation)` using `Text`, `FreeText`, `Highlight` with `quad_points` and `highlight_color="ffff00"`, `Rectangle`, `Line`, or `Link` with `url` or `target_page_index` from `pypdf.annotations`. Remove by type, such as `writer.remove_annotations(subtypes=["/Highlight", "/FreeText"])`; without `subtypes` it also removes links and the `/Widget` controls of form fields. Render the page to check position and display, and verify link targets.

## Interactive forms

List fields with `reader.get_fields()`; a checkbox lists its states under `/_States_`. `writer.update_page_form_field_values(None, {"name": "Ada Lovelace", "agree": "/Yes"}, auto_regenerate=False)` fills every page of a cloned writer and writes appearances. A field's value and its visible appearance are separate; render the page to see the result. To flatten, pass every field with `flatten=True`, which draws the values into the page content, then `writer.remove_annotations(subtypes="/Widget")` and `del writer.root_object["/AcroForm"]`. A printed or scanned form has no fields, and XFA forms are unsupported; place `FreeText` annotations by coordinates only when the user accepts annotations.

## Document navigation

`reader.outline` nests bookmarks as lists; `reader.get_destination_page_number(item)` resolves one. `part = writer.add_outline_item("Part 1", 0)` and `writer.add_outline_item("Section 1.1", 2, parent=part)` add a hierarchy; `writer.append(path, outline_item="Title")` bookmarks each merged file. `reader.named_destinations` and `writer.add_named_destination("appendix", 9)` manage named targets. `reader.page_labels` lists displayed page numbers; `writer.set_page_label(0, 3, style="/r")` labels pages 1-4 as i-iv and `writer.set_page_label(4, 9, style="/D", start=1)` restarts at 1. Bookmarks are not a table-of-contents page, and labels do not change numbers printed on pages. After reordering, check where each bookmark and destination points.

## Embedded attachments

`reader.attachments` maps each name to a list of contents, because names repeat. Write extracted files under `Path(name).name` in a new directory, rename duplicates, and never open or run them. `writer.add_attachment("data.csv", data)` adds a file. To remove some, collect the entries to keep from `writer.attachments`, `del writer.root_object["/Names"]["/EmbeddedFiles"]`, and add the kept entries again; they lose descriptions and dates. `/FileAttachment` annotations on pages are separate from this list.

## Document management and output

**Metadata.** `reader.metadata` holds the document information and `reader.xmp_metadata` the separate XMP packet; viewers may show either, so change both. `writer.add_metadata({"/Title": "Report"})` sets information entries. For XMP, take `writer.xmp_metadata` or `pypdf.xmp.XmpInformation.create()`, set fields such as `xmp.dc_title = {"x-default": "Report"}`, and assign it back to `writer.xmp_metadata`. Assigning `None` to `writer.metadata` or `writer.xmp_metadata` removes it.

**Protection.** `PdfWriter(clone_from=reader)` after `reader.decrypt(password)` writes an unprotected copy. Protecting a file needs AES, which needs the missing `cryptography` package; explain this limit and do not fall back to RC4 by default. Call `writer.encrypt("password", algorithm="RC4-128")` only if the user accepts insecure RC4, and name RC4-128 on delivery.

**Optimization.** `page.compress_content_streams()` on each writer page and `writer.compress_identical_objects()` reduce size without changing appearance. Compare sizes afterward; image-heavy files shrink little, and no reduction is guaranteed.

**Writing.** Write to a new path. For an in-place edit, write beside the source and replace it only after the checks below pass.

## Combined tasks

| Task | Capabilities |
|---|---|
| Text PDF to Word | Read and extract content → build with `office-docx` |
| Scanned PDF to Word | Render and read pages → build with `office-docx` |
| Merge reports with chapter bookmarks | Organize pages → document navigation → write and check |
| Watermark or page numbers | Create overlay pages → transform geometry → overlay → render |
| Deliver a filled form as non-editable | Fill fields → check appearance → flatten → write and check |
| Tidy and shrink a scan | Organize pages → transform geometry → optimize → render |

A Word reconstruction keeps the headings, paragraphs, and simple tables you can recognize; layout, fonts, and images do not carry over, so deliver it as a reconstruction, never as a faithful conversion.

## Check and deliver

Reopen the written file with `PdfReader` and verify what the request changed: page count and order, rotation and boxes, text of changed pages, annotations, field values, bookmarks and labels, attachments, metadata, and encryption state; confirm the source bytes are unchanged. Call `office_render` on changed pages when their appearance is the deliverable, such as a stamp, crop, annotation, or filled form, or when the user asks; a request to skip rendering takes precedence.

A fully transparent or uniformly blank image of populated content means the renderer failed, which ends visual checks for the task and leaves the source as it is. When content and structure checks pass, state the visual status only as "Content and structure checks passed; visual inspection was not completed." or "内容与结构检查通过；视觉检查未完成。".

Report what was not possible: image-only pages, transcribed text, dropped formatting, unfilled fields, unsupported protection. Call `present({"files":[{"path":"combined.pdf"}]})` with the actual final PDF or DOCX path. It exposes the current file without copying or preserving its bytes; keep it in place and omit scripts and intermediate files unless requested. If `present` is unavailable, use the session's supported file delivery method.
