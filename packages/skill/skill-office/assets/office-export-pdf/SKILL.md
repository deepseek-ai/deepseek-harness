---
name: office-export-pdf
description: Convert an Office document to a requested PDF with LibreOffice Kit.
---

# Export an Office document to PDF

Use the installed LibreOffice Kit CLI through the shell with the absolute Node and CLI paths supplied below. In Bash, invoke `"<node>" "<cli>"`; in PowerShell, invoke `& "<node>" "<cli>"`. Prefer bundled LibreOffice unless the user requests another installation. If the Office sidecar is missing, follow [sidecar setup](../office/references/sidecar.md): ask whether the user wants to download it and install only after they agree. Do not invoke system soffice, use npx, or install a replacement to work around a failed conversion with an installed sidecar.

Convert the final saved Office file to a new PDF in the task workspace. Preserve the source. Quote each input and output path.

```text
"<node>" "<cli>" convert --input <final-office-file> --output <new-file.pdf>
```

Check the command result, nonempty output, and `%PDF-` file signature. If a PDF reader library is already available, compare page count and extractable text with the requested content. If it is unavailable, report the extent of validation; do not generate images or install extra tools to validate a conversion. Spreadsheet PDF pages follow workbook print settings; change those settings only when requested. Conversion may differ from the native application's pagination or fonts.

If export fails, preserve the usable source and report the export limitation. Do not repeatedly convert an unchanged source or use conversion to investigate a failed preview. For PDF export alone, stop after these checks. Only a request for images or visual inspection calls for `office-render`; load it before that separate operation. Deliver the requested PDF through `present` when available, keeping the file in place.
