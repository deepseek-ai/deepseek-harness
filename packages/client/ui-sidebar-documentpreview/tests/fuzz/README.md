# XLSX fuzz diagnostics

English | [中文](README.zh.md)

Generate spreadsheet files with Openpyxl and XlsxWriter, then compare the source XLSX adapter against independently recorded cell values, formulas, and unsupported-content categories. This explicit diagnostic campaign retains failures and exits nonzero; it is not part of the default unit suite.

## Run a campaign

Install workspace dependencies and use a Python interpreter with Openpyxl, XlsxWriter, and Pillow. In PowerShell, set `$excelFuzzPython` to that interpreter's executable path. Run from the repository root with a new output directory:

```powershell
& $excelFuzzPython packages/client/ui-sidebar-documentpreview/tests/fuzz/generate.py .artifacts/excel-fuzz-new --seed 4863 --random-cases 400
pnpm exec tsx packages/client/ui-sidebar-documentpreview/tests/fuzz/run.client.ts .artifacts/excel-fuzz-new
```

The seed controls feature combinations, values, and byte mutations. ZIP metadata is fixed; reproducibility also requires the writer versions recorded in `manifest.json`. The generator validates internal relationship targets and reloads oracle cells with Openpyxl before classifying a workbook as valid. Rejected candidates remain in `generatorErrors`; random byte mutations are classified separately.

Replay selected cases from an existing corpus:

```sh
pnpm exec tsx packages/client/ui-sidebar-documentpreview/tests/fuzz/run.client.ts .artifacts/excel-fuzz-new --only openpyxl-table --report table.json
```

The runner gives each input a disposable-worker deadline of 10 seconds and checks input immutability, cell values, formula caches, and notice ordering/uniqueness. `--timeout-ms` changes that diagnostic deadline. Reports retain every outcome; `repros/` contains representative failures with fewer feature combinations, not a claim of globally minimal inputs. Accepted damaged ZIPs are informational and need separate inspection.

## Compare an older adapter

`--baseline-ref <commit-or-ref> --report baseline.json` reads that revision's `xlsx.ts` from Git and disables notice comparisons. It still uses the current dependency versions and shared conversion helpers; it cannot reproduce an unpatched ExcelJS baseline after installing the patch. Retain reports from the original dependency state or run that revision in a separate checkout. The temporary baseline module is removed after its worker exits. This compares source parsing, not FortuneSheet browser rendering or the shipped Web profile.

## Retained regressions

The [OPC fixtures](../fixtures/excel-opc/) contain five isolated failures copied from the seed 4863 corpus and a combined Openpyxl workbook. Openpyxl 3.1.5 produces comments, Tables, namespace-prefix and part-name cases; XlsxWriter 3.2.9 produces the relative-target case. The combined workbook adds chart, conditional formatting, frozen headings, hidden rows/columns/sheet, a merge, styles, a hyperlink, literal XML-looking text, and a formula, then applies `sheet-prefix` and `sheet-filename` mutations. Openpyxl independently validates the saved inputs. Unit and browser tests read these committed bytes without Python.

The [XML fixtures](../fixtures/excel-xml/) retain one XlsxWriter 3.2.9 workbook and seven equivalent encodings: UTF-16 worksheet or metadata XML, relocated workbook/styles/shared strings, CDATA text, and relocated worksheet/drawing directories. Each retains a formula cache, Unicode and XML-looking text, comment, Table, styles, merge, frozen headings, hidden content, and all four notice categories. When upgrading ExcelJS, compare the complete preview and comment/Table metadata through both Node and browser entries, then run `apps/web/tests/excel-opc.e2e.ts` against the built Worker. Keep original corpus reports; save replay results under a new `--report` name and inspect ZIP directory integrity separately from independent-reader acceptance.

The [opening fixtures](../excel-opening-fixture.ts) derive Strict URI aliases, root-target and part-name case variants, and orphan DrawingML from the combined Openpyxl file. These transformations retain cell data and run through both parser entries, full preview comparison, and the shipped browser Worker. Ambiguous ASCII case-equivalent entries are rejected; non-ASCII names remain distinct.

Run the Node and browser-bundle parser regressions:

```sh
pnpm exec vitest run packages/client/ui-sidebar-documentpreview/tests/excel-opening.client.spec.ts packages/client/ui-sidebar-documentpreview/tests/excel-opc.client.spec.ts packages/client/ui-sidebar-documentpreview/tests/excel-xml.client.spec.ts
```

Fuzz reports record each input's SHA-256, whether it opened, and the worktree status. `validOpened` and `validRejected` separate opening failures from value differences; strict exit status still rejects either defect. Known 1904 time/duration offsets and empty-string formula-cache differences remain diagnostic failures. Corrupt inputs accepted by the parser remain informational.

Maintain the ExcelJS patch with `pnpm patch` and `pnpm patch-commit` against the published package. Installed dependency trees contain generated launchers that must not enter the patch. Validate patch application in a fresh `pnpm patch --edit-dir <new-directory>` extraction before relying on tests against a cached installation.
