"""Exercise the distributed checker without requiring external Office libraries."""

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

CHECKER = Path(__file__).resolve().parents[1] / "assets/scripts/check_office.py"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
STRICT_W = "http://purl.oclc.org/ooxml/wordprocessingml/main"
STRICT_P = "http://purl.oclc.org/ooxml/presentationml/main"
STRICT_A = "http://purl.oclc.org/ooxml/drawingml/main"
STRICT_S = "http://purl.oclc.org/ooxml/spreadsheetml/main"
STRICT_R = "http://purl.oclc.org/ooxml/officeDocument/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"


class OfficeCheckTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="dsh-office-check-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def package(self, suffix, parts, compression=zipfile.ZIP_STORED):
        primary, mime = {
            "docx": ("word/document.xml", "wordprocessingml.document.main+xml"),
            "pptx": ("ppt/presentation.xml", "presentationml.presentation.main+xml"),
            "xlsx": ("xl/workbook.xml", "spreadsheetml.sheet.main+xml"),
        }[suffix]
        path = self.root / ("中文 document." + suffix)
        with zipfile.ZipFile(path, "w", compression=compression) as archive:
            archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                             f'<Override PartName="/{primary}" ContentType="application/vnd.openxmlformats-officedocument.{mime}"/></Types>')
            for name, content in parts.items():
                archive.writestr(name, content)
        return path

    def run_check(self, path, *args):
        before = path.read_bytes()
        output = self.root / "checks.json"
        result = subprocess.run([sys.executable, str(CHECKER), str(path), "--out", str(output), *args],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(result.stderr, "", result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report, json.loads(output.read_text(encoding="utf-8")))
        return result.returncode, report

    def test_docx_merged_cells_distinct_sections_and_cjk_are_not_layout_failures(self):
        path = self.package("docx", {"word/document.xml": f'''<w:document xmlns:w="{W}"><w:body>
          <w:p><w:r><w:t>中文报告</w:t></w:r><w:pPr><w:sectPr><w:pgSz w:w="16000"/><w:pgMar w:left="1000" w:right="1000"/></w:sectPr></w:pPr></w:p>
          <w:tbl><w:tblGrid><w:gridCol w:w="5000"/><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并标题</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:sectPr><w:pgSz w:w="6000"/><w:pgMar w:left="1000" w:right="1000"/></w:sectPr>
        </w:body></w:document>'''})
        code, report = self.run_check(path, "--contains", "中文报告")
        self.assertEqual(code, 0)
        self.assertEqual(report["summary"]["tables"], [{"rows": 1, "columns": 2}])
        self.assertEqual(len(report["summary"]["sections"]), 2)
        code, report = self.run_check(path, "--contains", "Missing requested title")
        self.assertEqual(code, 1)
        self.assertEqual(report["checks"][-1]["status"], "fail")

    def test_pptx_checks_slide_count_and_relationships(self):
        parts = {
            "ppt/presentation.xml": f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>',
            "ppt/_rels/presentation.xml.rels": f'<Relationships xmlns="{PKG}"><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>',
            "ppt/slides/slide1.xml": f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><a:p><a:r><a:t>季度总结</a:t></a:r></a:p></p:sld>',
        }
        path = self.package("pptx", parts)
        self.assertEqual(self.run_check(path, "--contains", "季度总结", "--count", "1")[0], 0)
        self.assertEqual(self.run_check(path, "--count", "2")[0], 1)
        parts["ppt/_rels/presentation.xml.rels"] = f'<Relationships xmlns="{PKG}"/>'
        code, report = self.run_check(self.package("pptx", parts))
        self.assertEqual(code, 1)
        self.assertIn("ppt/presentation.xml", report["checks"][0]["detail"])
        self.assertIn("r1", report["checks"][0]["detail"])
        parts["ppt/_rels/presentation.xml.rels"] = f'<Relationships xmlns="{PKG}"><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>'
        del parts["ppt/slides/slide1.xml"]
        path = self.package("pptx", parts)
        code, report = self.run_check(path)
        self.assertEqual(code, 1)
        self.assertIn("missing package member", report["checks"][0]["detail"])

    def test_docx_content_follows_section_and_note_references(self):
        parts = {
            "word/document.xml": f'''<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>
              <w:p><w:r><w:t>Main text</w:t><w:footnoteReference w:id="2"/><w:endnoteReference w:id="3"/></w:r></w:p>
              <w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/></w:sectPr>
            </w:body></w:document>''',
            "word/_rels/document.xml.rels": f'''<Relationships xmlns="{PKG}">
              <Relationship Id="header" Type="{R}/header" Target="custom/header.xml"/>
              <Relationship Id="footer" Type="{R}/footer" Target="custom/footer.xml"/>
              <Relationship Id="unused-header" Type="{R}/header" Target="custom/unused-header.xml"/>
              <Relationship Id="unused-footer" Type="{R}/footer" Target="custom/unused-footer.xml"/>
              <Relationship Id="notes" Type="{R}/footnotes" Target="custom/notes.xml"/>
              <Relationship Id="endnotes" Type="{R}/endnotes" Target="custom/endnotes.xml"/>
              <Relationship Id="comments" Type="{R}/comments" Target="comments.xml"/>
              <Relationship Id="glossary" Type="{R}/glossaryDocument" Target="glossary/document.xml"/>
            </Relationships>''',
            "word/custom/header.xml": f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>Linked header</w:t></w:r></w:p></w:hdr>',
            "word/custom/footer.xml": f'<w:ftr xmlns:w="{W}"><w:p><w:r><w:t>Linked footer</w:t></w:r></w:p></w:ftr>',
            "word/custom/unused-header.xml": f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>Retained header only</w:t></w:r></w:p></w:hdr>',
            "word/custom/unused-footer.xml": f'<w:ftr xmlns:w="{W}"><w:p><w:r><w:t>Retained footer only</w:t></w:r></w:p></w:ftr>',
            "word/custom/notes.xml": f'''<w:footnotes xmlns:w="{W}">
              <w:footnote w:id="2"><w:p><w:r><w:t>Linked note</w:t></w:r></w:p></w:footnote>
              <w:footnote w:id="4"><w:p><w:r><w:t>Unused note only</w:t></w:r></w:p></w:footnote>
            </w:footnotes>''',
            "word/custom/endnotes.xml": f'''<w:endnotes xmlns:w="{W}">
              <w:endnote w:id="3"><w:p><w:r><w:t>Linked endnote</w:t></w:r></w:p></w:endnote>
              <w:endnote w:id="5"><w:p><w:r><w:t>Unused endnote only</w:t></w:r></w:p></w:endnote>
            </w:endnotes>''',
            "word/comments.xml": f'<w:comments xmlns:w="{W}"><w:comment><w:p><w:r><w:t>Comment only</w:t></w:r></w:p></w:comment></w:comments>',
            "word/glossary/document.xml": f'<w:glossaryDocument xmlns:w="{W}"><w:p><w:r><w:t>Building block only</w:t></w:r></w:p></w:glossaryDocument>',
            "word/header9.xml": f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>Unused header only</w:t></w:r></w:p></w:hdr>',
        }
        path = self.package("docx", parts)
        self.assertEqual(self.run_check(path, "--contains", "Main text", "--contains", "Linked header", "--contains", "Linked footer",
                                        "--contains", "Linked note", "--contains", "Linked endnote")[0], 0)
        for text in ["Comment only", "Building block only", "Unused header only", "Retained header only", "Retained footer only",
                     "Unused note only", "Unused endnote only"]:
            with self.subTest(text=text):
                code, report = self.run_check(path, "--contains", text)
                self.assertEqual(code, 1)
                self.assertEqual(report["checks"][-1]["status"], "fail")

    def test_relationships_to_non_xml_members_report_source_reference_and_target(self):
        for suffix, main, references in [
            ("pptx", "ppt/presentation.xml", f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>'),
            ("xlsx", "xl/workbook.xml", f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Data" sheetId="1" r:id="r1"/></sheets></workbook>'),
        ]:
            with self.subTest(format=suffix):
                folder, filename = main.split("/")
                target = f"{folder}/media/image1.png"
                path = self.package(suffix, {
                    main: references,
                    f"{folder}/_rels/{filename}.rels": f'<Relationships xmlns="{PKG}"><Relationship Id="r1" Target="media/image1.png"/></Relationships>',
                    target: b"image bytes",
                })
                code, report = self.run_check(path)
                self.assertEqual(code, 1)
                detail = report["checks"][0]["detail"]
                for expected in [main, "r1", target]:
                    self.assertIn(expected, detail)

    def test_xlsx_counts_formulas_without_claiming_recalculation(self):
        path = self.package("xlsx", {
            "xl/workbook.xml": f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Data" sheetId="1" r:id="r1"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{PKG}"><Relationship Id="r1" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
            "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>收入</t></is></c><c r="B1"><v>4</v></c><c r="C1"><f>B1*2</f><v/></c></row></sheetData></worksheet>',
        })
        code, report = self.run_check(path, "--contains", "收入", "--count", "1")
        self.assertEqual(code, 0)
        self.assertEqual(report["summary"], {"sheets": [{"name": "Data", "cells": 3, "formulas": 1}], "formulas_evaluated": False})

    def test_strict_ooxml_namespaces_are_inspected(self):
        docx = self.package("docx", {
            "word/document.xml": f'<w:document xmlns:w="{STRICT_W}"><w:body><w:p><w:r><w:t>Strict Word</w:t></w:r></w:p></w:body></w:document>',
        })
        self.assertEqual(self.run_check(docx, "--contains", "Strict Word")[0], 0)

        pptx = self.package("pptx", {
            "ppt/presentation.xml": f'<p:presentation xmlns:p="{STRICT_P}" xmlns:r="{STRICT_R}"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>',
            "ppt/_rels/presentation.xml.rels": f'<Relationships xmlns="{PKG}"><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>',
            "ppt/slides/slide1.xml": f'<p:sld xmlns:p="{STRICT_P}" xmlns:a="{STRICT_A}"><a:p><a:r><a:t>Strict Slides</a:t></a:r></a:p></p:sld>',
        })
        self.assertEqual(self.run_check(pptx, "--contains", "Strict Slides", "--count", "1")[0], 0)

        xlsx = self.package("xlsx", {
            "xl/workbook.xml": f'''<workbook xmlns="{STRICT_S}" xmlns:r="{STRICT_R}"><sheets>
              <sheet name="First" sheetId="1" r:id="r1"/><sheet name="Second" sheetId="2" r:id="r2"/>
            </sheets></workbook>''',
            "xl/_rels/workbook.xml.rels": f'''<Relationships xmlns="{PKG}">
              <Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/>
            </Relationships>''',
            "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{STRICT_S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Strict Sheet</t></is></c></row></sheetData></worksheet>',
            "xl/worksheets/sheet2.xml": f'<worksheet xmlns="{STRICT_S}"><sheetData/></worksheet>',
        })
        code, report = self.run_check(xlsx, "--contains", "Strict Sheet", "--count", "2")
        self.assertEqual(code, 0)
        self.assertEqual([sheet["name"] for sheet in report["summary"]["sheets"]], ["First", "Second"])

    def test_xlsx_checks_only_cell_referenced_shared_strings(self):
        parts = {
            "xl/workbook.xml": f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Data" sheetId="1" r:id="r1"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{PKG}"><Relationship Id="r1" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
            "xl/sharedStrings.xml": f'<sst xmlns="{S}"><si><t>Deleted value</t></si><si><r><t>实际</t></r><r><t>内容</t></r></si></sst>',
            "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" t="inlineStr"><is><t>Inline value</t></is></c></row></sheetData></worksheet>',
        }
        path = self.package("xlsx", parts)
        self.assertEqual(self.run_check(path, "--contains", "实际内容", "--contains", "Inline value")[0], 0)
        code, report = self.run_check(path, "--contains", "Deleted value")
        self.assertEqual(code, 1)
        self.assertEqual(report["checks"][-1]["status"], "fail")
        for index in ["-1", "2", "invalid", ""]:
            with self.subTest(index=index):
                parts["xl/worksheets/sheet1.xml"] = f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1" t="s"><v>{index}</v></c></row></sheetData></worksheet>'
                code, report = self.run_check(self.package("xlsx", parts))
                self.assertEqual(code, 1)
                self.assertEqual(report["checks"][0]["status"], "fail")
                self.assertIn("xl/worksheets/sheet1.xml", report["checks"][0]["detail"])
                self.assertIn("A1", report["checks"][0]["detail"])
        parts["xl/_rels/workbook.xml.rels"] = f'<Relationships xmlns="{PKG}"/>'
        code, report = self.run_check(self.package("xlsx", parts))
        self.assertEqual(code, 1)
        self.assertIn("xl/workbook.xml", report["checks"][0]["detail"])
        self.assertIn("r1", report["checks"][0]["detail"])

    def test_xlsx_empty_or_missing_string_values_remain_json_reports(self):
        for cell_type, expected in [("s", 1), ("str", 0)]:
            for value in ["<v/>", ""]:
                with self.subTest(cell_type=cell_type, value=value):
                    path = self.package("xlsx", {
                        "xl/workbook.xml": f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Data" sheetId="1" r:id="r1"/></sheets></workbook>',
                        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{PKG}"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
                        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1" t="{cell_type}">{value}</c></row></sheetData></worksheet>',
                    })
                    code, report = self.run_check(path)
                    self.assertEqual(code, expected)
                    self.assertEqual(report["verdict"], "fail" if expected else "pass")
                    if cell_type == "s":
                        self.assertIn("A1: invalid shared string index ''", report["checks"][0]["detail"])

    def test_output_directory_failure_is_json_and_preserves_the_document(self):
        path = self.package("docx", {"word/document.xml": f'<w:document xmlns:w="{W}"><w:body/></w:document>'})
        before = path.read_bytes()
        result = subprocess.run([sys.executable, str(CHECKER), str(path), "--out", str(self.root)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        report = json.loads(result.stdout)
        self.assertEqual(report["verdict"], "fail")
        self.assertEqual(report["checks"][-1]["id"], "output")
        self.assertEqual(path.read_bytes(), before)

    def test_encrypted_package_returns_json_failure(self):
        path = Path(__file__).parent / "fixtures/encrypted.xlsx"
        code, report = self.run_check(path)
        self.assertEqual(code, 1)
        self.assertIn("encrypted", report["checks"][0]["detail"])

    def test_corrupt_deflate_member_returns_json_package_failure(self):
        path = self.package("docx", {
            "word/document.xml": f'<w:document xmlns:w="{W}"><w:body/></w:document>',
        }, compression=zipfile.ZIP_DEFLATED)
        with zipfile.ZipFile(path) as archive:
            member = archive.getinfo("word/document.xml")
        data = bytearray(path.read_bytes())
        name_length = int.from_bytes(data[member.header_offset + 26:member.header_offset + 28], "little")
        extra_length = int.from_bytes(data[member.header_offset + 28:member.header_offset + 30], "little")
        compressed = member.header_offset + 30 + name_length + extra_length
        data[compressed] = 0x07  # BTYPE=3 is reserved and invalid in a DEFLATE block.
        path.write_bytes(data)
        code, report = self.run_check(path)
        self.assertEqual(code, 1)
        self.assertEqual(report["checks"][0]["id"], "package")
        self.assertEqual(report["checks"][0]["status"], "fail")
        self.assertTrue(report["checks"][0]["detail"])

    def test_invalid_zip_and_xml_fail_and_output_cannot_overwrite_input(self):
        path = self.root / "broken.docx"
        path.write_bytes(b"not an Office archive")
        self.assertEqual(self.run_check(path)[0], 1)
        path = self.package("docx", {"word/document.xml": "<broken>"})
        self.assertEqual(self.run_check(path)[0], 1)
        before = path.read_bytes()
        result = subprocess.run([sys.executable, str(CHECKER), str(path), "--out", str(path)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
