"""Local Office operations through the runtime wheel's dsoffice CLI.

Calls are synchronous and do not create agents, sessions, or model requests.
The CLI owns conversion deadlines, engine termination, and failed-output cleanup.
Console Ctrl+C waits for CLI cleanup before raising KeyboardInterrupt; a second
interrupt forces termination and can leave partial output. On Windows, callers
must share the CLI's console for Ctrl+C delivery.
"""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Literal, TypeVar

import deepseek_harness_runtime
from deepseek_harness_runtime._resources import run_office_process
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import HarnessError, SdkProtocolError


class OfficeError(HarnessError):
    """A failed Office operation, including its CLI error code and exit status."""

    def __init__(self, code: str, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


class _OfficeModel(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True)


class ConversionResult(_OfficeModel):
    """Saved conversion or recalculation output and missing declared fonts."""

    backend: Literal["native", "wasm"]
    output_path: Path = Field(alias="outputPath")
    missing_fonts: list[str] = Field(alias="missingFonts")


class ImageRectangle(_OfficeModel):
    """Source rectangle in CSS pixels at 96 DPI, before raster scaling."""

    x: float
    y: float
    width: float
    height: float


class RenderedImage(_OfficeModel):
    """One saved PNG and its source page, worksheet, or worksheet fragment."""

    index: int
    path: Path
    width: int
    height: int
    rectangle: ImageRectangle
    byte_length: int = Field(alias="byteLength")
    page: int | None = None
    sheet: str | None = None
    range: str | None = None
    rtl: bool | None = None


class RenderImagesResult(_OfficeModel):
    """Image manifest for one saved input; page_count includes unselected pages."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    backend: Literal["native", "wasm"]
    raster_engine: Literal["libreoffice", "pdfium"] = Field(alias="rasterEngine")
    source: Literal["saved"]
    input_path: Path = Field(alias="inputPath")
    source_sha256: str = Field(alias="sourceSha256")
    dpi: float
    page_count: int = Field(alias="pageCount")
    images: list[RenderedImage]
    missing_fonts: list[str] = Field(alias="missingFonts")


@dataclass(frozen=True, slots=True)
class OfficeOptions:
    """Kit limits and fonts; omitted values retain the installed kit defaults.

    timeout_ms bounds the engine operation, including font work and output,
    after explicit resource download. The call waits for engine exit and cleanup.
    Font paths may be relative to cwd; fallback groups replace the kit defaults.
    """

    timeout_ms: int | None = None
    max_input_bytes: int | None = None
    max_output_bytes: int | None = None
    max_image_resolution: int | None = None
    max_archive_entries: int | None = None
    max_uncompressed_bytes: int | None = None
    max_font_files: int | None = None
    max_font_file_bytes: int | None = None
    max_loaded_font_bytes: int | None = None
    font_directories: Sequence[str | os.PathLike[str]] | None = None
    initial_font_families: Sequence[str] | None = None
    font_fallbacks: Sequence[Sequence[str]] | None = None

    def _arguments(self) -> list[str]:
        arguments: list[str] = []
        for field in fields(self):
            value = getattr(self, field.name)
            if value is None:
                continue
            if field.name == "font_directories":
                for path in value:
                    arguments.extend(("--font-directory", os.fspath(path)))
            elif field.name == "initial_font_families":
                for family in value:
                    arguments.extend(("--initial-font-family", family))
            elif field.name == "font_fallbacks":
                arguments.extend(("--font-fallbacks", json.dumps(value)))
            else:
                arguments.extend(("--" + field.name.replace("_", "-"), str(value)))
        return arguments


class _CliFailure(_OfficeModel):
    code: str
    error: str


_Result = TypeVar("_Result", bound=_OfficeModel)


def _run(arguments: list[str], options: OfficeOptions | None, result_type: type[_Result]) -> _Result:
    process = run_office_process(
        [*deepseek_harness_runtime.resolve_office_launch_args(), *arguments,
         *(options._arguments() if options is not None else [])],
    )
    stdout, stderr = process.stdout, process.stderr
    if process.returncode != 0:
        try:
            failure = _CliFailure.model_validate_json(stderr)
        except ValidationError:
            raise OfficeError("failed", stderr.decode("utf-8", errors="replace").strip()
                              or "Office CLI exited without a diagnostic.",
                              process.returncode) from None
        raise OfficeError(failure.code, failure.error, process.returncode)
    try:
        return result_type.model_validate_json(stdout)
    except ValidationError as error:
        raise SdkProtocolError("Office CLI returned an invalid result.") from error


def render_images(
    input_path: str | os.PathLike[str],
    output_dir: str | os.PathLike[str],
    *,
    pages: Literal["all"] | Sequence[int] | None = None,
    sheet: str | None = None,
    range: str | None = None,
    dpi: int | None = None,
    max_pages: int | None = None,
    max_pixels: int | None = None,
    max_dimension: int | None = None,
    options: OfficeOptions | None = None,
) -> RenderImagesResult:
    """Render Office or PDF to PNG files and manifest.json in a fresh directory.

    Pages are one-based document pages or slides. Worksheets use an exact
    sheet name and optional A1 range instead. Paths may be relative to cwd.
    The caller owns successful output; failed batches remove the new directory.
    Raises OfficeError for CLI failures and SdkProtocolError for invalid JSON.
    """
    arguments = ["render", "--input", os.fspath(input_path), "--output-dir", os.fspath(output_dir)]
    selections = {
        "pages": pages if isinstance(pages, str) or pages is None else ",".join(map(str, pages)),
        "sheet": sheet, "range": range, "dpi": dpi, "max-pages": max_pages,
        "max-pixels": max_pixels, "max-dimension": max_dimension,
    }
    for name, value in selections.items():
        if value is not None:
            arguments.extend(("--" + name, str(value)))
    return _run(arguments, options, RenderImagesResult)


def convert(
    input_path: str | os.PathLike[str],
    output_path: str | os.PathLike[str],
    *,
    sheet: str | None = None,
    options: OfficeOptions | None = None,
) -> ConversionResult:
    """Export Office to the format named by a fresh output file's extension.

    Paths may be relative to cwd. CSV export requires an exact sheet name for
    multi-sheet input. Existing output is rejected; failed output is removed.
    Raises OfficeError for CLI failures and SdkProtocolError for invalid JSON.
    """
    arguments = ["convert", "--input", os.fspath(input_path), "--output", os.fspath(output_path)]
    if sheet is not None:
        arguments.extend(("--sheet", sheet))
    return _run(arguments, options, ConversionResult)


def recalculate(
    input_path: str | os.PathLike[str],
    output_path: str | os.PathLike[str],
    *,
    options: OfficeOptions | None = None,
) -> ConversionResult:
    """Refresh workbook formula caches into a distinct, fresh XLSX or ODS file.

    Input accepts XLS, XLSX, or ODS. Paths may be relative to cwd. Formulas
    survive, but recalculation does not verify business logic or Excel fidelity.
    Raises OfficeError for CLI failures and SdkProtocolError for invalid JSON.
    """
    return _run(["recalculate", "--input", os.fspath(input_path), "--output", os.fspath(output_path)],
                options, ConversionResult)
