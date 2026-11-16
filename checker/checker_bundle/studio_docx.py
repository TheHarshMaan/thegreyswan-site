"""
Word files for Studio, the writing tool at thegreyswan.in/studio/.

Studio keeps a paper as a list of blocks (headings, paragraphs, list items, captions, tables and the
reference list), each paragraph a list of runs with simple formatting. This module turns that into a
manuscript-style Word file, and reads a Word file back into blocks, so authors can move between
Studio and Word freely. It runs in the browser (Pyodide), like the checker: nothing is uploaded.

A block:   {"t": "h1" | "h2" | "h3" | "p" | "li" | "caption" | "table", ...}
  paragraph-like blocks have "runs": [{"text", "b", "i", "u", "sup", "sub", "blank", "cite"}]
  "li" also has "ordered" (bool); "table" has "rows": [[runs, runs, ...], ...] and "header" (bool)
A paper:   {"title": str, "authors": str, "kind": str, "spacing": "double" | "1.5" | "single", "blocks": [...]}
"""

import json
from pathlib import Path

from docx import Document
from docx.enum.text import WD_COLOR_INDEX, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

STUDIO_WORD = Path("/tmp/studio_paper.docx")
FONT = "Times New Roman"
SPACING = {"double": 2.0, "1.5": 1.5, "single": 1.0}


# ---------------------------------------------------------------------------
# Studio -> Word
# ---------------------------------------------------------------------------

def _style_document(doc, spacing):
    normal = doc.styles["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(12)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    pf = normal.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.line_spacing = SPACING.get(spacing, 2.0)
    pf.space_after = Pt(0)
    for name, size in (("Title", 16), ("Heading 1", 14), ("Heading 2", 12), ("Heading 3", 12)):
        st = doc.styles[name]
        st.font.name = FONT
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.italic = name == "Heading 3"
        st.font.color.rgb = RGBColor(0, 0, 0)
        rpr = st.element.get_or_add_rPr()
        fonts = rpr.find(qn("w:rFonts"))
        if fonts is None:
            fonts = OxmlElement("w:rFonts")
            rpr.append(fonts)
        for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
            fonts.set(qn(attr), FONT)
        for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
            fonts.attrib.pop(qn(attr), None)
        st.paragraph_format.space_before = Pt(12)
        st.paragraph_format.space_after = Pt(6)
    for section in doc.sections:
        section.left_margin = section.right_margin = Cm(2.54)
        section.top_margin = section.bottom_margin = Cm(2.54)
        _page_numbers(section)


def _page_numbers(section):
    """A centred page number in the footer: journals ask for numbered pages."""
    para = section.footer.paragraphs[0] if section.footer.paragraphs else section.footer.add_paragraph()
    para.alignment = 1
    run = para.add_run()
    for kind, text in (("begin", None), (None, "PAGE"), ("end", None)):
        if kind:
            el = OxmlElement("w:fldChar")
            el.set(qn("w:fldCharType"), kind)
        else:
            el = OxmlElement("w:instrText")
            el.set(qn("xml:space"), "preserve")
            el.text = text
        run._r.append(el)


def _add_runs(para, runs):
    for r in runs or []:
        text = str(r.get("text", ""))
        if not text:
            continue
        if r.get("blank"):
            text = f"[{text}]"
        run = para.add_run(text)
        run.bold = bool(r.get("b")) or None
        run.italic = bool(r.get("i")) or None
        run.underline = bool(r.get("u")) or None
        if r.get("sup") or r.get("cite"):
            run.font.superscript = True
        elif r.get("sub"):
            run.font.subscript = True
        if r.get("blank"):
            run.font.highlight_color = WD_COLOR_INDEX.YELLOW


def _plain(runs):
    return "".join(str(r.get("text", "")) for r in runs or [])


def build_word(paper):
    doc = Document()
    _style_document(doc, paper.get("spacing", "double"))
    if paper.get("kind"):
        kind = doc.add_paragraph()
        k = kind.add_run(paper["kind"].upper())
        k.font.size = Pt(10)
    if not paper.get("noTitle"):                   # a cover letter has no title
        doc.add_paragraph(paper.get("title") or "Untitled paper", style="Title")
    if paper.get("authors"):
        doc.add_paragraph(paper["authors"])
    for block in paper.get("blocks", []):
        t = block.get("t")
        if t in ("h1", "h2", "h3"):
            level = {"h1": 1, "h2": 1, "h3": 2}[t]
            para = doc.add_heading(level=level)
            _add_runs(para, block.get("runs"))
        elif t == "li":
            para = doc.add_paragraph(style="List Number" if block.get("ordered") else "List Bullet")
            _add_runs(para, block.get("runs"))
        elif t == "caption":
            para = doc.add_paragraph()
            _add_runs(para, block.get("runs"))
            para.paragraph_format.keep_with_next = True
        elif t == "table":
            rows = block.get("rows") or []
            if not rows:
                continue
            cols = max(len(r) for r in rows)
            table = doc.add_table(rows=len(rows), cols=cols)
            table.style = "Table Grid"
            for i, row in enumerate(rows):
                for j in range(cols):
                    cell = table.cell(i, j)
                    cell.paragraphs[0].paragraph_format.line_spacing = 1.0
                    runs = row[j] if j < len(row) else []
                    if i == 0 and block.get("header"):
                        runs = [dict(r, b=True) for r in runs]
                    _add_runs(cell.paragraphs[0], runs)
            doc.add_paragraph()
        else:
            if not _plain(block.get("runs")).strip():
                if paper.get("keepBlank"):
                    doc.add_paragraph()
                continue
            para = doc.add_paragraph()
            _add_runs(para, block.get("runs"))
    return doc


def export_word(paper_json):
    """Studio's paper (JSON) -> the path of a Word file."""
    build_word(json.loads(paper_json)).save(STUDIO_WORD)
    return str(STUDIO_WORD)


# ---------------------------------------------------------------------------
# Word -> Studio
# ---------------------------------------------------------------------------

def _runs_of(paragraph):
    out = []
    for run in paragraph.runs:
        if not run.text:
            continue
        r = {"text": run.text}
        if run.bold:
            r["b"] = True
        if run.italic:
            r["i"] = True
        if run.underline:
            r["u"] = True
        if run.font.superscript:
            r["sup"] = True
        elif run.font.subscript:
            r["sub"] = True
        if run.font.highlight_color is not None and run.text.startswith("[") and run.text.endswith("]") and len(run.text) > 2:
            r = {"text": run.text[1:-1], "blank": True}          # a detail still to fill in, as Studio exported it
        if out and {k: v for k, v in out[-1].items() if k != "text"} == {k: v for k, v in r.items() if k != "text"}:
            out[-1]["text"] += r["text"]          # Word splits runs freely; join neighbours that look the same
        else:
            out.append(r)
    return out


def _is_list(paragraph):
    style = (paragraph.style.name or "").lower() if paragraph.style is not None else ""
    if style.startswith("list"):
        return True, "number" in style
    ppr = paragraph._p.pPr
    return (ppr is not None and ppr.numPr is not None), False


def read_word(path):
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(path)
    paper = {"title": "", "authors": "", "kind": "", "blocks": []}
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:tbl"):
            table = Table(child, doc)
            rows = [[_runs_of(cell.paragraphs[0]) if cell.paragraphs else [] for cell in row.cells] for row in table.rows]
            paper["blocks"].append({"t": "table", "rows": rows, "header": True})
            continue
        if child.tag != qn("w:p"):
            continue
        para = Paragraph(child, doc)
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name or "") if para.style is not None else ""
        if style == "Title" and not paper["title"]:
            paper["title"] = text
            if paper["blocks"] and len(paper["blocks"]) == 1 and paper["blocks"][0]["t"] == "p":
                first = "".join(r["text"] for r in paper["blocks"][0]["runs"]).strip()
                if first.isupper() and len(first) < 60:            # Studio's paper-type line, e.g. ORIGINAL RESEARCH
                    paper["kind"] = first.capitalize()
                    paper["blocks"].pop(0)
            continue
        runs = _runs_of(para)
        if style.startswith("Heading"):
            level = style.replace("Heading", "").strip()
            paper["blocks"].append({"t": "h2" if level in ("", "1") else "h3", "runs": runs})
            continue
        is_list, ordered = _is_list(para)
        if is_list:
            paper["blocks"].append({"t": "li", "ordered": ordered, "runs": runs})
        elif text.lower().startswith(("figure ", "fig. ", "table ")) and len(text) < 300 and runs and runs[0].get("b"):
            paper["blocks"].append({"t": "caption", "runs": runs})
        else:
            paper["blocks"].append({"t": "p", "runs": runs})
    if not paper["title"]:                         # no Title style: take a short, first bold or large paragraph
        first = paper["blocks"][0] if paper["blocks"] else None
        if first and first["t"] in ("p", "h2") and len("".join(r["text"] for r in first["runs"])) < 250:
            paper["title"] = "".join(r["text"] for r in first["runs"]).strip()
            paper["blocks"].pop(0)
    return paper


def import_word(path):
    """A Word file -> Studio's paper (JSON)."""
    return json.dumps(read_word(path), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Spreadsheets -> rows, for Studio's Table 1 and privacy scan (CSV files are read in the page itself)
# ---------------------------------------------------------------------------

MAX_ROWS = 50000


def read_sheet(path, sheet=None):
    """The first (or named) sheet of an Excel file as rows of plain values. Dates become YYYY-MM-DD."""
    import datetime
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet] if sheet and sheet in wb.sheetnames else wb.worksheets[0]
    rows = []
    for row in ws.iter_rows(values_only=True):
        out = []
        for v in row:
            if isinstance(v, datetime.datetime):
                v = v.date().isoformat() if v.time() == datetime.time() else v.isoformat(sep=" ")
            elif isinstance(v, datetime.date):
                v = v.isoformat()
            elif v is None:
                v = ""
            elif isinstance(v, float) and v.is_integer():
                v = int(v)
            out.append(v)
        while out and out[-1] == "":
            out.pop()
        if any(str(c).strip() for c in out):
            rows.append(out)
        if len(rows) > MAX_ROWS:
            break
    width = max((len(r) for r in rows), default=0)
    rows = [r + [""] * (width - len(r)) for r in rows]
    return {"sheets": wb.sheetnames, "sheet": ws.title, "rows": rows, "truncated": len(rows) > MAX_ROWS}


def sheet_rows(path, sheet=""):
    return json.dumps(read_sheet(path, sheet or None), ensure_ascii=False, default=str)
