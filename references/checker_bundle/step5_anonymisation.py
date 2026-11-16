"""
Manuscript Checker - anonymisation (double-blind peer review)

In double-blind review, reviewers must not be able to tell who wrote the paper.
These checks look for anything that gives the authors away:

  - a title page left in (author names, affiliations, emails, ORCID iDs)
  - emails or ORCID iDs elsewhere in the text
  - author names in the text, headers or footers
  - the author's name stored in the Word file's properties
  - self-citations written in the first person ("our previous study [3]")
  - acknowledgements that name people or institutions
  - institutions named in the Methods, ethics or funding statements

One check applies to every manuscript, whatever the review model:
  - tracked changes or comments left in the file

How to run (in a terminal, from this folder):
    python step5_anonymisation.py my_manuscript.docx
"""

import re
import sys

from docx.oxml.ns import qn
from lxml import etree

from step1_split_sections import split_into_sections

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
ORCID = re.compile(r"\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b|orcid\.org", re.IGNORECASE)

# Named institutions: "University of Delhi", "Department of Microbiology", "Example Medical College",
# "Max Super Speciality Hospital". Lower-case phrases like "a tertiary care hospital" don't count.
INSTITUTION = re.compile(
    r"\b(?:Department|Dept\.|Faculty|School|Institute|College|Centre|Center|Division|University) of "
    r"(?:the )?[A-Z][\w&'-]*(?: [A-Z][\w&'-]*)*"
    r"|\b(?:[A-Z][\w&'.-]+ ){1,5}(?:University|Hospital|Institute|College|Polytechnic|Medical Centre|"
    r"Medical Center|Research Centre|Research Center|Clinic)\b")
NOT_A_NAME = {"The", "A", "An", "This", "That", "Our", "Their", "Each", "Every", "Any", "One", "Both", "All"}
# Standards bodies and agencies named in Methods all the time: they don't identify the authors
WELL_KNOWN = re.compile(r"Standards Institute|National Institutes? of Health|Institute of Medicine|"
                        r"National Institute for Health|American National Standards|British Standards|"
                        r"Joanna Briggs Institute|Cochrane|"
                        r"Indian Council|World Health|Robert Koch Institute|Wellcome", re.IGNORECASE)

# Placeholders authors use when they have blinded something
BLINDED = re.compile(r"blinded|redacted|anonymi[sz]ed|(?:masked|removed|withheld) for (?:peer )?review|"
                     r"\bX{3,}\b|\[(?:authors?|institution|university|hospital|name|affiliation|details)[^\]]*\]",
                     re.IGNORECASE)

# A person's name: "A. Bose", "A.K. Sharma", "Priya Sharma", "Priya K. Sharma"
NAME = r"(?:(?:[A-Z]\.\s?)+[A-Z][a-z'-]+|[A-Z][a-z'-]+(?:\s(?:[A-Z]\.\s?)*[A-Z][a-z'-]+)+)"
MARKS = r"[\d,*†‡§¶\s]*"
AUTHOR_LINE = re.compile(rf"^\s*(?:by\s+)?{NAME}{MARKS}(?:(?:,|;|\band\b|&)\s*{NAME}{MARKS})+")
SINGLE_AUTHOR = re.compile(rf"^\s*(?:by\s+)?{NAME}{MARKS}$")
# Capitalised words that appear on front pages but are never part of a person's name
NOT_PERSON_WORDS = {"Dear", "Editor", "Editors", "Sir", "Madam", "Original", "Research", "Article", "Review",
                    "Case", "Report", "Letter", "Short", "Communication", "Brief", "Title", "Running", "Word",
                    "Count", "Abstract", "Manuscript", "Submission", "Type", "Category", "Section", "Journal",
                    "Systematic", "Narrative", "Commentary", "Perspective", "Editorial", "Study", "Protocol"}
# Words that turn up in titles ("Health Risks and Regulatory Challenges") and are not part of anyone's name.
# A Title Case title otherwise reads like a list of people.
TITLE_WORDS = set("""
health risk risks study studies analysis analyses effect effects impact impacts role roles novel using based among patients
clinical evidence approach approaches model models modeling modelling data learning machine deep network networks disease
diseases cancer treatment treatments therapy therapies outcome outcomes factor factors assessment evaluation comparison
comparative development design performance properties synthesis characterization characterisation application applications
management challenge challenges perspective perspectives future current recent advances trend trends insight insights
understanding toward towards emerging global environmental substance substances persistence regulatory regulation water
soil climate energy quality children women adults adolescents elderly rural urban association associated prevalence
incidence mortality morbidity survival efficacy safety trial trials randomized randomised controlled cohort sectional
retrospective prospective observational experimental qualitative quantitative systematic meta overview framework method
methods methodology system systems structure structures function functions mechanism mechanisms molecular cellular genetic
genomic gene genes protein proteins expression activity response responses resistance infection infections bacterial viral
human animal plant plants food drug drugs acute chronic level levels effectiveness intervention interventions education
knowledge attitude attitudes practice practices policy policies public national international population populations
community care primary secondary tertiary diagnosis diagnostic detection prediction predictive predictors optimization
optimisation enhanced improved improving sustainable sustainability production removal degradation contamination pollution
pollutants exposure toxicity remediation technology technologies digital artificial intelligence pandemic diabetes
hypertension obesity nutrition mental stress depression anxiety social economic financial growth pilot preliminary
investigation exploring exploration examining evaluating assessing investigating determining comprehensive critical
integrated advanced potential biological chemical physical thermal mechanical electrical optical material materials
composite composites polymer polymers engineering science sciences scientific medical medicine surgery surgical nursing
pharmaceutical compounds extract extracts acid cell cells tissue tissues implications determinants strategies strategy
characteristics relationship relationships influence influences changes perception perceptions experiences experience
barriers facilitators utilization utilisation awareness behaviour behavior behaviours behaviors services service delivery
implementation interaction interactions distribution diversity dynamics simulation simulations algorithm algorithms
classification estimation measurement measurements monitoring surveillance screening prevention control outbreak
transmission vaccination vaccine vaccines antimicrobial antibiotic antibiotics microbial bacteria virus fungal isolates
biomarkers biomarker inflammation inflammatory metabolic syndrome cardiovascular respiratory neurological pediatric
paediatric maternal neonatal pregnancy pregnant students teachers nurses workers healthcare hospitals hospitalized
developing countries country setting settings region regions district northern southern eastern western central
""".split())
_TITLE_SUFFIX = re.compile(r"(?:tion|tions|sion|sions|ment|ments|ness|ities|ology|ologies|ical|ional|mental|ative|itive|"
                           r"atory|ysis|yses|i[sz]ation|isms?|ances?|ences?)$")
_TITLE_FUNCTION = re.compile(r"\b(?:of|in|for|the|on|with|to|a|an|from|among|between|using|via|under|during|after|its|"
                             r"their|as|at|into|versus|vs|through|against|across|within|towards?)\b")


_MARKED_PERSON = re.compile(rf"({NAME})\s?(?:\[\d|\d{{1,2}}(?:,\s?\d{{1,2}})*[*†‡§¶#]?(?=\s*[,;&]|\s+and\b|\s*$)|[*†‡§¶#])")
_INITIALLED = re.compile(r"\b(?:[A-Z]\.\s?)+[A-Z][a-z]{2,}[\d*†‡§¶]*(?=\s*[,;&]|\s+and\b|\s*$|\.\s)")


def title_score(line):
    """How much a front-page line reads like a title, not a list of names. 3 or more: a title."""
    line = (line or "").strip()
    if not line or EMAIL.search(line) or ORCID.search(line):
        return -5
    tokens = re.findall(r"[A-Za-z][A-Za-z'’-]*", line)
    lexicon = sum(1 for t in tokens if t.lower().strip("-'’") in TITLE_WORDS)
    suffix = sum(1 for t in tokens if len(t) >= 7 and t.lower() not in TITLE_WORDS and _TITLE_SUFFIX.search(t.lower()))
    score = min(lexicon, 4) + min(suffix, 2)
    if re.search(r"[:?]", line.rstrip(" :")):
        score += 2                                         # "PFAS: persistence and policy", "Does X predict Y?"
    if re.search(r"\((?:[A-Z][A-Za-z0-9-]{1,11})\)", line):
        score += 1                                         # an abbreviation in brackets
    if _TITLE_FUNCTION.search(line):
        score += 2
    if re.search(r"[A-Za-z]{3}-(?:\s|$)", line):
        score += 1                                         # "Per- and Polyfluoroalkyl"
    if any(not not_person(m.group(1)) for m in _MARKED_PERSON.finditer(line)) or _INITIALLED.search(line):
        score -= 6                                         # "Rohan Mathew1*", "P. Sharma,": these are people
    return score


def looks_like_title(line):
    return title_score(line) >= 3


def not_person(name):
    """True for 'Health Risks' or 'Original Article': capitalised words that are not somebody's name."""
    parts = re.findall(r"[A-Za-z]+", name or "")
    return bool(NOT_PERSON_WORDS & set(parts)) or any(w.lower() in TITLE_WORDS for w in parts)


# Lines a journal or a submission system prints above the title, and the article type
HEADER_JUNK = re.compile(r"\bISSN\b|\bdoi\b|https?://|\bwww\.|©|\bcopyright\b|\b(?:vol(?:ume)?\.?|issue|no\.)\s*\d|\bpp?\.\s*\d|"
                         r"^(?:received|accepted|published|revised|submitted|available online|article history|article info|"
                         r"citation|cite this|how to cite|open access|peer[- ]reviewed|manuscript (?:id|number|no)|"
                         r"running (?:title|head)|short title|word count|date)\b", re.IGNORECASE)
JOURNAL_NAME = re.compile(r"^(?:(?:[A-Z][\w&'-]*|of|and|the|for|in|on|&)\s+){0,9}"
                          r"(?:Journal|Annals|Archives|Proceedings|Transactions|Bulletin|Letters|Reviews|Reports)\b"
                          r"(?:\s+(?:[A-Z][\w&'-]*|of|and|the|for|in|on|&))*$")
ARTICLE_KIND = re.compile(r"^(?:original|research|review|case|short|brief|systematic|narrative|mini)\b.{0,30}"
                          r"(?:article|report|paper|communication|review)s?\s*$|^(?:letter|editorial|commentary)\b", re.IGNORECASE)


def front_standalone(line):
    """A front-page line that is complete in itself: a journal header, the article type, or the authors' names."""
    line = line.strip()
    if HEADER_JUNK.search(line) or ARTICLE_KIND.search(line):
        return True
    if JOURNAL_NAME.match(line) and ":" not in line and len(line.split()) <= 10:
        return True
    if looks_like_title(line):
        return False
    return bool(AUTHOR_LINE.match(line) or (len(line) < 60 and SINGLE_AUTHOR.match(line) and not not_person(line)))


TITLED_PERSON = re.compile(r"\b(?:Dr|Prof|Professor|Mr|Mrs|Ms|Mx)\.? (?:[A-Z]\.\s?)*[A-Z][a-z'-]+(?: [A-Z][a-z'-]+)?")
INITIALLED_PERSON = re.compile(r"\b(?:[A-Z]\.\s?)+[A-Z][a-z'-]{2,}")

SELF_CITATION = re.compile(
    r"\b(?:our|my) (?:previous|prior|earlier|recent|own|published) (?:\w+ )?(?:study|studies|work|works|research|"
    r"report|reports|paper|papers|publication|publications|findings|investigation|trial|analysis|survey|review)\b"
    r"|\bwe (?:have )?(?:previously|earlier|recently|already) (?:reported|showed|shown|demonstrated|described|"
    r"published|found|developed|proposed|validated|observed)\b"
    r"|\bas (?:we|I) (?:have )?(?:previously |earlier )?(?:reported|showed|shown|demonstrated|described|published)\b"
    r"|\bour (?:research )?(?:group|laboratory|lab|team) (?:has|have|previously|earlier|recently|reported|showed)\b"
    r"|\bin (?:our|my) (?:previous|earlier|prior) \w+",
    re.IGNORECASE)

# Names Word or other programs fill in by themselves: not a real person
GENERIC_AUTHORS = {"", "author", "authors", "user", "admin", "administrator", "owner", "windows user",
                   "microsoft office user", "office user", "unknown", "python-docx", "python", "pc", "hp",
                   "dell", "lenovo", "acer", "asus", "home", "guest", "test"}

SKIP_FOR_TEXT = {"Front matter", "References"}


def sentences(text):
    return re.split(r"(?<=[.!?])\s+", text)


def short(text, limit=90):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def institutions_in(text):
    """Named institutions in a piece of text, skipping ones that are only 'The Hospital' and the like."""
    found = []
    for m in INSTITUTION.finditer(text):
        words = m.group(0).split()
        while words and words[0] in NOT_A_NAME:
            words = words[1:]
        name = " ".join(words)
        if len(words) >= 2 and name not in found and not WELL_KNOWN.search(name):
            found.append(name)
    return found


def person_names(text):
    """The person-like names in a line, leaving out front-page labels such as 'Original Article'."""
    return [n.strip() for n in re.findall(NAME, text) if not not_person(n)]


def is_real_person(name):
    """A name typed by a person (two or more words), not one filled in by a program."""
    name = (name or "").strip()
    return name.lower() not in GENERIC_AUTHORS and len(re.findall(r"[A-Za-z]{2,}", name)) >= 2


# ---------------------------------------------------------------------------
# Reading the parts of a Word file that python-docx doesn't show as paragraphs
# ---------------------------------------------------------------------------
def markup(doc):
    """Tracked changes and comments still in the file: (number of changes, number of comments, authors)."""
    authors = []
    changes = 0
    if not hasattr(doc, "element"):          # not a Word file (PDF, ODT…): no tracked changes to read
        return 0, 0, []
    for tag in ("w:ins", "w:del"):
        for el in doc.element.body.iter(qn(tag)):
            changes += 1
            authors.append(el.get(qn("w:author"), ""))
    comments = 0
    for part in doc.part.package.iter_parts():
        if str(part.partname).endswith("/comments.xml"):
            root = etree.fromstring(part.blob)
            for el in root.iter(qn("w:comment")):
                comments += 1
                authors.append(el.get(qn("w:author"), ""))
    names = sorted({a.strip() for a in authors if a and a.strip().lower() not in GENERIC_AUTHORS})
    return changes, comments, names


def header_footer_lines(doc):
    """Every line of text in the headers and footers, without repeats."""
    lines = []
    for section in doc.sections:
        for part in (section.header, section.first_page_header, section.even_page_header,
                     section.footer, section.first_page_footer, section.even_page_footer):
            try:
                if part.is_linked_to_previous:
                    continue
                for p in part.paragraphs:
                    if p.text.strip() and p.text.strip() not in lines:
                        lines.append(p.text.strip())
            except Exception:
                continue
    return lines


def file_authors(doc, labelled=False):
    """Real names in the Word file's properties; with labelled=True, as 'Name (author)' etc."""
    props = doc.core_properties
    found = [(n.strip(), label) for n, label in ((props.author, "author"), (props.last_modified_by, "last saved by"))
             if is_real_person(n)]
    if labelled:
        return [f"{n} ({label})" for n, label in found]
    return [n for n, _ in found]


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def check_leftover_markup(doc):
    """Applies to every manuscript: tracked changes and comments should be resolved before submission."""
    changes, comments, names = markup(doc)
    if not (changes or comments):
        return []
    parts = []
    if changes:
        parts.append(f"{changes} tracked change(s)")
    if comments:
        parts.append(f"{comments} comment(s)")
    who = f" by {', '.join(names)}" if names else ""
    return [("Structure", "Tracked changes / comments", "Concern",
             f"The file still contains {' and '.join(parts)}{who}", "leftover_markup")]


def title_page(sections):
    """What the front matter (everything before the first heading) reveals about the authors.
    Returns (found, names): found lists 'author names', 'affiliations', 'email addresses', 'ORCID iDs',
    'corresponding author details' as they appear; names are the author names read from it."""
    front = [t for name, paras in sections if name == "Front matter" for t in paras]
    found, names = [], []
    for i, text in enumerate(front):
        if BLINDED.search(text):
            continue
        line = None if looks_like_title(text) else \
            AUTHOR_LINE.match(text) or (i > 0 and len(text) < 80 and SINGLE_AUTHOR.match(text))
        line_names = person_names(line.group(0)) if line and i > 0 else []
        if line_names:
            names += line_names
            if "author names" not in found:
                found.append("author names")
        if i > 0 and institutions_in(text) and "affiliations" not in found:
            found.append("affiliations")
        if EMAIL.search(text) and "email addresses" not in found:
            found.append("email addresses")
        if ORCID.search(text) and "ORCID iDs" not in found:
            found.append("ORCID iDs")
        if re.search(r"corresponding author", text, re.IGNORECASE) and "corresponding author details" not in found:
            found.append("corresponding author details")
    return found, names


def check_anonymisation(sections, doc):
    """Double-blind checks. Returns (section, check, status, details, rule ID) tuples."""
    issues = []
    body = [(name, t) for name, paras in sections if name not in SKIP_FOR_TEXT for t in paras]

    # --- Title page left in: everything before the first heading except the title itself
    found, names = title_page(sections)
    if found:
        shown = [f"author names ({', '.join(dict.fromkeys(names[:4]))})" if f == "author names" else f for f in found]
        issues.append(("Anonymisation", "Title page in manuscript", "Missing",
                       "Before the abstract the manuscript shows " + ", ".join(shown)
                       + ". Double-blind journals want these on a separate title page", "anon_title_page"))

    # --- Emails and ORCID iDs in the rest of the text
    leaks = sorted({m.group(0) for _, t in body for m in EMAIL.finditer(t)}
                   | {m.group(0) for _, t in body for m in ORCID.finditer(t)})
    if leaks:
        issues.append(("Anonymisation", "Emails / ORCID iDs", "Missing",
                       "Found in the text: " + ", ".join(leaks[:5]), "anon_emails"))

    # --- Author names in the text, headers and footers
    known = sorted({n for n in names + file_authors(doc) + markup(doc)[2] if is_real_person(n) or "." in n})
    headers = header_footer_lines(doc)
    places = {}
    for name in known:
        pattern = re.compile(r"(?<!\w)" + re.escape(name) + r"(?!\w)")
        for section, text in body:
            if pattern.search(text):
                places.setdefault(name, set()).add(section)
        if any(pattern.search(h) for h in headers):
            places.setdefault(name, set()).add("header/footer")
    if places:
        issues.append(("Anonymisation", "Author names in text", "Missing",
                       "; ".join(f"{n} ({', '.join(sorted(s))})" for n, s in places.items()), "anon_names"))

    # --- Headers and footers
    revealing = [h for h in headers if EMAIL.search(h) or ORCID.search(h) or institutions_in(h)
                 or any(n in h for n in known)]
    if revealing:
        issues.append(("Anonymisation", "Headers / footers", "Concern",
                       "Header or footer may identify the authors: " + "; ".join(short(h, 60) for h in revealing[:3]),
                       "anon_headers"))

    # --- File properties
    stored = file_authors(doc, labelled=True)
    if stored:
        issues.append(("Anonymisation", "File properties", "Concern",
                       f"The Word file's properties name {' and '.join(stored)}. "
                       "In Word: File → Info → Check for Issues → Inspect Document → remove personal information",
                       "anon_metadata"))

    # --- First-person self-citation
    selfcites = [short(s) for name, t in body if name != "Acknowledgements"
                 for s in sentences(t) if SELF_CITATION.search(s)]
    if selfcites:
        issues.append(("Anonymisation", "Self-citation", "Concern",
                       f"{len(selfcites)} sentence(s) refer to the authors' own earlier work: “{selfcites[0]}” "
                       "Cite it in the third person or blind the reference", "anon_self_citation"))

    # --- Acknowledgements naming people or institutions
    ack = " ".join(t for name, t in body if name == "Acknowledgements")
    if ack and not BLINDED.search(ack):
        named = (TITLED_PERSON.findall(ack) + INITIALLED_PERSON.findall(ack)
                 + institutions_in(ack) + [n for n in known if n in ack])
        if named:
            issues.append(("Anonymisation", "Acknowledgements", "Concern",
                           "Acknowledgements name " + ", ".join(dict.fromkeys(named[:4]))
                           + ". Move them to the title page or blind them for review", "anon_acknowledgements"))

    # --- Institutions named in the Methods, ethics or funding statements
    where = {}
    for name, text in body:
        if name == "Acknowledgements" or BLINDED.search(text):
            continue
        for inst in institutions_in(text):
            where.setdefault(inst, set()).add(name)
    if where:
        listed = "; ".join(f"{inst} ({', '.join(sorted(s))})" for inst, s in list(where.items())[:4])
        issues.append(("Anonymisation", "Institution named", "Concern",
                       f"Named in the text: {listed}. Some double-blind journals ask for these to be blinded",
                       "anon_institution"))
    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python step5_anonymisation.py <manuscript.docx>")
        return
    path = sys.argv[1]
    try:
        sections, doc = split_into_sections(path)
    except Exception as e:
        print(f"Could not read '{path}': {e}")
        return
    issues = check_leftover_markup(doc) + check_anonymisation(sections, doc)
    print(f"\nFile: {path}\n")
    if not issues:
        print("No anonymisation issues found.")
        return
    print(f"{len(issues)} issue(s):\n")
    for section, check, status, details, _rule in issues:
        print(f"[{status}] {section} - {check}: {details}")


if __name__ == "__main__":
    main()
