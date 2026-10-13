---
name: office-recalculate
description: Refresh spreadsheet formula caches and verify calculated values with LibreOffice Kit.
---

# Recalculate spreadsheet formulas

Use the installed LibreOffice Kit CLI through the shell with the absolute Node and CLI paths supplied below. In Bash, invoke `"<node>" "<cli>"`; in PowerShell, invoke `& "<node>" "<cli>"`. Prefer bundled LibreOffice unless the user requests another installation. If the Office sidecar is missing, follow [sidecar setup](../office/references/sidecar.md): ask whether the user wants to download it and install only after they agree. Do not invoke system soffice, use npx, or install a replacement to work around a failed recalculation with an installed sidecar.

Keep the original workbook and write a new file in the task workspace. Quote each input and output path.

```text
"<node>" "<cli>" recalculate --input <workbook.xlsx> --output <recalculated.xlsx>
```

Verify the saved result with openpyxl, using `load_workspace_dependencies` for the Python path unless a project environment is required. Open it with both `data_only=False` and `data_only=True`. Check that formulas survive and cached results match the requested logic, expected totals, and cell types. Check required unchanged sheets, styles, and data. Recalculation does not validate business logic or guarantee Excel-specific feature compatibility.

If no supported recalculation engine is available or the command fails, preserve the workbook and explain that calculated values could not be refreshed. Do not replace requested formulas with constants or present stale/absent caches as fresh results. Deliver the verified output through `present` when available, keeping the file in place.
