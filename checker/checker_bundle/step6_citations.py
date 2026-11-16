"""
Manuscript Checker - citations and reference styles

Works for both citation systems:
  numbered     [1], [2,3] or superscripts¹ (AMA, Vancouver, IEEE)
  author-date  (Smith, 2020), Smith and Jones (2019) (APA, Harvard)

Checks for every manuscript:
  - every citation is in the reference list, and every listed reference is cited
  - numbered references are first cited in order (1, 2, 3…)
  - author-date reference lists are in alphabetical order
  - the two systems aren't mixed
  - how many references are old (advisory)

When the profile names a style (settings -> citation_style), also:
  - the manuscript uses that style's system (numbered or author-date)
  - in-text citations are written the style's way (e.g. APA's "&" inside brackets, AMA superscripts)
  - reference list entries follow the style's pattern

How to run (in a terminal, from this folder):
    python step6_citations.py my_manuscript.docx [apa|harvard|ama|vancouver|ieee]
"""

import re
import sys
from datetime import date

from step1_split_sections import split_into_sections

NUMBERED_STYLES = {"ama": "AMA", "vancouver": "Vancouver", "ieee": "IEEE"}
AUTHOR_DATE_STYLES = {"apa": "APA", "harvard": "Harvard"}

YEAR = r"(?:19|20)\d{2}[a-z]?|n\.d\.|in press|forthcoming"
NUMBERED_ENTRY = re.compile(r"^\s*\[?\d+[.)\]]?\s")
# Capitalised words that come before a year in brackets but aren't authors: "(January 2020)", "(Phase 2021)"
NOT_AUTHORS = {"january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
               "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
               "nov", "dec", "in", "since", "from", "between", "during", "until", "before", "after", "by",
               "version", "accessed", "retrieved", "data", "year", "years", "fall", "spring", "summer", "winter",
               "phase", "wave", "round", "census", "survey", "table", "figure", "fig", "appendix", "supplementary",
               "mean", "median", "total", "age", "aged", "up", "as", "of", "at", "the", "end", "early", "late",
               "mid", "fy", "q1", "q2", "q3", "q4", "covid", "established", "founded", "published", "updated"}


def short(text, limit=70):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def listing(items, limit=6):
    items = list(items)
    more = f" and {len(items) - limit} more" if len(items) > limit else ""
    return ", ".join(map(str, items[:limit])) + more


# ---------------------------------------------------------------------------
# Reading citations
# ---------------------------------------------------------------------------
def numbered_citations(text):
    """Numbers cited as [1], [2,3], [4–6], in order of appearance (superscripts were turned into [..] by step 1)."""
    found = []
    for group in re.findall(r"\[([\d,\s–\-]+)\]", text):
        for part in re.split(r"\s*,\s*", group):
            rng = re.match(r"(\d+)\s*[–-]\s*(\d+)", part)
            if rng and int(rng.group(2)) - int(rng.group(1)) < 50:
                found.extend(range(int(rng.group(1)), int(rng.group(2)) + 1))
            elif part.strip().isdigit():
                found.append(int(part.strip()))
    return found


def first_word(author):
    m = re.match(r"\s*([^\s,.;()\[\]]+)", author)
    return m.group(1).lower() if m else ""


def looks_like_author(author):
    author = author.strip()
    return (bool(re.match(r"[A-Z]", author)) and not re.search(r"\d", author) and len(author.split()) <= 10
            and first_word(author) not in NOT_AUTHORS)


def author_date_citations(text):
    """Author-date citations: [(first author word, year, how it was written, kind)], kind = 'bracket' or 'narrative'."""
    found = []
    # In brackets: (Smith, 2020), (Smith & Lee, 2019a; WHO, 2021), (e.g., Smith 2020, p. 4)
    for m in re.finditer(r"\(([^()]{2,300})\)", text):
        for part in m.group(1).split(";"):
            part = re.sub(r"^\s*(?:e\.g\.,?|i\.e\.,?|see also|see|cf\.|for example,?|reviewed in)\s+", "", part.strip(),
                          flags=re.IGNORECASE)
            pm = re.match(rf"^(?P<auth>[^\d()]+?)(?P<comma>\s*,)?\s+(?P<years>(?:{YEAR})(?:\s*,\s*(?:{YEAR}))*)"
                          rf"(?:\s*,\s*(?:(?:p|pp|para|chap|ch)\.?\s*)?[\divxlc][\w\-–]*)?\s*$", part)
            if pm and looks_like_author(pm.group("auth")):
                for y in re.findall(YEAR, pm.group("years")):
                    found.append((first_word(pm.group("auth")), y, part.strip(), "bracket",
                                  bool(pm.group("comma")), pm.group("auth")))
    # In the sentence: Smith (2020), Smith and Lee (2019), Smith et al. (2018a)
    for m in re.finditer(rf"(?P<auth>(?:(?:van|von|de|der|da|del|di|du|le|la)\s+)*[A-Z][A-Za-z'’\-]+"
                         rf"(?:\s+(?:&|and)\s+[A-Z][A-Za-z'’\-]+|\s+et\s+al\.?)?)\s+\((?P<years>(?:{YEAR})"
                         rf"(?:\s*,\s*(?:{YEAR}))*)(?:\s*,\s*(?:(?:p|pp)\.?\s*)?[\divxlc][\w\-–]*)?\)", text):
        if looks_like_author(m.group("auth")):
            for y in re.findall(YEAR, m.group("years")):
                found.append((first_word(m.group("auth")), y, m.group(0), "narrative", True, m.group("auth")))
    return found


def entry_key(entry):
    """(first author word, year) for one reference list entry."""
    text = NUMBERED_ENTRY.sub("", entry, count=1)
    year = re.search(rf"\((?P<y>{YEAR})[,)]", text) or re.search(r"\b(?P<y>(?:19|20)\d{2}[a-z]?)\b", text)
    return first_word(text), (year.group("y") if year else None)


def surname(entry):
    """The first author's surname (or organisation) as written, for messages."""
    text = NUMBERED_ENTRY.sub("", entry, count=1)
    return short(re.split(r",|\.\s|\s\(", text)[0].strip(), 40)


def entry_year(entry):
    m = re.search(r"\b((?:19|20)\d{2})", NUMBERED_ENTRY.sub("", entry, count=1))
    return int(m.group(1)) if m else None


def superscript_and_bracket_counts(doc):
    """How many citations are written as superscripts, and how many in [square brackets]."""
    sup = br = 0
    if doc is None:
        return 0, 0
    for p in doc.paragraphs:
        for run in p.runs:
            if run.font.superscript and re.fullmatch(r"\s*\d+(?:\s*[,–-]\s*\d+)*\s*", run.text or ""):
                sup += 1
        br += len(re.findall(r"\[\d+(?:\s*[,–-]\s*\d+)*\]", p.text))
    return sup, br


# ---------------------------------------------------------------------------
# Reference list formats, one function per style. Each returns {problem: [entry numbers]}.
# ---------------------------------------------------------------------------
def authors_block(entry):
    """The authors at the start of a numbered (AMA/Vancouver) entry: everything up to the first '. '."""
    m = re.match(r"^\s*\[?\d+[.)\]]?\s+(.*?)\.\s", entry)
    return m.group(1) if m else ""


def apa_problems(entry):
    out = []
    head = re.match(rf"^(?P<authors>[^()]{{1,400}}?)\((?P<y>{YEAR})(?:,\s*[A-Z][a-z]+(?:\s\d{{1,2}}(?:[–-]\d{{1,2}})?)?)?\)\.",
                    entry)
    if not head:
        out.append("year in brackets straight after the authors, e.g. Smith, J. A. (2020).")
    authors = head.group("authors") if head else entry[:200]
    if re.match(r"^[A-Z][\w'’\-]+ [A-Z]{1,3}[,.]", entry):
        out.append("authors written as Surname, I. I. (e.g. Davey, P.), not Davey P")
    elif re.search(r",\s*and\s|\s+and\s+[A-Z][\w'’\-]+,\s*[A-Z]\.", authors) and "&" not in authors:
        out.append("“&” before the last author, not “and”")
    if re.search(r"\bdoi:\s?10\.", entry, re.IGNORECASE):
        out.append("DOIs written as https://doi.org/10…, not doi:10…")
    return out


def harvard_problems(entry):
    if not re.match(rf"^[^()]{{1,400}}?\((?:{YEAR})\)", entry):
        return ["year in brackets after the authors, e.g. Smith, J. (2020)"]
    return []


def vancouver_problems(entry, ama=False):
    out = []
    authors = authors_block(entry)
    if re.match(r"^\s*\[?\d+[.)\]]?\s+[A-Z][\w'’\-]+,?\s+(?:[A-Z]\.\s?){1,3}[,.&]", entry):
        out.append("initials without full stops, e.g. Smith JA, not Smith, J. A.")
    elif re.search(rf"\((?:{YEAR})\)", entry[:200]):
        out.append("year after the journal name, not in brackets after the authors")
    has_journal_signs = re.search(r"\bvol\.|\bpp\.|\b\d+\(\d+\)\s*[:,]", entry)
    if has_journal_signs and not re.search(r"(?:19|20)\d{2}(?:\s[A-Z][a-z]{2}(?:\s\d{1,2})?)?;\s?\d+", entry):
        out.append("journal details written as Year;Volume(Issue):Pages")
    if authors and "et al" not in authors:
        count = authors.count(",") + 1
        if count > 6:
            out.append("more than six authors: list the first " + ("three" if ama else "six") + " then “et al”")
    if ama and re.search(r"https?://(?:dx\.)?doi\.org/", entry):
        out.append("DOIs written as doi:10…, not as a doi.org link")
    return out


def ieee_problems(entry):
    out = []
    if not re.match(r"^\s*\[\d+\]", entry):
        out.append("numbers in square brackets, e.g. [1]")
    if not re.match(r"^\s*\[?\d+[.)\]]?\s+(?:[A-Z]\.\s?(?:-?[A-Z]\.\s?)*)\s?[A-Z][\w'’\-]+", entry):
        out.append("authors written initials first, e.g. A. B. Smith")
    if re.search(r"\bvol\.|\d+\(\d+\)", entry) and not re.search(r"[“\"].+[”\"]", entry):
        out.append("article titles in quotation marks")
    return out


FORMAT_CHECKS = {
    "apa": apa_problems,
    "harvard": harvard_problems,
    "ama": lambda e: vancouver_problems(e, ama=True),
    "vancouver": vancouver_problems,
    "ieee": ieee_problems,
}
STYLE_NAMES = {**NUMBERED_STYLES, **AUTHOR_DATE_STYLES}


# ---------------------------------------------------------------------------
# The checks
# ---------------------------------------------------------------------------
def check_references(sections, doc=None, settings=None):
    """Returns (section, check, status, details, rule ID) tuples."""
    settings = settings or {}
    style = settings.get("citation_style", "auto")
    issues = []
    refs = [t for name, paras in sections if name == "References" for t in paras]
    if not refs:
        issues.append(("References", "Reference list", "Missing", "No References section found", "reference_list"))
        return issues

    body = " ".join(t for name, paras in sections if name != "References" for t in paras)
    numbered = sum(1 for r in refs if NUMBERED_ENTRY.match(r)) >= len(refs) / 2
    system = "numbered" if numbered else "author-date"
    nums = numbered_citations(body)
    ad = author_date_citations(body)

    # --- The journal's style uses the other system: say so once. The citation/list matching still runs,
    #     but the style's formatting checks don't (every entry would fail them for the same reason).
    if (style in NUMBERED_STYLES and not numbered) or (style in AUTHOR_DATE_STYLES and numbered):
        wanted = "numbered" if style in NUMBERED_STYLES else "author–date"
        issues.append(("References", "Citation style", "Missing",
                       f"{STYLE_NAMES[style]} uses {wanted} references, but this manuscript uses "
                       f"{'numbered' if numbered else 'author–date'} references", "citation_system"))
        style = "auto"

    # --- Two systems mixed
    if numbered and len(ad) >= 2:
        issues.append(("References", "Mixed citation systems", "Concern",
                       f"Numbered reference list, but {len(ad)} author–date citation(s) in the text, e.g. "
                       f"“{short(ad[0][2], 50)}”", "citation_mixed"))
    if not numbered and len(set(nums)) >= 2:
        issues.append(("References", "Mixed citation systems", "Concern",
                       f"Author–date reference list, but numbered citations in the text, e.g. [{nums[0]}]",
                       "citation_mixed"))

    if numbered:
        issues += numbered_checks(refs, nums, doc, style)
    else:
        issues += author_date_checks(refs, ad, style)

    # --- Reference list entries in the style's format (not when only citation keys are known, e.g. a .bib file
    #     that wasn't uploaded with LaTeX source)
    if getattr(doc, "references_unavailable", False):
        return issues
    if style in FORMAT_CHECKS:
        problems = {}
        for i, entry in enumerate(refs, start=1):
            for problem in FORMAT_CHECKS[style](entry):
                problems.setdefault(problem, []).append(i)
        for problem, entries in problems.items():
            issues.append(("References", "Reference format", "Concern",
                           f"{STYLE_NAMES[style]}: {problem} (entr{'y' if len(entries) == 1 else 'ies'} "
                           f"{listing(entries)})", "reference_format"))

    # --- Old references (advisory)
    years = [y for y in (entry_year(r) for r in refs) if y]
    limit = int(settings.get("old_reference_years", 10))
    share = float(settings.get("old_reference_share", 50))
    if len(years) >= 5:
        old = sum(1 for y in years if y < date.today().year - limit)
        if 100 * old / len(years) > share:
            issues.append(("References", "Old references", "Concern",
                           f"{old} of {len(years)} references ({100 * old // len(years)}%) are more than {limit} "
                           "years old", "reference_age"))
    return issues


def numbered_checks(refs, nums, doc, style):
    issues = []
    if not nums:
        issues.append(("References", "Citation check", "Concern",
                       "No numbered citations like [1] or ¹ found in the text", "citation_format"))
        return issues
    total = len(refs)
    cited = set(nums)
    beyond = sorted(n for n in cited if n > total)
    never = sorted(set(range(1, total + 1)) - cited)
    if beyond:
        issues.append(("References", "Citation not in list", "Missing",
                       f"Cited in text but not in the list: {', '.join(map(str, beyond))}", "citation_not_in_list"))
    if never:
        issues.append(("References", "Reference not cited", "Concern",
                       f"In the list but never cited: {', '.join(map(str, never))}", "reference_not_cited"))

    # first-citation order: each new number should be the next one
    first = list(dict.fromkeys(n for n in nums if n <= total))
    if first != sorted(first):
        issues.append(("References", "Citation order", "Concern",
                       f"References are first cited in this order: {listing(first, 10)}. Numbered styles "
                       "number references in the order they are first cited", "citation_order"))

    # how the numbers are written in the text (LaTeX source doesn't say: \cite becomes whatever the style makes it)
    if getattr(doc, "kind", "") == "LaTeX":
        return issues
    sup, br = superscript_and_bracket_counts(doc)
    if style == "ama" and br > sup:
        issues.append(("References", "In-text citations", "Concern",
                       "AMA uses superscript numbers (…as reported.¹), but citations are in [square brackets]",
                       "intext_format"))
    if style == "ieee" and sup > br:
        issues.append(("References", "In-text citations", "Concern",
                       "IEEE uses numbers in square brackets [1], but citations are superscripts", "intext_format"))
    return issues


def author_date_checks(refs, ad, style):
    issues = []
    keys = [entry_key(r) for r in refs]
    listed = {k for k in keys if k[1]}
    cited = {(a, y) for a, y, *_ in ad}
    shown = {}
    for a, y, written, kind, comma, author in ad:
        shown.setdefault((a, y), f"{author.strip()} {y}")

    missing = [shown[k] for k in sorted(cited - listed)]
    if missing:
        issues.append(("References", "Citation not in list", "Missing",
                       f"Cited in text but not in the list: {listing(missing)}", "citation_not_in_list"))
    if ad:   # only when the citations could be read at all
        uncited = [f"{surname(r)} {k[1]}" for r, k in zip(refs, keys)
                   if k[1] and k not in cited]
        if uncited:
            issues.append(("References", "Reference not cited", "Concern",
                           f"In the list but never cited: {listing(uncited)}", "reference_not_cited"))
    else:
        issues.append(("References", "Citation check", "Concern",
                       "No author–date citations like (Smith, 2020) found in the text", "citation_format"))

    # alphabetical order of the list
    names = [k[0] for k in keys]
    for i in range(1, len(names)):
        if names[i] and names[i - 1] and names[i] < names[i - 1]:
            issues.append(("References", "Reference list order", "Concern",
                           f"Author–date lists are in alphabetical order, but entry {i + 1} "
                           f"({surname(refs[i])}) comes after entry {i} ({surname(refs[i - 1])})",
                           "reference_list_order"))
            break

    # how citations are written in the text (APA rules)
    if style == "apa":
        problems = []
        and_inside = [w for a, y, w, kind, comma, author in ad if kind == "bracket" and re.search(r"\band\b", author)]
        no_comma = [w for a, y, w, kind, comma, author in ad if kind == "bracket" and not comma]
        amp_outside = [w for a, y, w, kind, comma, author in ad if kind == "narrative" and "&" in author]
        if and_inside:
            problems.append(f"use “&” inside brackets: “({short(and_inside[0], 40)})”")
        if no_comma:
            problems.append(f"put a comma before the year: “({short(no_comma[0], 40)})”")
        if amp_outside:
            problems.append(f"use “and” outside brackets: “{short(amp_outside[0], 40)}”")
        if problems:
            issues.append(("References", "In-text citations", "Concern", "APA: " + "; ".join(problems),
                           "intext_format"))
    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python step6_citations.py <manuscript.docx> [apa|harvard|ama|vancouver|ieee]")
        return
    style = sys.argv[2] if len(sys.argv) > 2 else "auto"
    try:
        sections, doc = split_into_sections(sys.argv[1])
    except Exception as e:
        print(f"Could not read '{sys.argv[1]}': {e}")
        return
    issues = check_references(sections, doc, {"citation_style": style})
    print(f"\nFile: {sys.argv[1]}  (style: {style})\n")
    if not issues:
        print("No citation or reference issues found.")
        return
    for section, check, status, details, _rule in issues:
        print(f"[{status}] {check}: {details}")


if __name__ == "__main__":
    main()
