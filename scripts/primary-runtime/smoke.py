"""Exercise the relocated Office payload with its own isolated interpreter."""

import csv
import importlib.metadata
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import numpy
# NumPy testing helpers require this native extension even without upstream test directories.
import numpy._core._multiarray_tests
import pandas
from docx import Document
from docx.shared import Inches as DocxInches
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Text
from pypdf.errors import DependencyError
from pypdf.xmp import XmpInformation
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject


def check_interpreters():
    """Exercise command aliases, child execution and a pip-enabled virtual environment."""
    executable = Path(sys.executable)
    names = [executable.name] if sys.platform == "win32" else ["python", "python3", f"python{sys.version_info.major}.{sys.version_info.minor}"]
    for name in names:
        interpreter = executable.with_name(name)
        subprocess.run([
            str(interpreter), "-I", "-B", "-c",
            "import subprocess, sys; from pathlib import Path; "
            "assert Path(sys.executable) == Path(sys.argv[1]); "
            "subprocess.run([sys.executable, '-I', '-B', '-c', 'import ssl, sqlite3, ctypes'], check=True, timeout=30)",
            str(interpreter),
        ], check=True, timeout=60)
    with tempfile.TemporaryDirectory(prefix="dsh python venv ") as directory:
        environment = Path(directory) / "environment"
        subprocess.run([str(executable.with_name(names[0])), "-I", "-B", "-m", "venv", str(environment)], check=True, timeout=60)
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        subprocess.run([str(python), "-I", "-B", "-c", "import sys; assert sys.prefix != sys.base_prefix"], check=True, timeout=30)
        subprocess.run([str(python), "-I", "-B", "-m", "pip", "check"], check=True, timeout=30)


def main():
    """Check installed versions and read back editable Office documents."""
    assert sys.version_info[:3] == tuple(map(int, sys.argv[2].split("."))), sys.version
    check_interpreters()
    versions = json.loads(sys.argv[1])
    # Only pip belongs to the interpreter baseline; all other distributions must be declared.
    # Each target's native release-host smoke must confirm this baseline.
    expected_names = {re.sub(r"[-_.]+", "-", name).lower() for name in versions} | {"pip"}
    installed_names = {
        re.sub(r"[-_.]+", "-", distribution.metadata["Name"]).lower()
        for distribution in importlib.metadata.distributions()
    }
    assert installed_names == expected_names, {"unexpected": sorted(installed_names - expected_names), "missing": sorted(expected_names - installed_names)}
    for name, expected in versions.items():
        actual = importlib.metadata.version(name)
        assert actual == expected, (name, actual, expected)
    assert numpy.arange(4).sum() == 6
    assert pandas.DataFrame({"n": [1, 2]}).n.sum() == 3
    numpy.testing.assert_allclose(numpy.arange(4), [0, 1, 2, 3])
    pandas.testing.assert_frame_equal(pandas.DataFrame({"n": [1, 2]}), pandas.DataFrame({"n": [1, 2]}))
    for library in (numpy, pandas):
        root = Path(library.__file__).parent
        assert not any(path.is_dir() for path in root.rglob("tests")), root
        distribution = importlib.metadata.distribution(library.__name__)
        record = distribution.read_text("RECORD")
        assert record, library.__name__
        for file, _hash, _size in csv.reader(io.StringIO(record)):
            assert distribution.locate_file(file).is_file(), file

    with tempfile.TemporaryDirectory(prefix="dsh-office-smoke-") as directory:
        root = Path(directory)
        image = root / "chart.png"
        Image.new("RGB", (80, 40), "#2878bc").save(image)
        with Image.open(image) as restored:
            assert restored.size == (80, 40)

        document = Document()
        document.add_heading("Office 文档", 0)
        document.add_paragraph("Editable text")
        document.add_table(rows=2, cols=2).cell(1, 1).text = "42"
        document.add_picture(str(image), width=DocxInches(1))
        document.save(root / "document.docx")
        reopened_document = Document(root / "document.docx")
        assert reopened_document.tables[0].cell(1, 1).text == "42"
        assert reopened_document.paragraphs[0].text == "Office 文档"

        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1)).text = "Office 演示"
        slide.shapes.add_picture(str(image), Inches(1), Inches(2))
        chart_data = CategoryChartData()
        chart_data.categories = ["A", "B"]
        chart_data.add_series("Values", [2, 4])
        slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(3), Inches(2), Inches(4), Inches(3), chart_data)
        presentation.save(root / "presentation.pptx")
        reopened_presentation = Presentation(root / "presentation.pptx")
        assert len(reopened_presentation.slides) == 1
        chart = next(shape.chart for shape in reopened_presentation.slides[0].shapes if shape.has_chart)
        assert list(chart.series[0].values) == [2.0, 4.0]

        workbook = Workbook()
        sheet = workbook.active
        sheet.append(["Value", "Formula"])
        sheet.append([42, "=A2*2"])
        sheet["A1"].font = Font(bold=True)
        workbook.save(root / "workbook.xlsx")
        reopened_workbook = load_workbook(root / "workbook.xlsx")
        try:
            assert reopened_workbook.active["A2"].value == 42
            assert reopened_workbook.active["B2"].value == "=A2*2"
            assert reopened_workbook.active["A1"].font.bold
        finally:
            reopened_workbook.close()
        assert pandas.read_excel(root / "workbook.xlsx")["Value"].iloc[0] == 42

        pdf = PdfWriter()
        pdf.add_blank_page(width=200, height=100)
        pdf.add_blank_page(width=100, height=200).rotate(90)
        pdf.add_metadata({"/Title": "Office PDF"})
        xmp = XmpInformation.create()
        xmp.dc_title = {"x-default": "Office PDF"}
        pdf.xmp_metadata = xmp
        pdf.add_attachment("data.csv", b"a,b")
        pdf.add_attachment("data.csv", b"c,d")
        pdf.set_page_label(0, 0, style="/r")
        pdf.set_page_label(1, 1, style="/D", start=1)
        pdf.write(root / "document.pdf")
        reopened_pdf = PdfReader(root / "document.pdf")
        assert len(reopened_pdf.pages) == 2
        assert reopened_pdf.pages[1].rotation == 90
        assert reopened_pdf.metadata.title == "Office PDF"
        assert reopened_pdf.xmp_metadata.dc_title == {"x-default": "Office PDF"}
        assert dict(reopened_pdf.attachments) == {"data.csv": [b"a,b", b"c,d"]}
        assert reopened_pdf.page_labels == ["i", "1"]

        form = PdfWriter()
        form.add_blank_page(width=300, height=200)
        field = form.add_annotation(0, DictionaryObject({
            NameObject("/Subtype"): NameObject("/Widget"), NameObject("/FT"): NameObject("/Tx"),
            NameObject("/T"): TextStringObject("name"), NameObject("/F"): NumberObject(4),
            NameObject("/Rect"): ArrayObject([FloatObject(10), FloatObject(10), FloatObject(200), FloatObject(40)]),
            NameObject("/DA"): TextStringObject("/Helv 12 Tf 0 g"),
        }))
        form.root_object[NameObject("/AcroForm")] = DictionaryObject({NameObject("/Fields"): ArrayObject([field.indirect_reference])})
        form.add_annotation(0, Text(text="Review note", rect=(220, 150, 240, 170)))
        form.write(root / "form.pdf")
        filled = PdfWriter(clone_from=root / "form.pdf")
        filled.update_page_form_field_values(None, {"name": "Ada Lovelace"}, auto_regenerate=False)
        filled.remove_annotations(subtypes=["/Text"])
        filled.write(root / "filled.pdf")
        reopened_form = PdfReader(root / "filled.pdf")
        assert reopened_form.get_fields()["name"].value == "Ada Lovelace"
        assert reopened_form.trailer["/Root"]["/AcroForm"].get("/NeedAppearances") is not True
        assert [annotation.get_object()["/Subtype"] for annotation in reopened_form.pages[0]["/Annots"]] == ["/Widget"]
        assert "/AP" in reopened_form.pages[0]["/Annots"][0].get_object()
        flattened = PdfWriter(clone_from=root / "form.pdf")
        flattened.update_page_form_field_values(None, {"name": "Ada Lovelace"}, flatten=True)
        flattened.remove_annotations(subtypes="/Widget")
        del flattened.root_object["/AcroForm"]
        flattened.write(root / "flattened.pdf")
        reopened_flattened = PdfReader(root / "flattened.pdf")
        assert reopened_flattened.get_fields() is None
        assert "/Widget" not in [annotation.get_object()["/Subtype"] for annotation in reopened_flattened.pages[0].get("/Annots", [])]
        assert reopened_flattened.pages[0].extract_text() == "Ada Lovelace"

        # The payload omits cryptography, so only the RC4 algorithm named by the PDF skill is available.
        try:
            PdfWriter(clone_from=root / "document.pdf").encrypt("password", algorithm="AES-256")
        except DependencyError:
            pass
        else:
            raise AssertionError("AES encryption unexpectedly available")
        protected = PdfWriter(clone_from=root / "document.pdf")
        protected.encrypt("password", algorithm="RC4-128")
        protected.write(root / "protected.pdf")
        reopened_protected = PdfReader(root / "protected.pdf")
        assert reopened_protected.is_encrypted and reopened_protected.decrypt("password")
        assert len(reopened_protected.pages) == 2
    print("Office runtime versions and document round trips passed.")


if __name__ == "__main__":
    main()
