"""
Manuscript Checker - Milestone 3 (part 1)
Checks declarations (ethics, consent, COI, funding, author contributions,
acknowledgements, data availability), study details (sample size, study
period, inclusion/exclusion criteria, questionnaires, minors, animals,
trial/PROSPERO registration) and numbered reference citations.

How to run (in a terminal, from this folder):
    python step4_declarations.py my_manuscript.docx
"""

import sys
import re
from step1_split_sections import split_into_sections   # reuse your step 1 code


def has(pattern, text):
    """True if the regex pattern appears anywhere in the text (case-insensitive)."""
    return re.search(pattern, text, re.IGNORECASE) is not None


# Abbreviations that end in a full stop but don't end a sentence: "approval no. 45", "et al. 2020", "Fig. 2"
ABBREVIATIONS = r"(?:no|No|NO|nos|Nos|ref|Ref|vs|al|Dr|Prof|Fig|Figs|fig|approx|e\.g|i\.e|cf|St|Mr|Mrs|Ms|Vol|vol|pp|p|Sr|Jr|Ltd|Inc|Co|Dept|Univ|Govt)"
KEEP = "\u2060"   # an invisible joiner put after those abbreviations while splitting


def split_sentences(text):
    """Split text into sentences, without breaking after abbreviations like 'no.' or 'et al.'."""
    protected = re.sub(rf"\b({ABBREVIATIONS})\.\s+", rf"\1.{KEEP}", text)
    return [s.replace(KEEP, " ") for s in re.split(r"(?<=[.!?])\s+", protected)]


def sentences_with(pattern, text):
    """Return only the sentences that contain the pattern."""
    sentences = split_sentences(text)
    return " ".join(s for s in sentences if has(pattern, s))


NEGATION = r"\b(no|not|neither|nor|without|none)\b"


def affirmative(text):
    """Drop sentences that deny something, e.g. 'No human participants or animals were involved.'"""
    sentences = split_sentences(text)
    return " ".join(s for s in sentences if not has(NEGATION, s))


def study_text(sections):
    """What the study itself did: Methods (and Ethics) if present, otherwise the whole body,
    with negated sentences removed. The Introduction is left out on purpose, since
    'cancer in women' there doesn't mean the study had human participants."""
    methods = " ".join(t for name, paras in sections if name in ("Methods", "Ethics") for t in paras)
    if not methods:
        methods = " ".join(t for name, paras in sections
                           if name not in ("References", "Introduction", "Front matter") for t in paras)
    return affirmative(methods)


# Labels authors put above the title, e.g. "Original Article", "Short Communication"
TYPE_LABELS = [
    ("correction",          r"erratum|corrigendum|correction(?: notice)?"),
    ("book review",         r"book review"),
    ("letter",              r"letter(?: to the editor)?|correspondence|research letter"),
    ("short communication", r"short communication|brief (?:report|communication)|rapid communication|short report"),
    ("commentary",          r"commentary|perspective|viewpoint|opinion|editorial|essay|policy (?:brief|forum)"),
    ("protocol",            r"(?:study )?protocol"),
    ("data paper",          r"data (?:descriptor|paper|note|article)"),
    ("methods",             r"methods? (?:paper|article)|technical note|method article"),
    ("case report",         r"case report|case series|clinical image"),
    ("narrative review",    r"(?:narrative |mini[- ]?)?review(?: article)?"),
]
# Types that report a study with participants, samples or data (sample size, study period, criteria apply)
STUDY_TYPES = ("research", "short communication", "protocol", "methods")
# Types with no participants of their own (no ethics or consent statement expected)
NO_PARTICIPANTS = ("letter", "narrative review", "commentary", "book review", "correction")


def article_type(sections):
    """The kind of article, judged from a label line above the title (e.g. "Short Communication"), the
    headings, and how the paper describes itself in its title, abstract and keywords. One of:
    research, short communication, case report, letter, narrative review, commentary, protocol,
    methods, data paper, book review, correction."""
    front = [t for name, paras in sections if name == "Front matter" for t in paras]
    for line in front[:4]:
        for kind, pattern in TYPE_LABELS:
            if len(line) < 40 and re.fullmatch(rf"\s*(?:article type:\s*)?(?:{pattern})\s*:?\s*", line, re.IGNORECASE):
                return kind
    title = front[0] if front else ""
    opening = " ".join(t for name, paras in sections if name in ("Front matter", "Abstract", "Keywords") for t in paras)
    if has(r"^\s*(?:erratum|corrigendum|correction to)\b", title):
        return "correction"
    if has(r"letter to the editor|letter to editor|\bdear editor\b", opening):
        return "letter"
    if any(name == "Case presentation" for name, _ in sections) or has(r"\bcase report\b|\bcase series\b", opening):
        return "case report"
    if has(r"\bstudy protocol\b|\bprotocol for an?\b|:\s*(?:a |the )?protocol\b", title):
        return "protocol"
    if has(r"\bdata (?:descriptor|paper|note)\b|\bdataset\b.*\bdescri", title) or \
            any(name == "Data records" for name, _ in sections):
        return "data paper"
    if has(r":\s*(?:a |an )?(?:commentary|perspective|viewpoint|editorial|opinion)\b", title):
        return "commentary"
    if has(r"\b(?:brief report|short communication|research letter)\b", title):
        return "short communication"
    if (has(r"narrative review|literature review|review article|mini[- ]?review", opening)
            and not has(r"systematic review|meta-analys|scoping review", opening)):
        return "narrative review"
    return "research"


def is_case_report(sections):
    return article_type(sections) == "case report"


def study_type(sections):
    text = study_text(sections)
    human = (has(HUMAN_WORDS, text)
             or has(r"\bhospital\b|\bclinical\b|retrospective|medical records|\bconsent\b", text)
             or has(r"\bisolates\b|\bspecimens\b|\burine\b|\bsputum\b|\bswabs?\b", text))
    animal = has(ANIMAL_WORDS, text)
    return human, animal, text


# ---------------------------------------------------------------------------
# Declarations
# ---------------------------------------------------------------------------
# Each declaration: (name, heading name from step 1, words that show it is present in the text, rule ID)
DECLARATIONS = [
    ("Conflict of interest", "Conflict of interest",
     r"conflicts? of interest|competing interests?|declare[sd]? no|nothing to disclose", "coi_statement"),
    ("Funding", "Funding",
     r"\bfund(ing|ed)\b|\bgrant\b|financial support|received no specific", "funding_statement"),
    ("Author contributions", "Author contributions",
     r"author(s'|s)? contributions?|contributed to|CRediT|conceptuali[sz]ation", "author_contributions"),
    ("Acknowledgements", "Acknowledgements",
     r"acknowledg", "acknowledgements"),
    ("Data availability", "Data availability",
     r"data availab|available from the corresponding author|available on (reasonable )?request|deposited in", "data_availability"),
]

SAMPLE_WORDS = (r"patients?|participants?|subjects?|respondents?|isolates?|samples?|"
                r"specimens?|cases?|children|women|men|individuals|students|volunteers|"
                r"mice|rats|animals|studies|articles|records|trials|workers|nurses|doctors|physicians|"
                r"mothers|households|pregnant women|adults|adolescents|caregivers|teachers|pharmacists")
HUMAN_WORDS = r"\b(patients?|participants?|respondents?|subjects?|volunteers|women|men|children|students)\b"
MINOR_WORDS = r"\b(child(ren)?|minors?|adolescents?|paediatric|pediatric|infants?|neonates?|school students|under 18|<\s?18 years)\b"
ANIMAL_WORDS = r"\b(mice|mouse|rats?|rabbits?|guinea pigs?|zebrafish|animals?)\b"
DATE = (r"\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|"
        r"(\d{1,2}(st|nd|rd|th)?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{1,2},?\s+)?\d{4})\b")
APPROVAL_NO = r"(no\.?|number|ref(erence)?\.?|approval|protocol|letter)\s*(id)?\s*[:#]?\s*[A-Z0-9/\-]*\d[A-Z0-9/\-.]{2,}"
COMMITTEE = r"ethics committee|ethical committee|review board|\bIRB\b|\bIEC\b|\bIAEC\b|research ethics|ethics board"


def check_declarations(sections):
    issues = []   # (section, check, status, details, rule ID)
    headings = {name for name, _ in sections}
    body = " ".join(t for name, paras in sections if name not in ("References",) for t in paras)
    human, animal, study = study_type(sections)

    # --- Simple present/absent declarations
    for name, heading, words, rule in DECLARATIONS:
        if heading not in headings and not has(words, body):
            issues.append(("Declarations", name, "Missing", f"No {name.lower()} statement found", rule))

    if article_type(sections) in NO_PARTICIPANTS:
        return issues   # no participants: ethics and consent statements don't apply

    # --- Ethics
    ethics_text = sentences_with(r"ethic|review board|\bIRB\b|\bIEC\b|\bIAEC\b", body)
    review = has(r"systematic review|meta-analys|scoping review|narrative review", body)
    if not ethics_text and review and not (human or animal):
        pass   # reviews of published studies usually don't need an ethics statement
    elif not ethics_text and not (human or animal):
        issues.append(("Declarations", "Ethics statement", "Concern",
                       "No ethics statement found (study does not appear to involve humans or animals)", "ethics_statement"))
    elif not ethics_text:
        issues.append(("Declarations", "Ethics approval", "Missing", "No ethics statement found", "ethics_approval"))
    elif has(r"not required|waived|exempt|not applicable", ethics_text) and (not (human or animal) or is_case_report(sections)):
        pass   # e.g. an in vitro study, or a single case report where consent for publication is what matters
    elif has(r"not required|waived|exempt", ethics_text) and not has(COMMITTEE, ethics_text):
        issues.append(("Declarations", "Ethics approval", "Concern",
                       "Ethics approval stated as not required/exempt, without naming a committee", "ethics_approval"))
    else:
        if not has(COMMITTEE, ethics_text):
            issues.append(("Declarations", "Ethics committee name", "Missing",
                           "Ethics statement does not name the committee", "ethics_committee"))
        if not re.search(APPROVAL_NO, ethics_text, re.IGNORECASE):
            issues.append(("Declarations", "Ethics approval number", "Missing",
                           "No approval/reference number found in the ethics statement", "ethics_number"))
        if not has(DATE, ethics_text):
            issues.append(("Declarations", "Ethics approval date", "Missing",
                           "No approval date found in the ethics statement", "ethics_date"))

    # --- Consent (only expected for human studies)
    consent_text = sentences_with(r"consent", body)
    if human and not consent_text:
        issues.append(("Declarations", "Consent", "Missing", "No consent statement found", "consent"))
    elif consent_text:
        written = has(r"written", consent_text)
        verbal = has(r"verbal|oral", consent_text)
        waived = has(r"waive|not required|exempt", consent_text)
        if waived and (written or verbal):
            issues.append(("Declarations", "Consent", "Concern",
                           "Consent statement is contradictory (mentions both consent and a waiver)", "consent"))
        elif waived and not has(COMMITTEE, consent_text):
            issues.append(("Declarations", "Consent", "Concern",
                           "Consent waiver does not say who granted it", "consent"))
        elif not (written or verbal or waived):
            issues.append(("Declarations", "Consent mode", "Concern",
                           "Consent mentioned but not whether written or verbal", "consent_mode"))
        if verbal and not written:
            issues.append(("Declarations", "Verbal consent", "Concern",
                           "Only verbal consent mentioned", "verbal_consent"))

    # --- Minors
    if has(MINOR_WORDS, study) and consent_text and not has(r"parent|guardian|legally authori[sz]ed", consent_text):
        issues.append(("Declarations", "Consent for minors", "Concern",
                       "Study appears to involve minors; consent does not mention parents/guardians", "consent_minors"))
    return issues


def check_study_details(sections, settings=None):
    """`settings` is the "settings" part of a profile (only data_cutoff_year is used here)."""
    cutoff = int((settings or {}).get("data_cutoff_year", 2020))
    issues = []
    body = " ".join(t for name, paras in sections if name != "References" for t in paras)
    methods = " ".join(t for name, paras in sections if name == "Methods" for t in paras)
    where = methods or body

    review = has(r"systematic review|meta-analys|scoping review|narrative review", body)
    human, animal, study = study_type(sections)
    kind = article_type(sections)
    if kind not in STUDY_TYPES:
        return issues   # case reports, letters, reviews, commentaries… have no sample, study period or criteria

    # --- Sample size ("312 patients", "80 school children", "24 community health workers", "n = 45")
    number = r"(\d[\d,]*|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|fifty|hundred)"
    units = SAMPLE_WORDS + r"|experiments|replicates|repeats|biological replicates"
    if review:
        pass   # reviews report included studies, checked by peer review
    elif not re.search(r"\bn\s*=\s*\d+|\b" + number + r"\s+([a-z\-]+\s+){0,2}(" + units + r")\b", body, re.IGNORECASE):
        issues.append(("Study details", "Sample size", "Missing", "No sample size found", "sample_size"))

    # --- Study period and data age
    # years that name a guideline or declaration aren't study dates: "STARD 2015", "Helsinki (revised 2013)"
    where = re.sub(r"\b(?:CONSORT|STROBE|PRISMA|STARD|ARRIVE|CARE|SPIRIT|TRIPOD|CHEERS|SQUIRE|COREQ|SRQR|MOOSE|AGREE|"
                   r"GRADE|ICMR|ICH|GCP)(?:[- ](?:P|ScR|AI|statement|guidelines?|checklist|extension|version))?"
                   r"\s*[(,]?\s*(?:19|20)\d{2}\b"
                   r"|\bHelsinki\s*[(,]?\s*(?:as\s+)?(?:revised|amended|updated)?\s*(?:in\s+)?(?:19|20)\d{2}\b",
                   " ", where)
    period = sentences_with(r"\b(19|20)\d{2}\b", where)
    period = sentences_with(r"between|from|during|collected|enrolled|recruited|conducted|period|"
                            r"retrospective|prospective|until|to\s+\w+\s+\d{4}|\bin\s+(19|20)\d{2}", period)
    years = [int(y) for y in re.findall(r"\b((?:19|20)\d{2})\b", period)]
    if review or kind == "protocol":
        pass   # in reviews, years are publication dates; in protocols, dates are planned, not past
    elif not years:
        issues.append(("Study details", "Study duration", "Missing", "No study period found in the Methods", "study_period"))
    elif min(years) < cutoff:
        issues.append(("Study details", f"Data older than {cutoff}", "Concern",
                       f"Data collection appears to date from {min(years)}"
                       + (f"–{max(years)}" if max(years) != min(years) else ""), "data_age"))

    # --- Inclusion / exclusion criteria (human studies)
    if human:
        if not has(r"inclusion", where) or not has(r"exclusion|excluded", where):
            issues.append(("Study details", "Inclusion/exclusion criteria", "Missing",
                           "Inclusion and/or exclusion criteria not found in the Methods", "inclusion_exclusion"))

    # --- Questionnaires / interviews
    q_text = sentences_with(r"questionnaire|survey|interview|likert|scale was used", body)
    if q_text and not has(r"supplementa|appendix|annex", q_text):
        issues.append(("Study details", "Questionnaire", "Concern",
                       "Study uses a questionnaire/survey/interview, but it is not mentioned as supplied", "questionnaire"))

    # --- Animal studies
    if animal and not has(r"euthan|sacrific|humane end", body):
        issues.append(("Study details", "Euthanasia", "Concern",
                       "Animal study without a euthanasia/humane endpoint statement", "euthanasia"))

    # --- Registration: only when the study type needs it
    if has(r"randomi[sz]ed (controlled )?trial|clinical trial|\bRCT\b", body):
        if not has(r"CTRI/\d{4}|NCT\d{8}|ISRCTN\d+|ACTRN\d+|ChiCTR|DRKS\d+|EudraCT|trial registration", body):
            issues.append(("Study details", "Trial registration", "Missing",
                           "Appears to be a clinical trial; no registration number found", "trial_registration"))
    if has(r"systematic review|meta-analys", body):
        if not has(r"PROSPERO|CRD\d{8,}", body):
            issues.append(("Study details", "PROSPERO registration", "Missing",
                           "Appears to be a systematic review; no PROSPERO number found", "prospero"))
    return issues


# The reference checks moved to step6_citations.py (numbered and author-date styles).
from step6_citations import check_references   # noqa: E402  (kept importable from here)


def run_all(path):
    sections, doc = split_into_sections(path)
    return check_declarations(sections) + check_study_details(sections) + check_references(sections, doc)


def main():
    if len(sys.argv) < 2:
        print("Usage: python step4_declarations.py <manuscript.docx>")
        return
    path = sys.argv[1]
    try:
        issues = run_all(path)
    except Exception as e:
        print(f"Could not read '{path}': {e}")
        return

    print(f"\nFile: {path}\n")
    if not issues:
        print("No declaration/study-detail issues found.")
        return
    print(f"{len(issues)} issue(s):\n")
    for section, check, status, details, _rule in issues:
        print(f"[{status}] {section} - {check}: {details}")


if __name__ == "__main__":
    main()
