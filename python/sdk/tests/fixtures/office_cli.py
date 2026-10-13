"""Office JSON subprocess peer; engine behavior belongs to the real kit smoke."""

import json
import sys
from pathlib import Path

receipt = Path(sys.argv[1])
arguments = sys.argv[2:]
receipt.write_text(json.dumps(arguments), encoding="utf-8")
command = arguments[0]
values = dict(zip(arguments[1::2], arguments[2::2]))
source = Path(values["--input"])
if source.name == "error.docx":
    print(json.dumps({"code": "invalid-document", "error": "Document cannot be loaded."}), file=sys.stderr)
    sys.exit(1)
if source.name == "crash.docx":
    print("engine process unavailable", file=sys.stderr)
    sys.exit(7)
if source.name == "invalid.docx":
    print(json.dumps({"backend": "native", "outputPath": 3, "missingFonts": []}))
    sys.exit(0)
if source.name == "invalid-bytes.docx":
    sys.stdout.buffer.write(b"\xff")
    sys.exit(0)
if source.name == "timeout.docx":
    output = Path(values["--output"])
    output.write_text("partial output", encoding="utf-8")
    output.unlink()
    print(json.dumps({"code": "timeout", "error": "Conversion timed out."}), file=sys.stderr)
    sys.exit(1)
if command == "render":
    output = Path(values["--output-dir"])
    output.mkdir()
    image = output / "page-1.png"
    image.write_bytes(b"png fixture")
    result = {
        "schemaVersion": 1, "backend": "native", "rasterEngine": "libreoffice", "source": "saved",
        "inputPath": str(source.resolve()), "sourceSha256": "abc123", "dpi": 144, "pageCount": 3,
        "images": [{"index": 0, "page": 1, "path": str(image.resolve()), "width": 64, "height": 48,
                    "rectangle": {"x": 0, "y": 0, "width": 32, "height": 24}, "byteLength": 11}],
        "missingFonts": ["Fixture Sans"],
    }
    (output / "manifest.json").write_text(json.dumps(result), encoding="utf-8")
else:
    output = Path(values["--output"])
    output.write_text("converted fixture", encoding="utf-8")
    result = {"backend": "wasm", "outputPath": str(output.resolve()), "missingFonts": []}
print(json.dumps(result))
