---
name: office-recalculate
description: Refresh spreadsheet formula caches and verify calculated values with the office tool.
---

# Recalculate spreadsheet formulas

Call the `office` tool with `operation: "recalculate"`, the saved workbook as `input`, and `format: "xlsx"` or `"ods"`. It leaves the original workbook unchanged and returns a temporary path of the recalculated workbook. Copy that file to a new file in the task workspace with the shell: `cp "<temporary file>" "<recalculated.xlsx>"` (POSIX) or `Copy-Item -LiteralPath "<temporary file>" -Destination "<recalculated.xlsx>"` (PowerShell).

Verify the copied result with openpyxl, running Python as described in the Python environment section below. Open it with both `data_only=False` and `data_only=True`. Check that formulas survive and cached results match the requested logic, expected totals, and cell types. Check required unchanged sheets, styles, and data. Recalculation does not validate business logic or guarantee Excel-specific feature compatibility.

If recalculation fails, including when LibreOffice Kit is unavailable, preserve the workbook and explain that calculated values could not be refreshed; do not invoke system soffice, use npx, or install a replacement. Do not replace requested formulas with constants or present stale or absent caches as fresh results. Deliver the verified output through `present` when available, keeping the file in place.
