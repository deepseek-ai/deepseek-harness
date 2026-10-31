---
name: office-export-pdf
description: Convert an Office document to a requested PDF with the office tool.
---

# Export an Office document to PDF

Call the `office` tool with `operation: "convert"`, the final saved Office file as `input`, and `format: "pdf"`. It leaves the source unchanged and returns a temporary PDF path. Copy that file to the requested destination in the task workspace with the shell: `cp "<temporary file>" "<destination.pdf>"` (POSIX) or `Copy-Item -LiteralPath "<temporary file>" -Destination "<destination.pdf>"` (PowerShell). Do not overwrite an existing file unless the user asked for it.

After copying, check that the destination is nonempty and starts with the `%PDF-` signature, then report that extent of validation. Unless the user requests deeper checks, do not search for PDF readers, render images, or install tools to validate a conversion. Spreadsheet PDF pages follow workbook print settings; change those settings only when requested. Conversion may differ from the native application's pagination or fonts.

If export fails, including when LibreOffice Kit is unavailable, preserve the usable source and report the export limitation; do not invoke system soffice, use npx, or install a replacement. Do not repeatedly convert an unchanged source or use conversion to investigate a failed preview. For PDF export alone, stop after these checks. Only a request for images or visual inspection calls for `office-render`; load it before that separate operation. Deliver the requested PDF through `present` when available, keeping the file in place.
