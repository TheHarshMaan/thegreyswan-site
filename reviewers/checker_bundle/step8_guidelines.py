"""
Manuscript Checker - reporting guidelines (EQUATOR Network)

Works out the study design, then checks that:
  - the matching reporting guideline is named (e.g. "reported according to CONSORT")
  - the guideline's key items can be found in the text (e.g. CONSORT: flow diagram, randomisation
    method, allocation concealment, blinding, primary outcome, sample size calculation)

Designs and guidelines: randomised trial (CONSORT), trial protocol (SPIRIT), systematic review (PRISMA),
observational study (STROBE), case report (CARE), animal study (ARRIVE), diagnostic accuracy (STARD),
qualitative study (COREQ/SRQR), prediction model (TRIPOD), economic evaluation (CHEERS),
quality improvement (SQUIRE).

The item checks look for the words authors normally use. They are a prompt to look, not proof that
an item is missing: treat them as advisory.

How to run (in a terminal, from this folder):
    python step8_guidelines.py my_manuscript.docx
"""

import re
import sys

from step1_split_sections import split_into_sections
from step4_declarations import article_type, study_type, NO_PARTICIPANTS

I = re.IGNORECASE
FLOW = r"flow ?(?:diagram|chart)|consort diagram|prisma diagram|participant flow|study flow"
STATS = (r"statistical (?:analys|method)|regression|chi-?square|t-test|anova|mann-whitney|wilcoxon|kruskal|spss|stata|"
         r"\bR (?:version|software|package)|\bSAS\b|odds ratio|hazard ratio|confidence interval|p\s?[<=]")
MISSING = (r"missing (?:data|values|information|observations|responses|records|outcomes|answers)|complete[- ]case|"
           r"imputation|imputed|lost to follow|loss to follow|incomplete (?:data|records|responses) were")

# name, the guideline's own name pattern, [(item, pattern)]
GUIDELINES = {
    "CONSORT": (r"\bCONSORT\b", [
        ("flow diagram", FLOW),
        ("randomisation method", r"computer[- ]generated|random number|block randomi|stratified randomi|"
                                 r"randomi[sz]ation (?:sequence|list|schedule)|sequence (?:was )?generat"),
        ("allocation concealment", r"conceal|sealed|opaque envelope|central(?:ised|ized)? (?:randomi|allocation)|"
                                   r"web-based (?:randomi|allocation)|interactive (?:web|voice)"),
        ("blinding", r"\bblind|\bmask(?:ed|ing)\b|open[- ]label"),
        ("primary outcome", r"primary (?:outcome|end ?point)"),
        ("sample size calculation", r"sample size[^.]{0,80}(?:calculat|estimat|determin|power)|power (?:calculation|analysis)|"
                                    r"\d+\s?% power"),
    ]),
    "SPIRIT": (r"\bSPIRIT\b", [
        ("schedule of enrolment and assessments", r"schedule|spirit figure|timeline"),
        ("sample size", r"sample size"),
        ("primary outcome", r"primary (?:outcome|end ?point)"),
        ("dissemination plans", r"dissemina"),
    ]),
    "PRISMA": (r"\bPRISMA\b", [
        ("flow diagram", FLOW),
        ("databases searched", r"medline|pubmed|embase|scopus|web of science|cochrane library|cinahl|psycinfo|"
                               r"google scholar|databases? (?:were|was) searched"),
        ("eligibility criteria", r"eligib|inclusion criteria"),
        ("risk of bias assessment", r"risk of bias|quality assessment|critical appraisal|newcastle|\brob ?2|robins|"
                                    r"jadad|amstar|joanna briggs|quadas|casp\b"),
        ("certainty of evidence", r"\bGRADE\b|certainty of (?:the )?evidence"),
    ]),
    "STROBE": (r"\bSTROBE\b", [
        ("study design in the title or abstract", None),           # checked separately below
        ("statistical methods", STATS),
        ("missing data", MISSING),
        ("sources of bias", r"\bbias"),
    ]),
    "CARE": (r"\bCARE\b", [
        ("timeline", r"timeline"),
        ("patient perspective", r"patient(?:'s|’s)? (?:perspective|view|experience)|in (?:his|her|their) own words"),
        ("follow-up and outcome", r"follow[- ]up|outcome|recovered|discharged"),
    ]),
    "ARRIVE": (r"\bARRIVE\b", [
        ("species and strain", r"wistar|sprague|balb|c57|swiss|albino|kunming|\bicr\b|new zealand white|\bstrain\b"),
        ("sex of the animals", r"\b(?:male|female)s?\b"),
        ("randomisation", r"random"),
        ("blinding", r"\bblind|\bmask(?:ed|ing)\b"),
        ("housing and husbandry", r"housed|housing|cages?\b|light[/–-]dark|ad libitum|husbandry"),
        ("sample size justification", r"sample size|power (?:calculation|analysis)|\d+\s?% power"),
    ]),
    "STARD": (r"\bSTARD\b", [
        ("reference standard", r"reference standard|gold standard"),
        ("accuracy measures", r"sensitivity|specificity|predictive value|likelihood ratio|\bauc\b|area under|\broc\b"),
        ("flow diagram", FLOW),
    ]),
    "COREQ or SRQR": (r"\bCOREQ\b|\bSRQR\b", [
        ("researcher reflexivity", r"reflexiv|positionality|interviewers? (?:was|were)|researchers? (?:was|were|had)|"
                                   r"field notes"),
        ("data saturation", r"saturation"),
        ("analysis method", r"thematic|coding|codebook|framework analysis|grounded theory|content analysis|"
                            r"phenomenolog|nvivo|atlas\.ti"),
        ("interview or topic guide", r"interview guide|topic guide|semi-structured|focus group guide"),
    ]),
    "TRIPOD": (r"\bTRIPOD\b", [
        ("validation", r"validat"),
        ("discrimination", r"\bauc\b|c-statistic|c statistic|area under|discriminat|\broc\b"),
        ("calibration", r"calibrat"),
        ("missing data", MISSING),
    ]),
    "CHEERS": (r"\bCHEERS\b", [
        ("perspective", r"perspective"),
        ("time horizon", r"time horizon"),
        ("discount rate", r"discount"),
        ("sensitivity analysis", r"sensitivity analys"),
    ]),
    "SQUIRE": (r"\bSQUIRE\b", [
        ("context", r"context|setting"),
        ("intervention", r"intervention"),
        ("measures", r"measure"),
    ]),
}
DESIGN_NAMES = {"CONSORT": "randomised trial", "SPIRIT": "trial protocol", "PRISMA": "systematic review",
                "STROBE": "observational study", "CARE": "case report", "ARRIVE": "animal study",
                "STARD": "diagnostic accuracy study", "COREQ or SRQR": "qualitative study",
                "TRIPOD": "prediction model study", "CHEERS": "economic evaluation", "SQUIRE": "quality improvement study"}


def text_of(sections, *names, skip=("References",)):
    if names:
        return " ".join(t for name, paras in sections if name in names for t in paras)
    return " ".join(t for name, paras in sections if name not in skip for t in paras)


def study_design(sections):
    """The reporting guideline that fits the study, or None (letters, narrative reviews, unclear designs)."""
    kind = article_type(sections)
    if kind in NO_PARTICIPANTS or kind == "data paper":
        return None
    if kind == "case report":
        return "CARE"
    front = [t for name, paras in sections if name == "Front matter" for t in paras]
    title = front[0] if front else ""
    lead = title + " " + text_of(sections, "Abstract")
    body = text_of(sections)
    methods = text_of(sections, "Methods") or body
    _, animal, _ = study_type(sections)

    if re.search(r"\bprotocol\b", title, I):
        return "PRISMA" if re.search(r"systematic review|meta-analys|scoping review", title, I) else "SPIRIT"
    if re.search(r"systematic review|meta-analys|scoping review", lead, I):
        return "PRISMA"
    if re.search(r"randomi[sz]ed (?:controlled |clinical |cluster |crossover )?trial|randomly (?:assigned|allocated)|\bRCT\b",
                 lead + " " + methods, I):
        return "CONSORT"
    if animal and re.search(r"in vivo|mice|rats|animals were|animal model", methods, I):
        return "ARRIVE"
    if re.search(r"diagnostic (?:accuracy|performance)|sensitivity and specificity|reference standard", lead, I):
        return "STARD"
    if re.search(r"prediction model|prognostic model|predictive model|risk score|nomogram|risk prediction", lead, I):
        return "TRIPOD"
    if re.search(r"cost[- ]effectiveness|cost[- ]utility|economic evaluation|\bQALYs?\b|cost[- ]benefit", lead, I):
        return "CHEERS"
    if re.search(r"qualitative|focus groups?|in-depth interviews?|thematic analysis|semi-structured interviews?", lead + " " + methods, I):
        return "COREQ or SRQR"
    if re.search(r"quality improvement", lead, I):
        return "SQUIRE"
    if re.search(r"cohort|case[- ]control|cross[- ]sectional|observational|retrospective|prospective|registry|"
                 r"\bsurvey\b|longitudinal|record review|chart review", lead + " " + methods, I):
        return "STROBE"
    return None


def check_guidelines(sections, doc=None, settings=None):
    """Returns (section, check, status, details, rule ID) tuples."""
    guideline = study_design(sections)
    if not guideline:
        return []
    issues = []
    name_pattern, items = GUIDELINES[guideline]
    body = text_of(sections)
    design = DESIGN_NAMES[guideline]

    if not re.search(name_pattern, body) and not re.search(r"\bEQUATOR\b", body):
        issues.append(("Reporting guideline", "Guideline named", "Concern",
                       f"Possible {guideline} reporting-guideline declaration not detected for this {design}. "
                       "Confirm the study design and the target journal's checklist/submission requirements; "
                       "a missing keyword alone does not establish noncompliance", "reporting_guideline"))

    missing = []
    front = [t for name, paras in sections if name == "Front matter" for t in paras]
    lead = (front[0] if front else "") + " " + text_of(sections, "Abstract")
    for item, pattern in items:
        if pattern is None:      # STROBE: the design should be named in the title or abstract
            if not re.search(r"cohort|case[- ]control|cross[- ]sectional|observational|longitudinal|registry", lead, I):
                missing.append(item)
        elif not re.search(pattern, body, I):
            missing.append(item)
    if missing:
        issues.append(("Reporting guideline", "Guideline items", "Concern",
                       f"Possible {guideline} reporting items not located by keyword screening: {', '.join(missing)}. "
                       "Review the manuscript and any supplementary checklist manually; these items may be "
                       "reported using different terminology", "guideline_items"))
    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python step8_guidelines.py <manuscript.docx>")
        return
    try:
        sections, doc = split_into_sections(sys.argv[1])
    except Exception as e:
        print(f"Could not read '{sys.argv[1]}': {e}")
        return
    print(f"\nFile: {sys.argv[1]}\nStudy design: {DESIGN_NAMES.get(study_design(sections), 'not identified')}\n")
    for section, check, status, details, _rule in check_guidelines(sections, doc):
        print(f"[{status}] {check}: {details}")


if __name__ == "__main__":
    main()
