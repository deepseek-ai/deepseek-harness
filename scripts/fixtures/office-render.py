"""Office content checks for installed Python runtime tests."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path

@contextmanager
def workspace(artifacts: Path | None = None, *, prefix: str = "dsh-office-render-") -> Iterator[Path]:
    """Retain only Office inputs, PNG batches, and errors before cleaning the temporary root."""
    if artifacts is not None:
        artifacts.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix=prefix) as temporary:
        root = Path(temporary).resolve()
        try:
            yield root
        except Exception as error:
            if artifacts is not None:
                (artifacts / "error.txt").write_text(f"{type(error).__name__}: {error}\n", encoding="utf-8")
            raise
        finally:
            if artifacts is not None:
                document = next(root.rglob("color-blocks.docx"), None)
                if document is not None:
                    source = document.parent
                    for name in ("color-blocks.docx", "color-blocks.pptx", "color-blocks.xlsx"):
                        if (source / name).is_file():
                            shutil.copy2(source / name, artifacts / name)
                    for name in ("cli-docx", "cli-pptx", "cli-xlsx", "node-pptx"):
                        batch = source / name
                        if batch.is_dir():
                            destination = artifacts / name
                            destination.mkdir()
                            for file in batch.iterdir():
                                if file.is_file() and (file.suffix == ".png" or file.name == "manifest.json"):
                                    shutil.copy2(file, destination / file.name)


def copy_documents(directory: Path) -> dict[str, Path]:
    """Copy the Kit's one-page color-block fixtures into a private test directory."""
    documents = {}
    for extension in ("docx", "pptx", "xlsx"):
        source = Path(__file__).with_suffix("") / f"color-blocks.{extension}"
        destination = directory / source.name
        shutil.copy2(source, destination)
        documents[extension] = destination
    return documents


def check_image(path: Path) -> None:
    """Require visible colored blocks and text after compositing transparency onto white."""
    from PIL import Image

    with Image.open(path) as image:
        rgba = image.convert("RGBA")
    visible = Image.alpha_composite(Image.new("RGBA", rgba.size, "white"), rgba).convert("RGB")
    red = blue = black = nonwhite = red_x = blue_x = 0
    for index, (r, g, b) in enumerate(visible.get_flattened_data()):
        x = index % visible.width
        if r >= 160 and g <= 100 and b <= 100:
            red += 1
            red_x += x
        if r <= 100 and g <= 160 and b >= 160:
            blue += 1
            blue_x += x
        black += max(r, g, b) < 80
        nonwhite += min(r, g, b) < 240
    pixels = visible.width * visible.height
    counts = {"red": red, "blue": blue, "black": black, "nonwhite": nonwhite, "pixels": pixels}
    if red < pixels * 0.01 or blue < pixels * 0.01 or black < pixels * 0.0002 or nonwhite < pixels * 0.04:
        raise AssertionError(f"Office image lacks visible color blocks or text: {path}: {counts}")
    if red_x / red + visible.width * 0.1 >= blue_x / blue:
        raise AssertionError(f"Office image has reversed or overlapping color blocks: {path}: {counts}")


def check_render_manifest(manifest: dict, expected_backend: str) -> Path:
    """Check direct-Office metadata and return its sole saved image path."""
    assert manifest["backend"] == expected_backend, manifest
    assert manifest["rasterEngine"] == "libreoffice", manifest
    assert manifest["source"] == "saved", manifest
    assert len(manifest["images"]) == 1, manifest
    return Path(manifest["images"][0]["path"])


def check_render(manifest: dict, expected_backend: str) -> None:
    """Check direct-Office metadata and visible content in its sole output image."""
    check_image(check_render_manifest(manifest, expected_backend))


def render_cli(
    command: Sequence[str], documents: Mapping[str, Path], directory: Path,
    expected_backend: str, environment: Mapping[str, str], *, check_content: bool = True,
) -> None:
    """Run the three document engines through the real CLI with isolated outputs."""
    errors = []
    for extension, document in documents.items():
        selection = ["--sheet", "Render", "--range", "A1:B2"] if extension == "xlsx" else ["--pages", "1"]
        try:
            result = subprocess.run([
                *command, "render", "--input", str(document), "--output-dir", str(directory / f"cli-{extension}"),
                "--dpi", "72", "--timeout-ms", "120000", *selection,
            ], env=environment, capture_output=True, text=True, encoding="utf-8", timeout=480)
            if result.returncode:
                raise AssertionError(f"exit {result.returncode}: {result.stderr}")
            manifest = json.loads(result.stdout)
            if check_content:
                check_render(manifest, expected_backend)
            else:
                check_render_manifest(manifest, expected_backend)
        except Exception as error:
            errors.append(f"{extension}: {type(error).__name__}: {error}")
    if errors:
        raise AssertionError("Office CLI content checks failed:\n" + "\n".join(errors))
