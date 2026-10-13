"""Exercise Office argv and JSON through an actual subprocess without a model."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path

import deepseek_harness_runtime
import pytest

from deepseek_harness.errors import SdkProtocolError
from deepseek_harness.office import ConversionResult, OfficeError, OfficeOptions, convert, recalculate, render_images


@pytest.fixture
def office_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    receipt = tmp_path / "arguments.json"
    script = Path(__file__).parent / "fixtures" / "office_cli.py"
    monkeypatch.setattr(deepseek_harness_runtime, "resolve_office_launch_args",
                        lambda: (sys.executable, str(script), str(receipt)))
    return receipt


@pytest.mark.parametrize("operation", [convert, recalculate])
def test_saved_output_and_literal_path_arguments(
    operation: Callable[..., ConversionResult], office_cli: Path, tmp_path: Path,
) -> None:
    source = tmp_path / "工作簿 $name with spaces.xlsx"
    output = tmp_path / "saved workbook.xlsx"
    result = operation(source, output)
    assert result.output_path == output
    assert output.read_text() == "converted fixture"
    assert result.backend == "wasm"
    assert result.missing_fonts == []
    assert json.loads(office_cli.read_text()) == [operation.__name__, "--input", str(source), "--output", str(output)]


def test_render_images_reads_the_saved_manifest(office_cli: Path, tmp_path: Path) -> None:
    output = tmp_path / "preview"
    result = render_images(tmp_path / "deck.pptx", output, pages=[1, 3], dpi=144, max_pages=10,
                           max_pixels=1_000_000, max_dimension=4096)
    assert result.page_count == 3
    assert result.images[0].path.read_bytes() == b"png fixture"
    assert result.images[0].rectangle.width == 32
    assert result.images[0].byte_length == 11
    assert result.missing_fonts == ["Fixture Sans"]
    assert result.input_path == tmp_path / "deck.pptx"
    assert json.loads(office_cli.read_text())[5:] == [
        "--pages", "1,3", "--dpi", "144", "--max-pages", "10", "--max-pixels", "1000000", "--max-dimension", "4096",
    ]


def test_worksheet_selection_and_csv_sheet_keep_exact_names(office_cli: Path, tmp_path: Path) -> None:
    sheet = "收入 $Values"
    render_images("workbook.xlsx", tmp_path / "preview", sheet=sheet, range="A1:E9")
    assert json.loads(office_cli.read_text())[5:] == ["--sheet", sheet, "--range", "A1:E9"]
    convert("workbook.xlsx", tmp_path / "data.csv", sheet=sheet)
    assert json.loads(office_cli.read_text())[5:] == ["--sheet", sheet]


def test_limits_and_fonts_reach_the_cli(office_cli: Path, tmp_path: Path) -> None:
    convert("report.docx", tmp_path / "report.pdf", options=OfficeOptions(
        timeout_ms=4567, max_input_bytes=1024, max_output_bytes=2048, max_image_resolution=72,
        max_archive_entries=10, max_uncompressed_bytes=4096, max_font_files=20,
        max_font_file_bytes=8192, max_loaded_font_bytes=16384,
        font_directories=[tmp_path / "Fonts One", tmp_path / "Fonts Two"],
        initial_font_families=["Fixture Sans", "中文字体"], font_fallbacks=[["Preferred", "Fallback"]],
    ))
    assert json.loads(office_cli.read_text())[5:] == [
        "--timeout-ms", "4567", "--max-input-bytes", "1024", "--max-output-bytes", "2048",
        "--max-image-resolution", "72", "--max-archive-entries", "10", "--max-uncompressed-bytes", "4096",
        "--max-font-files", "20", "--max-font-file-bytes", "8192", "--max-loaded-font-bytes", "16384",
        "--font-directory", str(tmp_path / "Fonts One"), "--font-directory", str(tmp_path / "Fonts Two"),
        "--initial-font-family", "Fixture Sans", "--initial-font-family", "中文字体",
        "--font-fallbacks", '[["Preferred", "Fallback"]]',
    ]


@pytest.mark.parametrize(("filename", "code", "exit_code", "message"), [
    ("error.docx", "invalid-document", 1, "Document cannot be loaded"),
    ("crash.docx", "failed", 7, "engine process unavailable"),
    ("timeout.docx", "timeout", 1, "Conversion timed out"),
])
def test_cli_failures_preserve_diagnostics_after_exit(
    office_cli: Path, tmp_path: Path, filename: str, code: str, exit_code: int, message: str,
) -> None:
    output = tmp_path / "result.pdf"
    with pytest.raises(OfficeError, match=message) as failure:
        convert(filename, output, options=OfficeOptions(timeout_ms=100))
    assert failure.value.code == code
    assert failure.value.exit_code == exit_code
    assert not output.exists()
    assert json.loads(office_cli.read_text())[-2:] == ["--timeout-ms", "100"]


@pytest.mark.parametrize("filename", ["invalid.docx", "invalid-bytes.docx"])
def test_invalid_cli_result_fails_at_the_json_reader(office_cli: Path, tmp_path: Path, filename: str) -> None:
    with pytest.raises(SdkProtocolError, match="Office CLI returned an invalid result"):
        convert(filename, tmp_path / "result.pdf")
