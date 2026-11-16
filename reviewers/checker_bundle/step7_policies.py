"""
Manuscript Checker - declarations and policies that journals have added in recent years

  - a statement on the use of generative AI tools
  - author contributions using the CRediT roles
  - a corresponding author (and ORCID iDs) on the title page
  - data shared only "on request", and code availability
  - consent for publication in case reports
  - trial registered before the study started
  - Declaration of Helsinki, and sex/gender reporting (SAGER) for human studies
  - permission for figures reproduced from elsewhere
  - grant numbers for funded work

How to run (in a terminal, from this folder):
    python step7_policies.py my_manuscript.docx
"""

import re
import sys

from step1_split_sections import split_into_sections
from step4_declarations import has, sentences_with, study_type, article_type
from step5_anonymisation import title_page, BLINDED

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                                      "dec"], start=1)}
MONTH = r"(January|February|March|April|May|June|July|August|September|October|November|December|" \
        r"Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?"

AI_TOOLS = (r"generative (?:ai|artificial intelligence)|\bgen ?ai\b|chat ?gpt|\bgpt-?\d|large language models?|\bllms?\b|"
            r"ai[- ]assisted|ai[- ]based (?:writing|language)|\bai tools?\b|artificial intelligence (?:\(ai\) )?tools?|"
            r"copilot|gemini|claude|grammarly|quillbot|paperpal|writefull|deepseek")
AI_STATEMENT = re.compile(rf"(?:{AI_TOOLS})[^.]{{0,160}}\b(?:used|use|using|employed|assist|declare|disclos|not|no)\b"
                          rf"|\b(?:no|not use|did not|were not|was not|without)\b[^.]{{0,80}}(?:{AI_TOOLS})",
                          re.IGNORECASE)

CREDIT_ROLES = [r"conceptuali[sz]ation", r"data curation", r"formal analysis", r"funding acquisition", r"investigation",
                r"methodology", r"project administration", r"\bresources\b", r"\bsoftware\b", r"supervision",
                r"\bvalidation\b", r"visuali[sz]ation", r"original draft", r"review (?:&|and) editing"]

CODE_USE = (r"\b(?:custom|in-house|our|bespoke) (?:code|scripts?|software|pipeline|algorithm|model)\b|\bsource code\b|"
            r"\b(?:model|network|classifier|algorithm|transformer|cnn|llm)s? (?:was|were) (?:trained|fine-tuned)\b|\bimplemented in (?:python|r|matlab|julia|c\+\+)\b|\bpytorch\b|\btensorflow\b|"
            r"\bscikit-learn\b|\bkeras\b|\bgithub\b|\bjupyter\b")
# A code statement has to be about code: "code is available at…", "scripts are on GitHub (…)"
CODE_STATEMENT = re.compile(r"code availability|software availability|"
                            r"\b(?:code|scripts?|software|notebooks?|models?)\b[^.]{0,120}"
                            r"(?:availab|github|gitlab|zenodo|figshare|codeocean|repository|https?://)", re.IGNORECASE)


def body_text(sections, skip=("References",)):
    return " ".join(t for name, paras in sections if name not in skip for t in paras)


def section_text(sections, *names):
    return " ".join(t for name, paras in sections if name in names for t in paras)


def study_start(methods):
    """(year, month) the study started, from phrases like 'between January 2024 and…' or 'from 2021 to…'."""
    m = re.search(rf"(?:between|from|since|starting|started|began|commenced|enrolled|recruited|conducted)\s+"
                  rf"(?:on\s+)?(?:\d{{1,2}}(?:st|nd|rd|th)?\s+)?{MONTH}\s+((?:19|20)\d{{2}})", methods, re.IGNORECASE)
    if m:
        return int(m.group(2)), MONTHS[m.group(1)[:3].lower()]
    m = re.search(r"(?:between|from|since|in)\s+((?:19|20)\d{2})\b", methods, re.IGNORECASE)
    return (int(m.group(1)), None) if m else None


def check_policies(sections, doc=None, settings=None):
    """Returns (section, check, status, details, rule ID) tuples."""
    issues = []
    body = body_text(sections)
    kind = article_type(sections)
    human, animal, _ = study_type(sections)
    review = has(r"systematic review|meta-analys|scoping review|narrative review", body)

    # --- Generative AI statement
    if not AI_STATEMENT.search(body):
        issues.append(("Declarations", "AI use statement", "Concern",
                       "No generative-AI disclosure statement detected. Check the target journal policy; "
                       "a statement is not universally required when no tools were used", "ai_disclosure"))

    # --- CRediT roles in the author contributions
    contributions = section_text(sections, "Author contributions") or sentences_with(r"contribut", body)
    single_author = re.search(r"\b(?:sole|single|only) (?:author|contributor)|\bthe author (?:is|was|conceived|wrote|"
                              r"designed|carried out|did)\b", contributions, re.IGNORECASE)
    if contributions and not BLINDED.search(contributions) and not single_author:
        roles = sum(1 for r in CREDIT_ROLES if re.search(r, contributions, re.IGNORECASE))
        if roles < 2:
            issues.append(("Declarations", "CRediT roles", "Concern",
                           "Author contributions don't use the CRediT roles (e.g. Conceptualization, Methodology, "
                           "Formal analysis, Writing – original draft)", "credit_roles"))

    # --- Corresponding author and ORCID on the title page (only when there is a title page)
    found, names = title_page(sections)
    if "author names" in found:
        if "corresponding author details" not in found and "email addresses" not in found:
            issues.append(("Declarations", "Corresponding author", "Missing",
                           "The title page lists the authors but no corresponding author and email", "corresponding_author"))
        if "ORCID iDs" not in found:
            issues.append(("Declarations", "ORCID iDs", "Missing", "The title page has no ORCID iDs for the authors",
                           "orcid"))

    # --- Data "available on request"
    data = section_text(sections, "Data availability") or sentences_with(r"data availab|available (?:from|on)", body)
    if re.search(r"(?:on|upon) (?:reasonable )?request", data, re.IGNORECASE) and \
            not re.search(r"repository|deposited|doi\.org|zenodo|figshare|dryad|osf\.io|github|accession", data,
                          re.IGNORECASE):
        issues.append(("Declarations", "Data on request", "Concern",
                       "Data are available only on request. Check whether the target journal requires repository deposition",
                       "data_on_request"))

    # --- Code availability
    if re.search(CODE_USE, body, re.IGNORECASE) and not CODE_STATEMENT.search(body):
        issues.append(("Declarations", "Code availability", "Missing",
                       "The study uses code or trained models, but there is no code availability statement",
                       "code_availability"))

    # --- Consent for publication (case reports)
    if kind == "case report" and not has(r"consent (?:for|to) (?:the )?publi|publication consent|consent to publish|"
                                         r"agreed to (?:the )?publication|permission (?:for|to) publi", body):
        issues.append(("Declarations", "Consent for publication", "Missing",
                       "Case reports need the patient's (or guardian's) consent for publication", "consent_publication"))

    # --- Trial registered before the study started
    methods = section_text(sections, "Methods") or body
    registered_late = None
    if has(r"retrospectively registered|registered retrospectively", body):
        registered_late = "The trial is described as retrospectively registered"
    else:
        reg = re.search(r"CTRI/((?:19|20)\d{2})/(\d{1,2})/", body)
        start = study_start(methods)
        if reg and start:
            reg_ym = (int(reg.group(1)), int(reg.group(2)))
            if (start[1] and reg_ym > start) or (not start[1] and reg_ym[0] > start[0]):
                registered_late = (f"The registration ({reg.group(0)}…) dates from after the study started "
                                   f"({start[1] and list(MONTHS)[start[1] - 1].title() + ' ' or ''}{start[0]})")
    if registered_late:
        issues.append(("Study details", "Trial registration timing", "Concern",
                       registered_late + ". Most journals require registration before the first participant is enrolled",
                       "trial_registration_timing"))

    # --- Declaration of Helsinki and sex/gender reporting (human research)
    if human and kind in ("research", "short communication") and not review:
        if not has(r"helsinki", body):
            issues.append(("Declarations", "Declaration of Helsinki", "Concern",
                           "No Declaration of Helsinki statement detected. Check whether the target journal "
                           "requires an explicit declaration for this study design",
                           "helsinki"))
        if not has(r"\b(?:male|female|males|females|men|women|boys|girls|sex|gender)\b", body):
            issues.append(("Study details", "Sex and gender", "Concern",
                           "No participant sex/gender reporting detected (SAGER guidelines). Verify study "
                           "applicability and the target journal's reporting requirements",
                           "sex_gender"))

    # --- Permission for figures reproduced from elsewhere
    captions = [t for name, paras in sections for t in paras if re.match(r"^(?:Fig(?:ure)?|Table)\.?\s*\d+", t)]
    borrowed = [c for c in captions if re.search(r"reproduced|adapted|reprinted|modified from|source:|courtesy of|taken from",
                                                 c, re.IGNORECASE)
                and not re.search(r"permission|cc[- ]by|creative commons|open access|licen[cs]e", c, re.IGNORECASE)]
    if borrowed:
        issues.append(("Figures & tables", "Permission to reproduce", "Missing",
                       f"{len(borrowed)} caption(s) say the item was reproduced or adapted but don't mention permission "
                       f"or a licence: “{borrowed[0][:60]}…”", "figure_permission"))

    # --- Grant numbers
    funding = section_text(sections, "Funding") or sentences_with(r"\bfund|\bgrant\b|financial support", body)
    if re.search(r"funded by|supported by|grant|financial support from|sponsored by|funding from", funding, re.IGNORECASE) \
            and not re.search(r"\bno (?:specific )?(?:funding|grant)|not receive|received no|without (?:any )?funding|"
                              r"not (?:been )?funded|self-funded", funding, re.IGNORECASE) \
            and not re.search(r"\b(?:grant|award|project|contract)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*[A-Z0-9][\w/\-.]{3,}"
                              r"|\b[A-Z]{2,}[\-/ ]?\d{3,}[\w/\-]*", funding):
        issues.append(("Declarations", "Grant number", "Concern",
                       "The funding statement names funding but no grant number", "funding_details"))
    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python step7_policies.py <manuscript.docx>")
        return
    try:
        sections, doc = split_into_sections(sys.argv[1])
    except Exception as e:
        print(f"Could not read '{sys.argv[1]}': {e}")
        return
    issues = check_policies(sections, doc)
    print(f"\nFile: {sys.argv[1]}\n")
    for section, check, status, details, _rule in issues or [("", "", "", "No issues found.", "")]:
        print(f"[{status}] {check}: {details}" if check else details)


if __name__ == "__main__":
    main()
