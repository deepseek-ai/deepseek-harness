#!/usr/bin/env python3
"""Read-only OOXML checks and structural summaries; no rendering or formula evaluation.

Run with INPUT.docx, INPUT.pptx, or INPUT.xlsx. Optional --contains assertions
check extracted text; DOCX excludes comments, glossary text, and unreferenced parts or notes.
--count checks slides or sheets. JSON escapes non-ASCII
characters and goes to stdout and optionally --out. Exit 0 means the requested
structural checks passed, 1 means a document, assertion, or report write failed, and 2 means
invalid command-line arguments.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import sys
import zipfile
import zlib
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

W_NAMESPACES = (
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
)
A_NAMESPACES = (
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
)
P_NAMESPACES = (
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://purl.oclc.org/ooxml/presentationml/main",
)
S_NAMESPACES = (
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
)
R_NAMESPACES = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
)
MAIN_PARTS = {
    ".docx": ("word/document.xml", "wordprocessingml.document.main+xml"),
    ".pptx": ("ppt/presentation.xml", "presentationml.presentation.main+xml"),
    ".xlsx": ("xl/workbook.xml", "spreadsheetml.sheet.main+xml"),
}


def namespace(root: ET.Element, supported: tuple[str, ...], part: str) -> str:
    """Return the main XML namespace after checking its OOXML variant."""
    uri = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
    if uri not in supported:
        raise ValueError(f"{part} uses unsupported XML namespace: {uri or '(none)'}")
    return "{" + uri + "}"


def relationship_id(node: ET.Element, part: str) -> str:
    """Read an office-document relationship id from Transitional or Strict OOXML."""
    for uri in R_NAMESPACES:
        value = node.get("{" + uri + "}id")
        if value is not None:
            return value
    raise ValueError(f"{part} has a reference without a relationship id")


def relationship_types(kind: str) -> set[str]:
    """Return the Transitional and Strict relationship type names for one role."""
    return {f"{uri}/{kind}" for uri in R_NAMESPACES}


def iter_namespaces(root: ET.Element, namespaces: tuple[str, ...], local_name: str):
    """Iterate matching elements across Transitional and Strict namespaces."""
    for uri in namespaces:
        yield from root.iter("{" + uri + "}" + local_name)


def relationship_target(part: str, target: str) -> str:
    """Resolve a package relationship without fetching external resources."""
    path = unquote(urlsplit(target).path)
    return posixpath.normpath(path.lstrip("/") if path.startswith("/") else posixpath.join(posixpath.dirname(part), path))


def relationships(part: str, xml: dict[str, ET.Element], types: set[str] | None = None) -> dict[str, str]:
    path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    root = xml.get(path)
    if root is None:
        return {}
    return {
        rel.attrib["Id"]: relationship_target(part, rel.attrib["Target"])
        for rel in root if rel.get("TargetMode") != "External" and (types is None or rel.get("Type") in types)
    }


def related_xml(part: str, reference: str, links: dict[str, str], xml: dict[str, ET.Element]) -> ET.Element:
    """Read a related XML part with diagnostics naming its source and reference."""
    if reference not in links:
        raise ValueError(f"{part} references missing relationship: {reference}")
    target = links[reference]
    if target not in xml:
        raise ValueError(f"{part} relationship {reference} targets a non-XML member: {target}")
    return xml[target]


def inspect_docx(xml: dict[str, ET.Element]) -> tuple[dict, str]:
    part = "word/document.xml"
    root = xml[part]
    w = namespace(root, W_NAMESPACES, part)
    body = root.find(f"{w}body")
    if body is None:
        raise ValueError("word/document.xml has no document body")
    tables = []
    for table in body.iter(f"{w}tbl"):
        grid = table.findall(f"{w}tblGrid/{w}gridCol")
        rows = table.findall(f"{w}tr")
        # Merged cells span logical grid columns; counting physical cells loses them.
        columns = len(grid) if grid else max((sum(
            int(cell.find(f"{w}tcPr/{w}gridSpan").get(f"{w}val", "1"))
            if cell.find(f"{w}tcPr/{w}gridSpan") is not None else 1
            for cell in row.findall(f"{w}tc")
        ) for row in rows), default=0)
        tables.append({"rows": len(rows), "columns": columns})
    sections = []
    for section in body.iter(f"{w}sectPr"):
        size = section.find(f"{w}pgSz")
        margins = section.find(f"{w}pgMar")
        sections.append({
            "page_twips": {} if size is None else {key.removeprefix(w): value for key, value in size.attrib.items()},
            "margins_twips": {} if margins is None else {key.removeprefix(w): value for key, value in margins.attrib.items()},
        })
    text_parts = [body]
    for kind in ("header", "footer"):
        links = relationships(part, xml, relationship_types(kind))
        for section in body.iter(f"{w}sectPr"):
            for reference in section.findall(f"{w}{kind}Reference"):
                text_parts.append(related_xml(part, relationship_id(reference, part), links, xml))
    for kind in ("footnote", "endnote"):
        references = {node.attrib[f"{w}id"] for node in body.iter(f"{w}{kind}Reference")}
        if not references:
            continue
        links = relationships(part, xml, relationship_types(f"{kind}s"))
        for reference in links:
            tree = related_xml(part, reference, links, xml)
            text_parts.extend(note for note in tree.findall(f"{w}{kind}") if note.get(f"{w}id") in references)
    text = "\n".join("".join(node.text or "" for node in paragraph.iter(f"{w}t")) for tree in text_parts
                     for paragraph in tree.iter(f"{w}p"))
    return {"paragraphs": len(list(body.iter(f"{w}p"))), "tables": tables, "sections": sections}, text


def inspect_pptx(xml: dict[str, ET.Element]) -> tuple[dict, str]:
    part = "ppt/presentation.xml"
    links = relationships(part, xml)
    root = xml[part]
    p = namespace(root, P_NAMESPACES, part)
    slides = root.findall(f"{p}sldIdLst/{p}sldId")
    texts = []
    for slide in slides:
        reference = relationship_id(slide, part)
        tree = related_xml(part, reference, links, xml)
        texts.append("\n".join("".join(node.text or "" for node in iter_namespaces(paragraph, A_NAMESPACES, "t"))
                               for paragraph in iter_namespaces(tree, A_NAMESPACES, "p")))
    return {"slides": len(slides)}, "\n".join(texts)


def inspect_xlsx(xml: dict[str, ET.Element]) -> tuple[dict, str]:
    part = "xl/workbook.xml"
    links = relationships(part, xml)
    root = xml[part]
    s = namespace(root, S_NAMESPACES, part)
    sheets = []
    texts = []
    shared = xml.get("xl/sharedStrings.xml")
    shared_s = s if shared is None else namespace(shared, S_NAMESPACES, "xl/sharedStrings.xml")
    shared_strings = [] if shared is None else [
        "".join(node.text or "" for node in item.iter(f"{shared_s}t")) for item in shared.iter(f"{shared_s}si")
    ]
    for sheet in root.findall(f"{s}sheets/{s}sheet"):
        reference = relationship_id(sheet, part)
        tree = related_xml(part, reference, links, xml)
        sheet_s = namespace(tree, S_NAMESPACES, links[reference])
        cells = list(tree.iter(f"{sheet_s}c"))
        formulas = sum(cell.find(f"{sheet_s}f") is not None for cell in cells)
        sheets.append({"name": sheet.attrib["name"], "cells": len(cells), "formulas": formulas})
        for cell in cells:
            if cell.get("t") == "s":
                value = cell.findtext(f"{sheet_s}v", "")
                location = f"{links[reference]} cell {cell.get('r', '(no reference)')}"
                try:
                    index = int(value)
                except ValueError as error:
                    raise ValueError(f"{location}: invalid shared string index {value!r}") from error
                if not 0 <= index < len(shared_strings):
                    raise ValueError(f"{location}: shared string index out of range: {index}")
                texts.append(shared_strings[index])
        texts.extend("".join(node.text or "" for node in cell.iter(f"{sheet_s}t")) for cell in cells)
        texts.extend(cell.findtext(f"{sheet_s}v", "") for cell in cells if cell.get("t") == "str")
        texts.append(sheet.attrib["name"])
    return {"sheets": sheets, "formulas_evaluated": False}, "\n".join(texts)


def inspect(path: Path) -> tuple[dict, str]:
    """Validate package members and relationships before inspecting the main part."""
    main, content_type = MAIN_PARTS[path.suffix.lower()]
    with zipfile.ZipFile(path) as archive:
        members = archive.namelist()
        if len(members) != len(set(members)):
            raise ValueError("ZIP contains duplicate member names")
        corrupt = archive.testzip()
        if corrupt is not None:
            raise ValueError(f"ZIP member failed its CRC check: {corrupt}")
        xml = {name: ET.fromstring(archive.read(name)) for name in members
               if name.endswith((".xml", ".rels"))}
    if main not in xml:
        raise ValueError(f"missing main part: {main}")
    types = xml.get("[Content_Types].xml")
    if types is None or not any(node.get("PartName") == "/" + main
                                and node.get("ContentType", "").endswith(content_type) for node in types):
        raise ValueError(f"[Content_Types].xml does not declare {main} as {path.suffix.lower()}")
    for name, tree in xml.items():
        if not name.endswith(".rels"):
            continue
        source = "" if name == "_rels/.rels" else posixpath.join(posixpath.dirname(posixpath.dirname(name)), posixpath.basename(name)[:-5])
        for rel in tree:
            if rel.get("TargetMode") == "External":
                continue
            target = relationship_target(source, rel.attrib["Target"])
            if target not in members:
                raise ValueError(f"{name} references missing package member: {target}")
    if path.suffix.lower() == ".docx":
        return inspect_docx(xml)
    if path.suffix.lower() == ".pptx":
        return inspect_pptx(xml)
    return inspect_xlsx(xml)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--contains", action="append", default=[], metavar="TEXT")
    parser.add_argument("--count", type=int, help="expected slide or sheet count")
    args = parser.parse_args()
    if args.input.suffix.lower() not in MAIN_PARTS:
        parser.error("input must be .docx, .pptx, or .xlsx; converting the filename does not convert its contents")
    if args.count is not None and (args.count < 0 or args.input.suffix.lower() == ".docx"):
        parser.error("--count must be non-negative and applies only to slides or sheets")
    if args.out is not None and args.out.resolve() == args.input.resolve():
        parser.error("--out must differ from the input document")
    checks = []
    summary = {}
    try:
        summary, text = inspect(args.input)
        checks.append({"id": "package", "status": "pass"})
        for required in args.contains:
            checks.append({"id": "contains", "status": "pass" if required in text else "fail", "text": required})
        if args.count is not None:
            actual = summary.get("slides", len(summary.get("sheets", [])))
            checks.append({"id": "count", "status": "pass" if actual == args.count else "fail", "expected": args.count, "actual": actual})
    except (OSError, ValueError, KeyError, RuntimeError, ET.ParseError, zipfile.BadZipFile, zlib.error) as error:
        checks.append({"id": "package", "status": "fail", "detail": str(error)})
    failed = any(check["status"] == "fail" for check in checks)
    report = {"format": args.input.suffix.lower()[1:], "verdict": "fail" if failed else "pass", "checks": checks, "summary": summary}
    output = json.dumps(report, ensure_ascii=True, indent=2) + "\n"
    if args.out is not None:
        try:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(output, encoding="utf-8")
        except OSError as error:
            failed = True
            report["verdict"] = "fail"
            checks.append({"id": "output", "status": "fail", "detail": str(error)})
            output = json.dumps(report, ensure_ascii=True, indent=2) + "\n"
    sys.stdout.write(output)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
