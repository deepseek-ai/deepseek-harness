# Binary Office fixtures

English | [中文](README.zh.md)

`preview.doc`, `preview.xls`, and `preview.ppt` contain `Office preview 中文文档`. They are the `one-page.doc`, `one-sheet.xls`, and `one-slide.ppt` fixtures from [LibreOffice Kit](https://github.com/deepseek-harness/libreoffice-kit/tree/main/test/fixtures), exported from Harness-authored OOXML with LibreOffice 26.8.0.3 using the Word, Excel, and PowerPoint 97 filters. The source documents retain the Harness MIT license.

The browser regression reads these committed OLE files and verifies actual conversion and selectable PDF text. They contain no user documents and require no Office application or fixture generator during tests. They cover simple legacy imports, not complex-document fidelity.
