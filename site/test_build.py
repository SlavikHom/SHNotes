"""Regression checks for automatic addition, replacement and removal of PDFs."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
import pymupdf

spec = importlib.util.spec_from_file_location("notes_build", Path(__file__).with_name("build.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildTests(unittest.TestCase):
    def test_pdf_lifecycle(self):
        scratch = Path(__file__).resolve().parents[2] / ".work" / "site"
        with tempfile.TemporaryDirectory(dir=scratch if scratch.exists() else None) as temp:
            root = Path(temp)
            for directory in ("site/vendor", "MathLog", "DM"):
                (root / directory).mkdir(parents=True)
            for file in ("index.html", "style.css", "app.mjs"):
                (root / "site" / file).write_text('"app.mjs" "style.css"', encoding="utf-8")
            pdf = root / "MathLog" / "lecture-01.pdf"
            with pymupdf.open() as doc:
                doc.new_page().insert_text((30, 40), "First lecture")
                doc.set_metadata({"title": "First lecture"})
                doc.save(pdf)
            out = root / "_site"
            first = builder.build(root, out)
            self.assertEqual(len(first), 1)
            self.assertEqual(first[0]["pages"], 1)
            self.assertEqual(first[0]["title"], "First lecture")
            with pymupdf.open(pdf) as doc:
                doc.new_page()
                doc.save(root / "updated.pdf")
            (root / "updated.pdf").replace(pdf)
            updated = builder.build(root, out)
            self.assertEqual(updated[0]["id"], first[0]["id"])
            self.assertNotEqual(updated[0]["file"], first[0]["file"])
            self.assertEqual(updated[0]["pages"], 2)
            other = root / "DM" / pdf.name
            other.write_bytes(pdf.read_bytes())
            added = builder.build(root, out)
            self.assertEqual(len(added), 2)
            self.assertEqual(len({x["id"] for x in added}), 2)
            pdf.unlink()
            removed = builder.build(root, out)
            self.assertEqual(len(removed), 1)
            self.assertFalse((out / "MathLog" / pdf.name).exists())
            self.assertEqual((out / "DM" / other.name).read_bytes(), other.read_bytes())
            with self.assertRaises(ValueError):
                builder.build(root, root)


if __name__ == "__main__":
    unittest.main()
