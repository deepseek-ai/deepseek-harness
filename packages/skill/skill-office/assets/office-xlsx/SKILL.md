---
name: office-xlsx
description: Read, create, edit, and validate Excel workbooks, data, and formulas (.xlsx).
---

# Excel workbooks

Use `openpyxl` and `pandas` unless an explicit user or applicable AGENTS.md requirement names another library. Run Python as described in the Python environment section below.

Keep scripts, working files, and outputs in the task workspace. The runtime and skill directory are shared read-only resources. Save to a new workbook unless the user requests an in-place edit.

Name Python scripts for their task, such as `edit_xlsx.py`; avoid module names such as `inspect.py`, `openpyxl.py`, or `pandas.py` that shadow imported libraries.

## Read and modify

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

openpyxl cannot read legacy `.xls` files. Use `office_convert` with `format: "xlsx"`, copy the result into the workspace, then edit the copy.

Use `openpyxl` for existing XLSX workbooks and targeted cell or style changes. Load with `data_only=False` when formulas must survive. Inspect sheet names, the affected cell types, formulas, styles, merged ranges, and referenced ranges before editing. Check the saved file by reopening it, including unchanged content that the request requires preserving.

Use pandas for data analysis and transformations. A DataFrame is not the workbook: exporting it over an existing file can lose sheets, formulas, charts, and formatting. Write analysis results back to the intended ranges with openpyxl. `XlsxWriter` can create new workbooks, but cannot read or modify existing ones.

For a new workbook, the selected Python environment can write editable values, styles, and formulas directly:

```python
from openpyxl import Workbook
from openpyxl.styles import Font

workbook = Workbook()
sheet = workbook.active
sheet.title = "Revenue"
for row in [("Quarter", "Revenue"), ("Q1", 12), ("Q2", 18), ("Total", "=SUM(B2:B3)")]:
    sheet.append(row)
for cell in sheet[1]:
    cell.font = Font(bold=True)
sheet.column_dimensions["A"].width = 18
sheet.column_dimensions["B"].width = 18
workbook.save("report.xlsx")
```

Preserve numbers, dates, booleans, and identifiers as the intended cell types; formatting is not a type conversion. For modifications, load the existing file with `openpyxl.load_workbook("input.xlsx", data_only=False)`, change the requested ranges, and save a separate result. Avoid a DataFrame round trip when workbook features must survive.

Writing a formula does not calculate its result. openpyxl and XlsxWriter do not evaluate formulas; `data_only=True` returns cached values that may be absent or stale. When calculated results must be refreshed, call `office_recalculate` with `format: "xlsx"`, and copy the returned temporary workbook to a new file in the workspace. Open the copy with openpyxl using both `data_only=False` and `data_only=True` to check that formulas survive and cached values match the expected results. If recalculation fails, preserve the original workbook and report that calculated values were not refreshed. Do not replace requested formulas with constants or report stale or absent cached values as newly calculated results.

Do not rename `.xls`, `.xlsb`, encrypted files, or macro-enabled files to `.xlsx`. They need an appropriate supported operation. `keep_vba=True` can preserve VBA package content in an XLSM workflow, but does not execute or edit macros. Preserve the original and verify each workbook feature the task depends on.

## Check and deliver

Reopen the saved workbook with openpyxl and verify the requested sheet names, values, types, formulas, styles, and totals against the source data, including unchanged content that must be preserved. These checks do not calculate formulas or judge workbook appearance.

Call `office_render` when the user asks for images or visual inspection, or when the task targets appearance, such as cell fill colors, text alignment, spacing, or sizing; a request to skip rendering takes precedence. Do not render new workbooks or data or formula edits merely to verify accompanying bold headers or number formats; check these with openpyxl alone.

Render worksheets by `sheet` and the affected `range`; worksheet numbers are not PDF page numbers. Earlier images of an unchanged source remain current. A fully transparent or uniformly blank image of populated content means the renderer failed, which ends visual checks for the task and leaves the source as it is. When content and structure checks pass, state the visual status only as "Content and structure checks passed; visual inspection was not completed." or "内容与结构检查通过；视觉检查未完成。".

Recalculate when refreshed calculated values are needed. For PDF output, call `office_convert` with `format: "pdf"`, then copy the returned temporary file to the destination. Deliver after the requested data checks pass and the required operations finish.

Call `present({"files":[{"path":"report.xlsx"}]})` with the actual final workbook path. It exposes the current source file without copying or preserving its bytes, so keep that file in place and omit intermediate scripts and reports unless requested. If `present` is unavailable, use the session's supported file delivery method.
