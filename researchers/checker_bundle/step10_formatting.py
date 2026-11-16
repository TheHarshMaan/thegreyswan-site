"""
Manuscript Checker - formatting and mechanics

Always checked (advisory):
  - US and UK spellings mixed (randomized / randomised, tumor / tumour…)
  - p-values written as "p = 0.000" (should be p < 0.001)
  - sentences that start with a numeral ("45 patients were…")

Checked when the profile asks for them (settings in profiles/*.yaml):
  - word, reference and figure/table limits for each article type (settings -> limits)
  - title length (title_max_words), running title (require_running_title)
  - structured or unstructured abstract, with the journal's headings (abstract_structure, abstract_headings)
  - number of keywords (keywords: min / max)
  - highlights or key points (require_highlights, highlights: min / max / max_chars)
  - line numbers, double spacing, page numbers (require_line_numbers, require_double_spacing, require_page_numbers)
  - p-values with or without a leading zero (p_value_style), US or UK spelling (spelling)

How to run (in a terminal, from this folder):
    python step10_formatting.py my_manuscript.docx
"""

import re
import sys

from step1_split_sections import split_into_sections
from step4_declarations import article_type, split_sentences
from step5_anonymisation import AUTHOR_LINE, EMAIL, ORCID, institutions_in, looks_like_title

I = re.IGNORECASE

# Sections that don't count towards the main text word count
NOT_MAIN_TEXT = {"Abstract", "Keywords", "Highlights", "References", "Acknowledgements", "Funding",
                 "Conflict of interest", "Author contributions", "Data availability", "Consent", "Ethics"}
CAPTION = re.compile(r"^(?:Fig(?:ure)?s?|Table|Supplementary)\.?\s*[S\d]", I)

# (US, UK) spelling patterns, matched as lower-case words so proper nouns ("Erasmus Medical Center") don't count
US_UK = [
    # stems that only ever start these words
    (r"tumor\w*", r"tumour\w*"), (r"behavior\w*", r"behaviour\w*"), (r"hemoglobin\w*", r"haemoglobin\w*"),
    (r"pediatric\w*", r"paediatric\w*"), (r"anemi\w*", r"anaemi\w*"), (r"estrogen\w*", r"oestrogen\w*"),
    (r"fetus(?:es)?", r"foetus(?:es)?"), (r"esophag\w*", r"oesophag\w*"), (r"edema\w*", r"oedema\w*"),
    (r"leukemi\w*", r"leukaemi\w*"), (r"diarrhea\w*", r"diarrhoea\w*"), (r"gynecolog\w*", r"gynaecolog\w*"),
    (r"orthopedic\w*", r"orthopaedic\w*"), (r"glycemi\w*", r"glycaemi\w*"), (r"ischemi\w*", r"ischaemi\w*"),
    (r"hematolog\w*", r"haematolog\w*"), (r"cesarean\w*", r"caesarean\w*"), (r"anesthe\w*", r"anaesthe\w*"),
    (r"feces", r"faeces"), (r"hemorrhag\w*", r"haemorrhag\w*"),
    # whole words
    (r"colou?r(?<!colour)(?:s|ed|ing|ful)?", r"colour(?:s|ed|ing|ful)?"), (r"center(?:s|ed)?", r"centre(?:s|d)?"),
    (r"labeled|labeling", r"labelled|labelling"), (r"modeled|modeling", r"modelled|modelling"),
    (r"traveled|traveling", r"travelled|travelling"), (r"favor(?:s|ed|ing|able|ably|ite|ites)?",
                                                       r"favour(?:s|ed|ing|able|ably|ite|ites)?"),
    (r"labor(?:s|ed|ing|er|ers)?", r"labour(?:s|ed|ing|er|ers)?"), (r"gray", r"grey"),
    (r"aluminum", r"aluminium"), (r"fibers?", r"fibres?"), (r"liters?", r"litres?"), (r"defense", r"defence"),
    (r"analogs?", r"analogues?"), (r"catalog(?:s|ed|ing)?", r"catalogue(?:s|d)?"), (r"enrollments?", r"enrolments?"),
    (r"fulfill(?:s|ment)?", r"fulfil(?:s|ment)?"), (r"skeptic(?:al|ism)?", r"sceptic(?:al|ism)?"),
    (r"aging", r"ageing"),
]
# -ize / -ise verbs that are spelled differently (words like "size" or "exercise" are the same everywhere)
IZE_STEMS = ("randomi", "organi", "characteri", "recogni", "minimi", "maximi", "optimi", "utili", "standardi",
             "normali", "categori", "summari", "emphasi", "hospitali", "immuni", "visuali", "conceptuali", "generali",
             "stabili", "neutrali", "sterili", "homogeni", "prioriti", "speciali", "reali", "finali", "mobili",
             "personali", "symboli", "critici", "locali", "operationali", "contextuali", "digiti", "authori")
IZE = re.compile(r"\b(" + "|".join(IZE_STEMS) + r")(z|s)(e|es|ed|ing|ation|ations|er|ers)\b")
ANALYZE = re.compile(r"\banaly(z|s)(e|es|ed|ing|er|ers)\b")

ABSTRACT_LABEL = (r"Background|Introduction|Context|Importance|Objectives?|Aims?|Purpose|Design|Setting|Participants|"
                  r"Methods?|Materials and methods|Methods and analysis|Interventions?|Exposures?|Main outcomes? and measures?|"
                  r"Measurements?|Results?|Findings|Conclusions?(?: and relevance)?|Interpretation|Limitations|"
                  r"Trial registration|Funding|Ethics and dissemination|Case presentation|Discussion")


def words(text):
    return len(re.findall(r"\b[\w'’-]+\b", text))


def front_lines(sections):
    return [t for name, paras in sections if name == "Front matter" for t in paras]


def main_text(sections):
    """The main text: everything except the title page, abstract, keywords, declarations, references and captions."""
    out = []
    for name, paras in sections:
        if name in NOT_MAIN_TEXT:
            continue
        for i, t in enumerate(paras):
            if CAPTION.match(t):
                continue
            if name == "Front matter":
                if i == 0 or AUTHOR_LINE.match(t) and not looks_like_title(t) or EMAIL.search(t) or ORCID.search(t) or institutions_in(t) \
                        or re.search(r"corresponding author|running (?:title|head)|short title|word count", t, I) \
                        or len(t) < 40:
                    continue
            out.append(t)
    return out


def figures_and_tables(sections, doc):
    numbers = {"Figure": set(), "Table": set()}
    for _, paras in sections:
        for t in paras:
            m = re.match(r"^(Fig(?:ure)?|Table)\.?\s*(\d+)", t, I)
            if m:
                numbers["Table" if m.group(1).lower().startswith("tab") else "Figure"].add(int(m.group(2)))
    tables = max(len(numbers["Table"]), len(getattr(doc, "tables", []) or []))
    return len(numbers["Figure"]) + tables


# ---------------------------------------------------------------------------
# Reading layout from the Word file
# ---------------------------------------------------------------------------
def has_line_numbers(doc):
    try:
        from docx.oxml.ns import qn
        return any(s._sectPr.find(qn("w:lnNumType")) is not None for s in doc.sections)
    except Exception:
        return None


def line_spacing(doc):
    """The usual line spacing of the body text (1.0 = single, 2.0 = double), or None if it can't be read."""
    try:
        from docx.shared import Length
        normal = next((st for st in doc.styles if getattr(st, "name", "") == "Normal"), None)
        default = normal.paragraph_format.line_spacing if normal is not None else None
        values = []
        for p in doc.paragraphs:
            if not p.text.strip() or (p.style is not None and p.style.name.lower().startswith("heading")):
                continue
            value = p.paragraph_format.line_spacing
            if value is None and p.style is not None:
                value = p.style.paragraph_format.line_spacing
            value = default if value is None else value
            if isinstance(value, Length):        # exact spacing in points: compare with a 12 pt line
                value = value.pt / 12
            values.append(1.0 if value is None else float(value))
        return sorted(values)[len(values) // 2] if values else None
    except Exception:
        return None


def has_page_numbers(doc):
    try:
        for section in doc.sections:
            for part in (section.footer, section.header, section.first_page_footer, section.first_page_header):
                xml = part._element.xml if part is not None else ""
                if re.search(r'instr="\s*PAGE\b|<w:instrText[^>]*>\s*PAGE\b', xml):
                    return True
        return False
    except Exception:
        return None


# ---------------------------------------------------------------------------
# The checks
# ---------------------------------------------------------------------------
def check_formatting(sections, doc=None, settings=None):
    """Returns (section, check, status, details, rule ID) tuples."""
    s = settings or {}
    issues = []
    kind = article_type(sections)
    front = front_lines(sections)
    title = front[0] if front else ""
    main = main_text(sections)
    checked_text = " ".join(t for name, paras in sections
                            if name not in ("References", "Author contributions") for t in paras)

    # --- Limits for this article type
    limits = (s.get("limits") or {}).get(kind) or {}
    kind_name = {"research": "research article", "methods": "methods article", "protocol": "study protocol",
                 "narrative review": "review"}.get(kind, kind)
    if limits.get("words"):
        count = words(" ".join(main))
        if count > limits["words"]:
            issues.append(("Formatting", "Word count", "Concern",
                           f"Main text is about {count} words; the limit for a {kind_name} is {limits['words']}", "word_limit"))
    refs = [t for name, paras in sections if name == "References" for t in paras]
    if limits.get("references") and len(refs) > limits["references"]:
        issues.append(("Formatting", "Number of references", "Concern",
                       f"{len(refs)} references; the limit for a {kind_name} is {limits['references']}", "reference_limit"))
    if limits.get("figures_tables"):
        n = figures_and_tables(sections, doc)
        if n > limits["figures_tables"]:
            issues.append(("Formatting", "Number of figures and tables", "Concern",
                           f"{n} figures and tables; the limit for a {kind_name} is {limits['figures_tables']}",
                           "figure_table_limit"))

    # --- Title and running title
    if s.get("title_max_words") and words(title) > s["title_max_words"]:
        issues.append(("Formatting", "Title length", "Concern",
                       f"The title is {words(title)} words; this journal's limit is {s['title_max_words']}", "title_length"))
    if s.get("require_running_title") and not re.search(r"running (?:title|head)|short title", " ".join(front), I):
        issues.append(("Formatting", "Running title", "Missing", "No running title (short title) on the title page",
                       "running_title"))

    # --- Abstract: structured or not, and its headings
    abstract = " ".join(t for name, paras in sections if name == "Abstract" for t in paras)
    wanted = s.get("abstract_structure", "any")
    if abstract and wanted in ("structured", "unstructured"):
        labels = re.findall(rf"(?:^|(?<=[.\s]))({ABSTRACT_LABEL})\s*:", abstract, I)
        structured = len(labels) >= 3
        if wanted == "unstructured" and structured:
            issues.append(("Formatting", "Abstract structure", "Concern",
                           f"This journal uses an unstructured abstract (one paragraph), but the abstract has headings "
                           f"({', '.join(labels[:4])})", "abstract_structure"))
        elif wanted == "structured":
            headings = s.get("abstract_headings") or []
            found = {l.lower() for l in labels}
            missing = [h for h in headings if not any(re.fullmatch(rf"{re.escape(h.lower())}s?", f) or f == h.lower()
                                                      for f in found)]
            if not structured:
                issues.append(("Formatting", "Abstract structure", "Missing",
                               "This journal uses a structured abstract with headings"
                               + (f" ({', '.join(headings)})" if headings else ""), "abstract_structure"))
            elif missing:
                issues.append(("Formatting", "Abstract structure", "Concern",
                               f"Abstract headings missing: {', '.join(missing)}", "abstract_structure"))

    # --- Keywords
    kw_rule = s.get("keywords") or {}
    keywords = " ".join(t for name, paras in sections if name == "Keywords" for t in paras)
    if keywords and (kw_rule.get("min") or kw_rule.get("max")):
        n = len([k for k in re.split(r"[;,·•]|\s{2,}", keywords) if k.strip()])
        if kw_rule.get("min") and n < kw_rule["min"] or kw_rule.get("max") and n > kw_rule["max"]:
            issues.append(("Formatting", "Number of keywords", "Concern",
                           f"{n} keywords; this journal asks for {kw_rule.get('min') or 1}–{kw_rule.get('max') or 'any'}",
                           "keyword_count"))

    # --- Highlights / key points
    highlights = [t for name, paras in sections if name == "Highlights" for t in paras]
    h_rule = s.get("highlights") or {}
    if s.get("require_highlights") and not highlights:
        issues.append(("Formatting", "Highlights", "Missing", "No Highlights or Key Points section", "highlights"))
    elif highlights and h_rule:
        problems = []
        if h_rule.get("min") and len(highlights) < h_rule["min"] or h_rule.get("max") and len(highlights) > h_rule["max"]:
            problems.append(f"{len(highlights)} points (asks for {h_rule.get('min', 1)}–{h_rule.get('max', 'any')})")
        if h_rule.get("max_chars"):
            long = [h for h in highlights if len(h) > h_rule["max_chars"]]
            if long:
                problems.append(f"{len(long)} longer than {h_rule['max_chars']} characters")
        if problems:
            issues.append(("Formatting", "Highlights", "Concern", "Highlights: " + "; ".join(problems), "highlights"))

    # --- Layout read from the Word file
    if doc is not None and not getattr(doc, "is_text_only", False):
        if s.get("require_line_numbers") and has_line_numbers(doc) is False:
            issues.append(("Formatting", "Line numbers", "Missing", "Line numbering is not switched on", "line_numbers"))
        if s.get("require_double_spacing"):
            spacing = line_spacing(doc)
            if spacing is not None and spacing < 1.9:
                issues.append(("Formatting", "Line spacing", "Concern",
                               f"The text is {'single' if spacing < 1.3 else f'{spacing:.1f}'}-spaced; this journal "
                               "asks for double spacing", "line_spacing"))
        if s.get("require_page_numbers") and has_page_numbers(doc) is False:
            issues.append(("Formatting", "Page numbers", "Missing", "No page numbers in the header or footer", "page_numbers"))

    # --- p-values
    pvalues = re.findall(r"\b[pP]\s*(?:-?value)?\s*([=<>≤≥])\s*(0?\.\d+)", checked_text)
    problems = []
    zero = [f"p {op} {v}" for op, v in pvalues if re.fullmatch(r"0?\.0+", v)]
    if zero:
        problems.append(f"“{zero[0]}” should be reported as p < 0.001")
    style = s.get("p_value_style", "any")
    if style == "no_leading_zero":
        bad = [f"p {op} {v}" for op, v in pvalues if v.startswith("0.")]
        if bad:
            problems.append(f"no zero before the decimal point (p = .03, not “{bad[0]}”)")
    elif style == "leading_zero":
        bad = [f"p {op} {v}" for op, v in pvalues if v.startswith(".")]
        if bad:
            problems.append(f"a zero before the decimal point (p = 0.03, not “{bad[0]}”)")
    if problems:
        issues.append(("Formatting", "p-values", "Concern", "p-values: " + "; ".join(problems), "p_value_format"))

    # --- US and UK spelling
    us, uk = [], []
    for a, b in US_UK:
        us += re.findall(rf"\b(?:{a})\b", checked_text)
        uk += re.findall(rf"\b(?:{b})\b", checked_text)
    for m in IZE.finditer(checked_text):
        (us if m.group(2).lower() == "z" else uk).append(m.group(0).lower())
    for m in ANALYZE.finditer(checked_text):
        (us if m.group(1).lower() == "z" else uk).append(m.group(0).lower())
    us = list(dict.fromkeys(us))
    uk = list(dict.fromkeys(uk))
    spelling = s.get("spelling", "any")
    if spelling == "us" and uk:
        issues.append(("Formatting", "Spelling", "Concern", f"This journal uses US spelling; UK spellings found: "
                       f"{', '.join(uk[:5])}", "spelling_consistency"))
    elif spelling == "uk" and us:
        issues.append(("Formatting", "Spelling", "Concern", f"This journal uses UK spelling; US spellings found: "
                       f"{', '.join(us[:5])}", "spelling_consistency"))
    elif spelling == "any" and us and uk:
        issues.append(("Formatting", "Spelling", "Concern", f"US and UK spellings are mixed (US: {', '.join(us[:3])}; "
                       f"UK: {', '.join(uk[:3])})", "spelling_consistency"))

    # --- Sentences starting with a numeral
    starts = []
    for name, paras in sections:
        if name in ("References", "Front matter", "Keywords"):
            continue
        for t in paras:
            if CAPTION.match(t) or re.match(r"^\d+(?:\.\d+)+\.?\s", t) or (len(t) < 60 and not re.search(r"[.!?]$", t)):
                continue          # captions, numbered subheadings ("2.1 Statistical analysis") and other headings
            for sentence in split_sentences(t):
                # "45 patients were…" (a numbered heading like "10 Declaration of…" starts with a capital)
                if re.match(r"^\d[\d,.]*\s*(?:%|[a-z])", sentence):
                    starts.append(sentence)
    if starts:
        issues.append(("Formatting", "Numbers starting sentences", "Concern",
                       f"{len(starts)} sentence(s) start with a numeral, e.g. “{starts[0][:50]}…”; write the number in "
                       "words or reword", "number_sentence_start"))
    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python step10_formatting.py <manuscript.docx>")
        return
    try:
        sections, doc = split_into_sections(sys.argv[1])
    except Exception as e:
        print(f"Could not read '{sys.argv[1]}': {e}")
        return
    print(f"\nFile: {sys.argv[1]}\nMain text: about {words(' '.join(main_text(sections)))} words; "
          f"line spacing {line_spacing(doc)}; line numbers {has_line_numbers(doc)}; page numbers {has_page_numbers(doc)}\n")
    for section, check, status, details, _rule in check_formatting(sections, doc):
        print(f"[{status}] {check}: {details}")


if __name__ == "__main__":
    main()
