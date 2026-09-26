---
name: office-xlsx
description: Read, create, and modify Excel workbooks (.xlsx), including data, formulas, formatting, and pandas analysis. Use for Excel inputs or deliverables. Load before running Office commands. Data and formula tasks skip visual inspection; inspect only for formatting or layout needs. Use only bundled LibreOffice unless the user explicitly opts out; without that opt-out, do not search for another LibreOffice executable.
---

# Excel workbooks

Follow an explicit user or applicable AGENTS.md requirement for an environment or library. Otherwise call `load_workspace_dependencies` and run its Python executable with bundled `openpyxl` and `pandas`. Do not install packages or search for a system Python for the default workflow. If the tool is unavailable, use an already configured environment and report a missing dependency only when it prevents the requested operation.

Keep scripts, working files, and outputs in the task workspace. The runtime and skill directory are shared read-only resources. Save to a new workbook unless the user requests an in-place edit.

## Read and modify

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

Writing a formula does not calculate its result. openpyxl and XlsxWriter do not evaluate Excel formulas; `data_only=True` returns stored cached values that may be absent or stale. Read the installed CLI paths and capabilities as described below. When it supports `recalculate`, use `"<node>" "<cli>" recalculate --input report.xlsx --output recalculated.xlsx` to save formulas and refreshed cached results to a new workbook. Reopen that result with both `data_only=False` and `data_only=True` to check formulas and calculated values against the requested logic. Recalculation does not validate business logic or guarantee Excel-specific feature compatibility. Without a recalculation engine, state the limit; do not replace requested formulas with constants or report old cached values as newly calculated results.

Do not rename `.xls`, `.xlsb`, encrypted files, or macro-enabled files to `.xlsx`. They need an appropriate supported operation. `keep_vba=True` can preserve VBA package content in an XLSM workflow, but does not execute or edit macros and does not guarantee every advanced workbook feature survives. Preserve the original and verify such requirements explicitly.

## Check and deliver

Run the shared checker with the selected Python executable; `<skill-directory>` is this loaded skill's resource base:

```text
<python> <skill-directory>/../scripts/check_office.py <workbook.xlsx> --out <checks.json>
```

It checks ZIP/XML integrity and internal relationships, and reports sheet names, populated-cell counts, and formula counts. Repeated `--contains TEXT` arguments check string cells and sheet names, and `--count N` checks sheet count. `--contains` excludes numeric cells and does not validate formula results; verify those separately with openpyxl. The checker does not calculate formulas or judge workbook appearance. Compare relevant values, types, formulas, styles, and totals with the task's source data.

For data and formula tasks, deliver after structural and data checks pass. Skip preview rendering and visual inspection, and do not add an unrequested caveat that visual inspection was omitted. Basic styling such as bold headers or number formats does not itself require visual inspection. Formula recalculation is independent of rendering and remains necessary when calculated results must be refreshed.

Inspect relevant regions when the task concerns formatting, layout, chart appearance, print layout, or a known display problem. Before generating inspection images, establish that the current model accepts images. If it does not, finish structural and data checks and report the requested visual check as unavailable; do not rasterize unreadable previews, retry `read_image`, or choose a second model. Export requested images or PDFs even when visual inspection is unnecessary.

A successful command or image read does not prove that a preview contains workbook content. For a populated range, a fully transparent or uniformly blank image is a renderer failure, not evidence that the workbook needs fixing. Stop all visual QA for that workbook immediately; do not try a wider range, another sheet, a different DPI, or another output format. Check suspicious previews with the bundled Pillow library, compositing RGBA onto white before comparing pixels. Do not create diagnostic workbooks, repeatedly retry rendering, modify print settings, or convert to PDF solely to investigate a failed preview. Preserve the requested workbook changes, finish structural and data checks, and report the visual check as unavailable. Only change print areas or scaling when the user requests printed layout.

## LibreOffice operations

Use the bundled LibreOffice binaries unless the user explicitly asks not to use them. Without that explicit opt-out, never search for or invoke system LibreOffice, `soffice`, an application-installed binary, or a downloaded replacement. If the bundled CLI is unavailable or fails, report that failure instead of substituting another executable.

When recalculation, a requested export, or visual inspection is needed, use the `libreofficeKit.node` and `libreofficeKit.cli` absolute paths supplied in the loaded skill's **Installed LibreOffice Kit** section. Run Node with the CLI entry as its first argument, then `capabilities --json` once. For the bundled runtime, these paths work from the task directory; do not search PATH, guess a package directory, use `npx`, or install a renderer. Quote each path separately; PowerShell also requires the `&` invocation operator. The examples below use `<node>` and `<cli>` for those two returned paths. For worksheet rendering, select an exact sheet name and the relevant cell range:

```sh
"<node>" "<cli>" render --input report.xlsx --output-dir preview-v1 --sheet Summary --range A1:D20 --dpi 144
```

For a user-requested PDF export, use `"<node>" "<cli>" convert --input report.xlsx --output report.pdf`. PDF conversion is not a fallback for failed visual QA.

Use `--sheet`/`--range` for worksheets, not `--pages`. Direct worksheet images cover cell regions; PDF pages follow print settings and are not worksheet numbers. Include chart/drawing regions explicitly. Read the manifest's image paths, fragment rectangles, and missing-font diagnostics; large regions may split across images. Outputs must be new directories/files. Reuse previews for the same saved workbook and inspect additional regions only when needed. Check widths, formats, clipping, and charts; set print areas/scaling when printed layout is requested. Render each relevant region once. Rerender only after requested source changes; an empty or failed preview ends visual checking for the whole workbook.

When visual inspection is needed and this deployment explicitly disables the CLI but provides `render_document`, call it without `pages` first and inspect returned images only on a ready result; `status: "skipped"` ends visual checking. If required rendering is unavailable or fails, preserve the usable workbook and report the inspection or export limit. Do not search for COM automation, install conversion packages, or build another renderer for routine QA. Preview rendering does not refresh the original workbook's formula caches or certify native Excel appearance. Deliver once the requested data and applicable checks pass.

Call `present({"files":[{"path":"report.xlsx"}]})` with the actual final workbook path. It exposes the current source file without copying or preserving its bytes, so keep that file in place and omit intermediate scripts and reports unless requested. If `present` is unavailable, use the session's supported file delivery method.
