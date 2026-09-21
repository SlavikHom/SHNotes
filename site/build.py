"""Build SH Notes from the PDFs in this repository; no manual catalog needed."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import quote

import pymupdf

COURSES = {"MathLog": ("logic", "Математическая логика"), "DM": ("discrete", "Дискретная математика")}


def join_lines(lines):
    return re.sub(r"(?<=\w)-\s+(?=\w)", "", " ".join(lines)).strip()


def describe(document, source, course_name):
    page = document[0]
    lines = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            spans = line["spans"]
            text = "".join(s["text"] for s in spans).strip()
            if text:
                lines.append((text, max(s["size"] for s in spans), line["bbox"]))
    lecture = next((line for line in lines if re.search(r"ЛЕКЦИЯ\s*\d+", line[0], re.I)), None)
    number_match = re.search(r"\d+", lecture[0] if lecture else source.stem)
    number = int(number_match[0]) if number_match else None
    # The SH Notes cover uses its largest type for the title below the lecture label.
    title_lines = [line for line in lines if line[1] >= 20 and
                   (lecture[2][3] if lecture else 0) < line[2][1] < page.rect.height * .55]
    if title_lines:
        title = join_lines([line[0] for line in title_lines])
        title_bottom = max(line[2][3] for line in title_lines)
        subtitle_lines = [line for line in lines if title_bottom <= line[2][1] <= title_bottom + 60
                          and 12 <= line[1] < 20]
        description = join_lines([line[0] for line in subtitle_lines])
    else:
        metadata_title = (document.metadata or {}).get("title", "").strip()
        title = metadata_title if metadata_title and metadata_title != course_name else source.stem.replace("_", " ")
        description = ""
    return title, description, number


def build(root, output):
    if output.is_symlink():
        raise ValueError("Output must not be a symlink")
    root, output = root.resolve(), output.resolve()
    # Never delete source directories or an arbitrary output location.
    if output.name != "_site" or output == root or output in root.parents:
        raise ValueError("Output must be a dedicated directory named _site, outside source directories")
    for protected in (root / "site", root / "DM", root / "MathLog", root / ".git"):
        if output == protected or protected in output.parents:
            raise ValueError(f"Output overlaps source directory: {protected}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="shnotes-build-", dir=output.parent) as temp:
        stage = Path(temp) / "public"
        stage.mkdir()
        for file in ("index.html", "style.css", "app.mjs"):
            shutil.copy2(root / "site" / file, stage / file)
        shutil.copytree(root / "site" / "vendor", stage / "vendor")
        (stage / "covers").mkdir()
        catalog = []
        for directory, (course, course_name) in COURSES.items():
            for source in sorted((root / directory).iterdir()):
                if not source.is_file() or source.suffix.lower() != ".pdf":
                    continue
                if source.is_symlink():
                    raise ValueError(f"Symlink is not a published PDF: {source}")
                digest = hashlib.sha256(source.read_bytes()).hexdigest()
                relative = source.relative_to(root).as_posix()
                identifier = course + "-" + hashlib.sha256(relative.encode()).hexdigest()[:12]
                with pymupdf.open(source) as document:
                    if document.is_encrypted or not len(document):
                        raise ValueError(f"PDF is encrypted or empty: {source}")
                    title, description, number = describe(document, source, course_name)
                    cover = f"covers/{identifier}.png"
                    document[0].get_pixmap(matrix=pymupdf.Matrix(.9, .9), alpha=False).save(stage / cover)
                    outline = [dict(level=level, title=heading, page=page)
                               for level, heading, page in document.get_toc() if 1 <= page <= len(document)]
                    catalog.append(dict(id=identifier, course=course, number=number, title=title,
                                        description=description, pages=len(document),
                                        file=quote(relative, safe="/") + "?v=" + digest[:16],
                                        cover=cover + "?v=" + digest[:16], outline=outline))
                target = stage / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                    raise ValueError(f"PDF copy checksum mismatch: {source}")
        order = {course: index for index, (course, _) in enumerate(COURSES.values())}
        catalog.sort(key=lambda x: (order[x["course"]], x["number"] or 0, x["title"]))
        (stage / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
        (stage / ".nojekyll").touch()
        html = (stage / "index.html").read_text(encoding="utf-8")
        for filename in ("app.mjs", "style.css"):
            revision = hashlib.sha256((stage / filename).read_bytes()).hexdigest()[:12]
            html = html.replace(f'"{filename}"', f'"{filename}?v={revision}"')
        (stage / "index.html").write_text(html, encoding="utf-8")
        if output.exists():
            if output.is_symlink():
                raise ValueError("Output must not be a symlink")
            shutil.rmtree(output)
        # Copy so Windows output inherits its parent ACL, not tempfile's private ACL.
        shutil.copytree(stage, output)
    print(f"Built {len(catalog)} lectures / {sum(x['pages'] for x in catalog)} pages in {output}")
    return catalog


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    build(args.root, args.output or args.root / "_site")
