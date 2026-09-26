# 二进制 Office 测试文件

[English](README.md) | 中文

`preview.doc`、`preview.xls` 和 `preview.ppt` 包含 `Office preview 中文文档`。它们来自 [LibreOffice Kit](https://github.com/deepseek-harness/libreoffice-kit/tree/main/test/fixtures) 的 `one-page.doc`、`one-sheet.xls` 和 `one-slide.ppt`，由 Harness 编写的 OOXML 通过 LibreOffice 26.8.0.3 的 Word、Excel 和 PowerPoint 97 过滤器导出。源文档保留 Harness 的 MIT 许可证。

浏览器回归读取这些检入的 OLE 文件，验证真实转换和可选取的 PDF 文字。文件不含用户文档，测试期间不需要 Office 应用或文件生成器。它们覆盖简单的旧格式导入，不代表复杂文档的保真度。
