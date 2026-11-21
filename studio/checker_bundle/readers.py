"""
Reads manuscripts that aren't Word files: PDF, OpenDocument (.odt), Rich Text (.rtf) and LaTeX (.tex).

Each reader returns a TextDocument: a list of paragraphs that looks enough like a Word document for the
checks to run on it. Things only a Word file records (tracked changes, comments, line numbering, page
numbering fields, line spacing, hidden text) can't be checked for these formats, so those checks are skipped,
and the report says so.
"""

import io
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

READABLE = (".docx", ".pdf", ".odt", ".rtf", ".tex")


class Run:
    def __init__(self, text, superscript=False, hidden=False):
        self.text = text
        self.font = type("Font", (), {"superscript": superscript, "color": None, "size": None, "hidden": hidden})()


class Paragraph:
    def __init__(self, text, runs=None, style=None):
        self.text = text
        self.runs = runs or []
        self.style = style


class TextDocument:
    """Stands in for a python-docx Document when the manuscript isn't a Word file."""
    is_text_only = True

    def __init__(self, paragraphs, tables=0, author="", kind="", notes=None):
        self.paragraphs = [p if isinstance(p, Paragraph) else Paragraph(p) for p in paragraphs]
        self.tables = [type("Table", (), {"rows": []})() for _ in range(tables)]
        self.core_properties = type("Props", (), {"author": author or "", "last_modified_by": ""})()
        self.sections = []
        self.kind = kind
        self.notes = notes or []      # things the reader couldn't do, for the report


def file_kind(source, name=None):
    """'.docx', '.pdf', … from a file name or path."""
    name = name or (str(source) if isinstance(source, (str, Path)) else getattr(source, "name", "") or "")
    return Path(name).suffix.lower() or ".docx"


def read_bytes(source):
    if isinstance(source, (str, Path)):
        return Path(source).read_bytes()
    data = source.read()
    source.seek(0)
    return data


def runs_to_paragraph(parts):
    """[(text, superscript[, hidden])] -> Paragraph whose runs keep superscripts (read as [1] by step 1)
    and hidden text (white, tiny or hidden font, for the integrity check)."""
    runs = [Run(p[0], p[1], p[2] if len(p) > 2 else False) for p in parts if p[0]]
    return Paragraph("".join(r.text for r in runs), runs)


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------
# First parts of hyphenated compounds that keep their hyphen when split across lines
COMPOUND_STARTS = {"cross", "self", "well", "non", "post", "pre", "co", "multi", "follow", "long", "short", "high", "low",
                   "full", "part", "one", "two", "three", "four", "five", "six", "ten", "time", "needle", "evidence",
                   "population", "community", "hospital", "hand", "small", "large", "case", "peer", "mid", "anti",
                   "inter", "intra", "semi", "sub", "under", "over", "health", "decision", "real", "open", "double",
                   "single", "first", "second", "third", "age", "sex", "gender", "risk", "dose", "drug", "event",
                   "hydroxy", "beta", "alpha", "gamma", "end", "out", "in", "x", "t", "non", "meta", "e", "data",
                   "machine", "deep", "user", "web", "state", "world", "year", "day", "week", "month", "low",
                   "middle", "upper", "lower", "left", "right"}
def _large_image_with_sparse_text(page, extracted_text):
    """Conservative signal: a near-page-size raster plus little selectable text.

    A figure on a normal text page must not be treated as an unreadable scan.
    Unsupported PDF drawing structures are left unclassified, not guessed.
    """
    if len(extracted_text.strip()) > 180:
        return False
    try:
        from pypdf.generic import ContentStream
        stream = ContentStream(page.get_contents(), page.pdf)
        xobjects = page.get('/Resources', {}).get('/XObject', {})
        xobjects = xobjects.get_object() if hasattr(xobjects, 'get_object') else xobjects
        page_area = float(page.mediabox.width) * float(page.mediabox.height)
        if page_area <= 0:
            return False
        matrix = (1., 0., 0., 1., 0., 0.)
        stack = []
        for operands, operator in stream.operations:
            if operator == b'q':
                stack.append(matrix)
            elif operator == b'Q':
                if stack:
                    matrix = stack.pop()
            elif operator == b'cm':
                a,b,c,d,e,f = (float(v) for v in operands)
                A,B,C,D,E,F = matrix
                matrix = (A*a+C*b, B*a+D*b, A*c+C*d, B*c+D*d, A*e+C*f+E, B*e+D*f+F)
            elif operator == b'Do' and operands:
                obj = xobjects.get(operands[0])
                if obj is None:
                    continue
                obj = obj.get_object()
                if obj.get('/Subtype') != '/Image':
                    continue
                a,b,c,d,_,_ = matrix
                image_area = abs(a*d-b*c)
                if image_area / page_area >= 0.60:
                    return True
    except Exception:
        return False
    return False


# Superscript marks after authors' names (Hanieh Rajabzadeh¹, Ali Ghiasi³, Elham Goodarzi⁴˒⁵). Many PDFs, Word's
# among them, store them as separate raised text, so the text comes out one fragment per line:
#     "Hanieh Rajabzadeh" / "1" / ", Kazhaal Sheikhi" / "2" / ...
# and the bare "1" would later be dropped as a page number. Before the first heading of the first page, such pieces
# are put back on one line, so the author line reads as one again.
_MARKS_ONLY = re.compile(r"^\s*(?:\d{1,2}(?:\s*[,–-]\s*\d{1,2})*\s*[*†‡§¶#]*|[*†‡§¶#]+)\s*$")
_GOES_ON = re.compile(r"^\s*(?:[,;&]|and\s)")
_NAME_END = re.compile(r"[A-Z][a-z'’\-]+\s*$")


def _rejoin_author_marks(lines):
    from step1_split_sections import match_section
    out, joined = [], False
    for i, line in enumerate(lines):
        if match_section(Paragraph(line.strip())):
            return out + lines[i:]
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if out and _MARKS_ONLY.match(line) and (joined or _GOES_ON.match(nxt)) \
                and (_NAME_END.search(out[-1]) or joined):
            out[-1] = out[-1].rstrip() + line.strip()          # "Hanieh Rajabzadeh" + "1"
            joined = True
        elif out and joined and _GOES_ON.match(line):
            out[-1] = out[-1].rstrip() + " " + line.strip()    # ... + ", Kazhaal Sheikhi"
        else:
            out.append(line)
            joined = False
    return out


def read_pdf(source):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(read_bytes(source)))
    pages = [(page.extract_text() or "").splitlines() for page in reader.pages]
    if pages:
        pages[0] = _rejoin_author_marks(pages[0])
    # A PDF may have a readable title page followed by scanned/image-only pages.
    # In that case, continuing with manuscript checks would produce false omissions.
    unreadable_image_pages = []
    for page_number, (page, lines_on_page) in enumerate(zip(reader.pages, pages), 1):
        extracted = " ".join(lines_on_page).strip()
        if extracted:
            if _large_image_with_sparse_text(page, extracted):
                unreadable_image_pages.append(page_number)
            continue
        try:
            if page.images:
                unreadable_image_pages.append(page_number)
        except Exception:
            # Failure to inspect images is not proof that a page is scanned.
            pass
    author = ""
    try:
        author = (reader.metadata or {}).get("/Author", "") or ""
    except Exception:
        pass

    # running headers/footers: the same line on most pages, or bare page numbers
    counts = {}
    for lines in pages:
        for line in set(l.strip() for l in lines):
            counts[line] = counts.get(line, 0) + 1
    repeated = {l for l, n in counts.items() if len(pages) >= 3 and n >= len(pages) * 0.6 and len(l) < 120}
    watermark = re.compile(r"(?:for\s+)?peer\s+review(?:\s+only)?|confidential|not\s+for\s+distribution", re.IGNORECASE)
    lines = [l.strip() for page in pages for l in page
             if l.strip() and l.strip() not in repeated and not watermark.fullmatch(l.strip()) and not re.fullmatch(r"(?:page\s*)?\d+(?:\s*(?:of|/)\s*\d+)?", l.strip(), re.I)]

    from step1_split_sections import match_section
    from step5_anonymisation import AUTHOR_LINE, EMAIL, ORCID, front_standalone, institutions_in, looks_like_title
    author_date_entry = re.compile(r"^[A-Z][\w'’\-]+(?: [A-Z][\w'’\-]+)*, (?:[A-Z]\.\s?)+|^[A-Z][\w'’\-]+, [A-Z][a-z]+")
    paragraphs, current = [], ""
    seen_heading, in_references = False, False
    widths = sorted(len(l) for l in lines) or [80]
    typical = widths[int(len(widths) * 0.8)]
    for line in lines:
        section = match_section(Paragraph(line))
        is_heading = section is not None
        if is_heading:
            seen_heading = True
            in_references = section == "References"
        starts_item = bool(re.match(r"^(?:\[?\d+[.)\]]\s|•|[-–]\s|(?:Fig(?:ure)?|Table)\.?\s*\d+[.:])", line))
        if not seen_heading and paragraphs is not None and (AUTHOR_LINE.match(line) and not looks_like_title(line) or EMAIL.search(line)
                                                            or ORCID.search(line) or institutions_in(line)
                                                            or re.match(r"\*?corresponding|running (?:title|head)",
                                                                        line, re.IGNORECASE)):
            starts_item = True             # front page: authors, affiliations and emails are separate lines
        if not seen_heading and not is_heading and front_standalone(line):
            # front page: a journal header, the article type or the authors' names is a paragraph of its own
            if current:
                paragraphs.append(current)
            paragraphs.append(line)
            current = ""
            continue
        letters = re.sub(r"[^A-Za-z]", "", line)
        if len(letters) >= 12 and sum(c.isupper() for c in letters) / len(letters) > 0.9:
            starts_item = True             # a line in capitals is its own paragraph (a heading or a shout)
        if in_references and author_date_entry.match(line):
            starts_item = True             # a new "Surname, I." entry in an author-date reference list
        if is_heading or starts_item:
            if current:
                paragraphs.append(current)
            if is_heading:
                paragraphs.append(line)
                current = ""
            else:
                current = line
            continue
        if not current:
            current = line
        elif current.endswith("-") and not current.endswith(" -"):
            # a word broken at the end of a line: "stu-" + "dents" -> "students", but keep real compounds
            # such as "cross-sectional" or "needle-stick"
            first = re.search(r"([A-Za-z]+)-$", current)
            if first and line[:1].islower() and first.group(1).lower() not in COMPOUND_STARTS:
                current = current[:-1] + line
            else:
                current += line
        else:
            current += " " + line
        if len(line) < typical * 0.7 and re.search(r"[.!?:]$", line):
            paragraphs.append(current)            # a short line ending a sentence ends the paragraph
            current = ""
    if current:
        paragraphs.append(current)
    tables = len({m for p in paragraphs for m in re.findall(r"^Table\.?\s*(\d+)", p)})
    result = TextDocument(paragraphs, tables=tables, author=author, kind="PDF", notes=[
        "Read from a PDF: superscript citations, tracked changes, comments, hidden (white or tiny) text and page "
        "layout can't be checked, and line breaks may split or join paragraphs. Check the Word file if you have it."])
    result.unreadable_image_pages = unreadable_image_pages
    result.page_count = len(reader.pages)
    return result


# ---------------------------------------------------------------------------
# OpenDocument text (.odt)
# ---------------------------------------------------------------------------
ODF = {"text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
       "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
       "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
       "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
       "fo": "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
       "dc": "http://purl.org/dc/elements/1.1/",
       "meta": "urn:oasis:names:tc:opendocument:xmlns:meta:1.0"}


def q(prefix, tag):
    return f"{{{ODF[prefix]}}}{tag}"


def read_odt(source):
    with zipfile.ZipFile(io.BytesIO(read_bytes(source))) as z:
        content = ET.fromstring(z.read("content.xml"))
        styles = ET.fromstring(z.read("styles.xml")) if "styles.xml" in z.namelist() else None
        meta = ET.fromstring(z.read("meta.xml")) if "meta.xml" in z.namelist() else None

    superscript, hidden = set(), set()
    for root in (content, styles):
        if root is None:
            continue
        for st in root.iter(q("style", "style")):
            props = st.find(q("style", "text-properties"))
            if props is None:
                continue
            name = st.get(q("style", "name"))
            if (props.get(q("style", "text-position")) or "").startswith("super"):
                superscript.add(name)
            colour = (props.get(q("fo", "color")) or "").lower()
            size = props.get(q("fo", "font-size")) or ""
            if colour in ("#ffffff", "#fefefe", "#fdfdfd") or props.get(q("text", "display")) == "none" or \
                    (size.endswith("pt") and float(size[:-2] or 99) <= 2):
                hidden.add(name)

    def parts_of(el, sup=False, hid=False):
        parts = []
        if el.text:
            parts.append((el.text, sup, hid))
        for child in el:
            tag = child.tag
            if tag == q("text", "s"):
                parts.append((" " * int(child.get(q("text", "c"), "1")), sup, hid))
            elif tag in (q("text", "tab"), q("text", "line-break")):
                parts.append((" ", sup, hid))
            elif tag == q("text", "note"):
                pass                                          # footnote text is not body text
            else:
                style = child.get(q("text", "style-name"))
                parts.extend(parts_of(child, sup or style in superscript, hid or style in hidden))
            if child.tail:
                parts.append((child.tail, sup, hid))
        return parts

    body = content.find(q("office", "body"))
    # paragraphs inside tables (cells) and footnotes aren't body paragraphs
    inside = {id(p) for container in list(body.iter(q("table", "table"))) + list(body.iter(q("text", "note")))
              for p in container.iter() if p.tag in (q("text", "p"), q("text", "h"))}
    paragraphs = [runs_to_paragraph(parts_of(el)) for el in body.iter()
                  if el.tag in (q("text", "p"), q("text", "h")) and id(el) not in inside]
    tables = len(list(body.iter(q("table", "table"))))
    author = ""
    if meta is not None:
        for tag in (q("meta", "initial-creator"), q("dc", "creator")):
            el = meta.find(f".//{tag}")
            if el is not None and el.text:
                author = el.text
                break
    return TextDocument([p for p in paragraphs if p.text.strip()], tables=tables, author=author, kind="ODT", notes=[
        "Read from an OpenDocument file: tracked changes, comments and page layout aren't checked."])


# ---------------------------------------------------------------------------
# Rich Text Format (.rtf)
# ---------------------------------------------------------------------------
RTF_SKIP = {"fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable", "rsidtbl", "generator", "info",
            "pict", "object", "header", "footer", "headerl", "headerr", "footerl", "footerr", "footnote", "field",
            "fldinst", "xmlnstbl", "themedata", "colorschememapping", "datastore", "latentstyles", "pgdsctbl",
            "mmathPr", "revtbl", "wgrffmtfilter", "listpicture", "pnseclvl"}


def read_rtf(source):
    data = read_bytes(source).decode("latin-1")
    author = re.search(r"\{\\author ([^}]*)\}", data)
    # colour table: which colour numbers are white
    colours = re.search(r"\{\\colortbl\s*;?([^}]*)\}", data)
    white = set()
    if colours:
        for i, entry in enumerate(colours.group(1).split(";"), start=1):
            rgb = [int(x) for x in re.findall(r"\\(?:red|green|blue)(\d+)", entry)]
            if len(rgb) == 3 and min(rgb) >= 240:
                white.add(i)
    paragraphs, parts = [], []
    stack = []                       # (skip, superscript, hidden) for each open group
    skip, sup, uc_skip = False, False, 0
    hid = False
    in_table = False                 # text in table cells isn't body text (as in Word documents)
    i, n = 0, len(data)
    token = re.compile(r"\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|([^\\{}\r\n]+)|[\r\n]")
    pending_star = False
    for m in token.finditer(data):
        word, arg, hexchar, symbol, brace, text = m.groups()
        if brace == "{":
            stack.append((skip, sup, hid))
            pending_star = False
        elif brace == "}":
            skip, sup, hid = stack.pop() if stack else (False, False, False)
        elif skip:
            continue
        elif symbol == "*":
            pending_star = True
        elif word:
            if pending_star or word in RTF_SKIP:
                skip = True
                pending_star = False
            elif word == "pard":
                in_table = False
            elif word == "intbl":
                in_table = True
            elif word in ("cell", "row", "nestcell", "nestrow"):
                parts = []
            elif word in ("par", "line", "sect", "page"):
                if parts and not in_table:
                    paragraphs.append(runs_to_paragraph(parts))
                parts = []
            elif word == "tab":
                parts.append((" ", sup))
            elif word == "super":
                sup = arg != "0"
            elif word in ("nosupersub", "plain"):
                sup = False
                if word == "plain":
                    hid = False
            elif word == "cf":
                hid = int(arg or 0) in white
            elif word == "v":
                hid = arg != "0"
            elif word == "fs" and arg:
                hid = hid or int(arg) <= 4            # font size in half-points: 2 pt or less
            elif word == "u" and arg:
                code = int(arg)
                parts.append((chr(code + 65536 if code < 0 else code), sup))
                uc_skip = 1
            elif word in ("emdash", "endash"):
                parts.append(("—" if word == "emdash" else "–", sup))
            elif word in ("lquote", "rquote"):
                parts.append(("’", sup))
            elif word in ("ldblquote", "rdblquote"):
                parts.append(("“" if word == "ldblquote" else "”", sup))
        elif hexchar:
            if uc_skip:
                uc_skip -= 1
                continue
            parts.append((bytes.fromhex(hexchar).decode("cp1252", errors="replace"), sup))
        elif symbol:
            if symbol in "\\{}":
                parts.append((symbol, sup))
            elif symbol == "~":
                parts.append((" ", sup))
            elif symbol == "-":
                pass
        elif text:
            if uc_skip:
                text = text[uc_skip:]
                uc_skip = 0
            parts.append((text, sup, hid))
    if parts:
        paragraphs.append(runs_to_paragraph(parts))
    paragraphs = [p for p in paragraphs if p.text.strip()]
    for p in paragraphs:
        p.text = " ".join(p.text.split())
    # Word marks the last row of each table with \lastrow; other writers don't, so count at least one table
    tables = data.count("\\lastrow") or (1 if "\\trowd" in data else 0)
    return TextDocument(paragraphs, tables=tables, author=author.group(1) if author else "",
                        kind="RTF", notes=["Read from an RTF file: tracked changes, comments and page layout aren't checked."])


# ---------------------------------------------------------------------------
# LaTeX (.tex)
# ---------------------------------------------------------------------------
def tex_arg(text, start):
    """The {…} argument that starts at text[start] == '{', and where it ends."""
    depth, i = 0, start
    while i < len(text):
        if text[i] == "{" and (i == 0 or text[i - 1] != "\\"):
            depth += 1
        elif text[i] == "}" and text[i - 1] != "\\":
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
        i += 1
    return text[start + 1:], len(text)


def tex_command(text, name):
    m = re.search(rf"\\{name}\*?(?:\[[^\]]*\])?\s*\{{", text)
    return tex_arg(text, m.end() - 1)[0] if m else None


def tex_to_text(t, cite_numbers, labels):
    """LaTeX markup -> plain text, with \\cite as [1,2] and \\ref as the figure/table number."""
    t = re.sub(r"(?<!\\)%.*", "", t)
    t = re.sub(r"\\(?:cite[tp]?|citep|citet|parencite|autocite)\*?(?:\[[^\]]*\])*\{([^}]*)\}",
               lambda m: "[" + ",".join(str(cite_numbers.setdefault(k.strip(), len(cite_numbers) + 1))
                                        for k in m.group(1).split(",")) + "]", t)
    t = re.sub(r"\\(?:auto|c|eq)?ref\{([^}]*)\}", lambda m: str(labels.get(m.group(1), "?")), t)
    t = re.sub(r"\\label\{[^}]*\}", "", t)
    t = re.sub(r"\\textsuperscript\{([\d,\s–-]+)\}", r"[\1]", t)
    t = re.sub(r"\\(?:url|href)\{([^}]*)\}(?:\{([^}]*)\})?", lambda m: m.group(2) or m.group(1), t)
    for _ in range(3):
        t = re.sub(r"\\(?:textbf|textit|emph|textrm|textsf|texttt|underline|textsc|mbox|text|mathrm|mathit|"
                   r"footnotesize|small|large)\{([^{}]*)\}", r"\1", t)
    t = re.sub(r"\\footnote\{[^{}]*\}", "", t)
    t = t.replace("\\%", "%").replace("\\&", "&").replace("\\_", "_").replace("\\#", "#").replace("\\$", "$")
    t = t.replace("``", "“").replace("''", "”").replace("---", "—").replace("--", "–").replace("~", " ")
    t = re.sub(r"\$([^$]*)\$", lambda m: re.sub(r"\\[a-zA-Z]+\s?|[{}^_]", "", m.group(1)), t)
    t = re.sub(r"\\(?:pm)\b", "±", t)
    t = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?", "", t)
    t = t.replace("{", "").replace("}", "").replace("\\\\", " ")
    return " ".join(t.split())


def read_tex(source):
    tex = read_bytes(source).decode("utf-8", errors="replace")
    body = tex.split("\\begin{document}", 1)[-1].split("\\end{document}", 1)[0]
    head = tex.split("\\begin{document}", 1)[0] + body
    cite_numbers, labels, notes = {}, {}, ["Read from LaTeX source: the compiled layout isn't checked."]

    # figure and table numbers, in order, for \ref
    counters = {"figure": 0, "table": 0}
    captions = []
    for env in re.finditer(r"\\begin\{(figure|table)\*?\}([\s\S]*?)\\end\{\1\*?\}", body):
        kind = env.group(1)
        counters[kind] += 1
        for label in re.findall(r"\\label\{([^}]*)\}", env.group(2)):
            labels[label] = counters[kind]
        caption = tex_command(env.group(2), "caption")
        captions.append((kind, counters[kind], caption or ""))
    body = re.sub(r"\\begin\{(figure|table)\*?\}[\s\S]*?\\end\{\1\*?\}", "\n\n", body)

    # bibliography: \bibitem entries are numbered in order; a separate .bib file can't be read
    bibitems = re.findall(r"\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}([\s\S]*?)(?=\\bibitem|\\end\{thebibliography\})", body)
    for i, (key, _) in enumerate(bibitems, start=1):
        cite_numbers[key.strip()] = i
    uses_bib_file = bool(re.search(r"\\(?:bibliography|addbibresource|printbibliography)\b", body)) and not bibitems
    body = re.sub(r"\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}", "", body)

    paragraphs = []
    title = tex_command(head, "title")
    if title:
        paragraphs.append(tex_to_text(title, cite_numbers, labels))
    author = tex_command(head, "author")
    if author:
        paragraphs.append(tex_to_text(re.sub(r"\\(?:and|thanks\{[^}]*\})", ",", author), cite_numbers, labels))
    abstract = re.search(r"\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}", body)
    if abstract:
        paragraphs += ["Abstract", tex_to_text(abstract.group(1), cite_numbers, labels)]
        body = body.replace(abstract.group(0), "")
    keywords = re.search(r"\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}", body) or \
        re.search(r"\\(?:keywords?|IEEEkeywords)\{([^}]*)\}", body)
    if keywords:
        paragraphs.append("Keywords: " + tex_to_text(keywords.group(1).replace("\\sep", ";"), cite_numbers, labels))
        body = body.replace(keywords.group(0), "")
    body = re.sub(r"\\maketitle|\\(?:begin|end)\{(?:itemize|enumerate|description|center|IEEEkeywords)\}", "\n\n", body)
    body = re.sub(r"\\item\s*", "\n\n", body)
    body = re.sub(r"\\(?:section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}", r"\n\n\1\n\n", body)
    for block in re.split(r"\n\s*\n", body):
        text = tex_to_text(block, cite_numbers, labels)
        if text:
            paragraphs.append(text)
    for kind, number, caption in captions:
        paragraphs.append(f"{'Figure' if kind == 'figure' else 'Table'} {number}. "
                          + tex_to_text(caption, cite_numbers, labels))

    paragraphs.append("References")
    if bibitems:
        for i, (key, entry) in enumerate(bibitems, start=1):
            paragraphs.append(f"{i}. " + tex_to_text(entry, cite_numbers, labels))
    elif uses_bib_file:
        for key, number in sorted(cite_numbers.items(), key=lambda kv: kv[1]):
            paragraphs.append(f"{number}. [{key}]")
        notes.append("References are in a separate .bib file, which wasn't uploaded: citations were matched by key, "
                     "but the reference list format wasn't checked.")
    doc = TextDocument(paragraphs, tables=counters["table"], kind="LaTeX", notes=notes)
    doc.references_unavailable = uses_bib_file      # only citation keys, not the entries themselves
    return doc


READERS = {".pdf": read_pdf, ".odt": read_odt, ".rtf": read_rtf, ".tex": read_tex}
