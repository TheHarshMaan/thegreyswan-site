"""
Manuscript Checker - the other files in a submission

A submission is often several files: the manuscript, a separate title page, a cover letter. This works
out which one a file is, so a cover letter isn't reported as "a manuscript with no Methods section".

  title page:   title, author names, affiliations, corresponding author and email (and ORCID iDs if required)
  cover letter: says the work is original and not under consideration elsewhere, and mentions conflicts of interest

How to run (in a terminal, from this folder):
    python step11_submission.py my_file.docx
"""

import re
import sys

from step1_split_sections import split_into_sections
from step5_anonymisation import title_page

I = re.IGNORECASE
MANUSCRIPT_SECTIONS = {"Abstract", "Introduction", "Methods", "Results", "Discussion", "Case presentation",
                       "Results and discussion", "Related work"}


def all_text(sections):
    return [t for _, paras in sections for t in paras]


def file_role(sections):
    """'manuscript', 'title page' or 'cover letter'."""
    names = {name for name, _ in sections}
    refs = [t for name, ps in sections if name == "References" for t in ps]
    if names & MANUSCRIPT_SECTIONS or refs:
        return "manuscript"          # title pages and cover letters never have a reference list
    paras = all_text(sections)
    text = " ".join(paras)
    words = len(text.split())
    opening = " ".join(paras[:8])
    if words < 1500 and re.search(r"\bdear (?:editor|dr|prof|professor|sir|madam|editors|colleagues)\b", opening, I) \
            and re.search(r"\bsubmit(?:ting|ted)?\b[^.]{0,100}\b(?:manuscript|paper|article|work)\b|"
                          r"for (?:your |possible )?consideration|manuscript (?:entitled|titled)", text, I):
        return "cover letter"
    found, _ = title_page(sections)
    if words < 900 and "author names" in found and \
            ("affiliations" in found or "email addresses" in found):
        return "title page"
    return "manuscript"


def check_title_page(sections):
    found, names = title_page(sections)
    missing = [item for item, ok in [("author names", "author names" in found), ("affiliations", "affiliations" in found),
                                     ("corresponding author and email", "corresponding author details" in found
                                      or "email addresses" in found)] if not ok]
    issues = []
    if missing:
        issues.append(("Title page", "Title page details", "Missing",
                       f"The title page doesn't show: {', '.join(missing)}", "title_page_items"))
    if "ORCID iDs" not in found:
        issues.append(("Title page", "ORCID iDs", "Missing", "The title page has no ORCID iDs for the authors", "orcid"))
    return issues


def check_cover_letter(sections):
    text = " ".join(all_text(sections))
    missing = []
    if not re.search(r"not (?:been )?(?:previously )?(?:published|under consideration|submitted|considered)|"
                     r"(?:is|are) original|has not been (?:published|submitted)|not (?:currently )?(?:being )?considered "
                     r"(?:for publication )?elsewhere|exclusively|not under review", text, I):
        missing.append("that the work is original and not under consideration elsewhere")
    if not re.search(r"conflicts? of interest|competing interests?|nothing to disclose|no (?:financial )?interests", text, I):
        missing.append("a conflict of interest statement")
    if missing:
        return [("Cover letter", "Cover letter statements", "Missing",
                 "The cover letter doesn't say " + " or ".join(missing), "cover_letter")]
    return []


def main():
    if len(sys.argv) < 2:
        print("Usage: python step11_submission.py <file>")
        return
    try:
        sections, doc = split_into_sections(sys.argv[1])
    except Exception as e:
        print(f"Could not read '{sys.argv[1]}': {e}")
        return
    role = file_role(sections)
    print(f"\nFile: {sys.argv[1]}\nRead as: {role}\n")
    issues = check_title_page(sections) if role == "title page" else \
        check_cover_letter(sections) if role == "cover letter" else []
    for section, check, status, details, _rule in issues:
        print(f"[{status}] {check}: {details}")


if __name__ == "__main__":
    main()
