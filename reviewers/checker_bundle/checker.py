"""
Manuscript Checker
Runs ALL checks against a journal profile and writes one Excel report.

How to run (in a terminal, from this folder):
    python checker.py my_manuscript.docx                 -> one manuscript
    python checker.py my_folder                          -> every .docx in the folder
    python checker.py my_folder --profile strict_screening   -> check against another profile
    python checker.py --profiles                         -> list the available profiles
    python checker.py my_folder --word                   -> also save a Word report (screening_report.docx)
    python checker.py my_folder --sheets                 -> also send results to Google Sheets

Profiles live in the profiles/ folder; settings.json picks the default one.
The report is saved as  screening_report.xlsx  in this folder.
"""

import sys
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

from step1_split_sections import split_into_sections
from step2_figures_tables import check_figures_tables
from step3_abbreviations import check_abbreviations
from step4_declarations import check_declarations, check_study_details, article_type
from step6_citations import check_references
from step7_policies import check_policies
from step8_guidelines import check_guidelines
from step9_integrity import check_integrity
from step10_formatting import check_formatting
from step11_submission import file_role, check_title_page, check_cover_letter
from step5_anonymisation import check_leftover_markup, check_anonymisation
from settings import load_settings, list_profiles
from readers import READABLE
from rules import Issue, SEVERITY_LABEL, FIXES

# Order the report goes in, section by section; within a section, most serious first
ORDER = ["Title page", "Cover letter", "Structure", "Integrity", "Anonymisation", "Formatting", "Abstract", "Abbreviations (Abstract)", "Abbreviations (Main text)",
         "Figures & tables", "Declarations", "Reporting guideline", "Study details", "References"]
SEVERITY_RANK = {"must": 0, "should": 1, "advisory": 2}


# Below this much readable text, a file with image-only pages is treated as unreadable rather than screened
MIN_SCREENABLE_TEXT = 2000


def find_issues(path, profile, name=None, info=None):
    """Run every check. Returns a list of Issues, before the profile's severities are applied.
    `name` is the original file name (its extension says the format) when `path` is a temporary file;
    `info`, if given, is filled in with what the file was read as: role (manuscript / title page / cover letter)
    and format (Word, PDF…)."""
    settings = profile.get("settings", {})
    sections, doc = split_into_sections(path, name)
    found_issues = []
    # Fail closed when the parser yields no manuscript text. Otherwise a scanned
    # PDF can misleadingly generate dozens of "missing" editorial requirements.
    extracted_text = " ".join(text for _, paras in sections for text in paras).strip()
    if not extracted_text:
        if info is not None:
            info.update(role="unreadable", format=getattr(doc, "kind", "") or "Word",
                        extraction_status="failed")
        return [Issue("Structure", "Text extraction", "Unable to screen",
                      "No extractable manuscript text was found. The file may be scanned, "
                      "image-only, blank, or unsupported by this reader. Do not interpret "
                      "this as a completed manuscript screening; provide a text-based file.",
                      "extraction_failed")]
    # A partially readable PDF is not a reliably screened manuscript: text on a cover page must not mask scanned
    # body pages. But a normal manuscript often ends with full-page figures, which look the same page by page, so
    # screening stops only when the image pages are at least half the file or too little text was read; otherwise
    # it goes on and says which pages it couldn't read.
    unreadable_pages = getattr(doc, "unreadable_image_pages", [])
    page_count = getattr(doc, "page_count", 0) or len(unreadable_pages)
    partial_warning = None
    if unreadable_pages and len(unreadable_pages) * 2 < page_count and len(extracted_text) >= MIN_SCREENABLE_TEXT:
        partial_warning = Issue("Structure", "Text extraction", "Concern",
                                f"Page{'s' if len(unreadable_pages) > 1 else ''} {', '.join(map(str, unreadable_pages))} "
                                f"of {page_count} {'are' if len(unreadable_pages) > 1 else 'is'} mostly an image (a figure, "
                                "or scanned text). Any text there wasn't read, so check those pages yourself; a finding "
                                "that something is missing could be wrong if it is only on those pages.",
                                "extraction_partial")
    elif unreadable_pages:
        if info is not None:
            info.update(role="unreadable", format="PDF", extraction_status="partial")
        return [Issue("Structure", "Text extraction", "Unable to screen",
                      "PDF page(s) with unreadable or predominantly image-based content " + ", ".join(map(str, unreadable_pages)) +
                      " contain no extractable text. Screening stopped to avoid "
                      "misleading missing-section findings. Provide a text-based manuscript.",
                      "extraction_failed")]
    role = file_role(sections)
    if info is not None:
        info.update(role=role, format=getattr(doc, "kind", "") or "Word")
        if partial_warning:
            info.update(extraction_status="partial", unreadable_pages=list(unreadable_pages))
    if partial_warning:
        found_issues.append(partial_warning)
    for note in getattr(doc, "notes", []):
        found_issues.append(Issue("Structure", "File format", "Concern", note, "input_format"))

    # A title page or cover letter gets its own short checks, not the manuscript checks
    if role != "manuscript":
        own = check_title_page(sections) if role == "title page" else check_cover_letter(sections)
        for section, check, status, details, rule in own + check_leftover_markup(doc) + check_integrity(sections, doc, settings):
            found_issues.append(Issue(section, check, status, details, rule))
        return found_issues

    # Structure: sections this profile requires for this type of article
    # (a combined "Results and discussion" counts as both)
    found = {name for name, _ in sections}
    if "Results and discussion" in found:
        found |= {"Results", "Discussion"}
    required = profile.get("required_sections", {}).get(article_type(sections), [])
    for s in required:
        if s not in found:
            where = "Abstract" if s in ("Abstract", "Keywords") else "Structure"
            rule = {"Abstract": "abstract_missing", "Keywords": "keywords_missing"}.get(s, "section_missing")
            found_issues.append(Issue(where, f"{s} section", "Missing", f"No '{s}' heading found", rule))

    # Abstract word count (an article type can have its own limit: settings -> limits -> <type> -> abstract_words)
    type_limits = (settings.get("limits") or {}).get(article_type(sections)) or {}
    limit = int(type_limits.get("abstract_words") or settings.get("abstract_word_limit", 250))
    abstract_words = sum(len(t.split()) for name, paras in sections if name == "Abstract" for t in paras)
    if abstract_words > limit:
        found_issues.append(Issue("Abstract", "Abstract length", "Concern",
                                  f"Abstract is {abstract_words} words (limit {limit})", "abstract_length"))

    # Abbreviations
    for where, check, status, details, rule in check_abbreviations(path, settings, sections):
        found_issues.append(Issue(f"Abbreviations ({where})", check, status, details, rule))

    # Figures and tables
    _, _, fig_issues = check_figures_tables(path, sections, doc)
    for check, status, details, rule in fig_issues:
        found_issues.append(Issue("Figures & tables", check, status, details, rule))

    # Tracked changes and comments (every manuscript); anonymisation (double-blind review only)
    anonymity = check_leftover_markup(doc)
    if settings.get("review_model", "single_blind") == "double_blind":
        anonymity += check_anonymisation(sections, doc)

    # Declarations, study details, references
    for section, check, status, details, rule in (anonymity + check_declarations(sections)
                                                  + check_study_details(sections, settings)
                                                  + check_policies(sections, doc, settings)
                                                  + check_guidelines(sections, doc, settings)
                                                  + check_integrity(sections, doc, settings)
                                                  + check_formatting(sections, doc, settings)
                                                  + check_references(sections, doc, settings)):
        found_issues.append(Issue(section, check, status, details, rule))
    return found_issues


def apply_profile(found_issues, profile):
    """Give each issue the severity the profile sets for its rule, and drop rules that are switched off."""
    rules = profile.get("rules", {})
    if any(issue.rule == "extraction_failed" for issue in found_issues):
        return [issue._replace(severity="must") for issue in found_issues
                if issue.rule == "extraction_failed"]
    issues = []
    for issue in found_issues:
        severity = rules.get(issue.rule, "should")     # a rule the profile doesn't mention: Should fix
        if severity != "off":
            issues.append(issue._replace(severity=severity))
    issues.sort(key=lambda i: (ORDER.index(i.section) if i.section in ORDER else len(ORDER),
                               SEVERITY_RANK[i.severity]))
    return issues


def check_file(path, profile=None, name=None):
    """Check one file. Returns (issues, info): info says what the file was read as (role, format)."""
    if not isinstance(profile, dict):
        profile = load_settings(profile)
    info = {}
    return apply_profile(find_issues(path, profile, name, info), profile), info


def check_manuscript(path, profile=None, name=None):
    """Check one manuscript. `profile` is a profile dict (from settings.load_settings), a profile
    ID such as "strict_screening", or None for the default profile chosen in settings.json."""
    return check_file(path, profile, name)[0]


def verdict(issues):
    """Ready unless something is Must fix or Should fix; advisories alone don't block. A file whose text couldn't be
    read is "Unable to screen": nothing was checked, so it is neither ready nor in need of revision."""
    if any(i.rule == "extraction_failed" for i in issues):
        return "Unable to screen"
    return "Needs revision" if any(i.severity in ("must", "should") for i in issues) else "Ready"


def counts(issues):
    return {s: sum(1 for i in issues if i.severity == s) for s in ("must", "should", "advisory")}


# ---------------------------------------------------------------------------
# Excel formatting
# ---------------------------------------------------------------------------
FILLS = {
    "must":     PatternFill("solid", fgColor="F8CBAD"),   # red-ish
    "should":   PatternFill("solid", fgColor="FFE699"),   # amber
    "advisory": PatternFill("solid", fgColor="DDEBF7"),   # pale blue
    "OK":       PatternFill("solid", fgColor="C6EFCE"),   # green
}
HEADER_FILL = PatternFill("solid", fgColor="1F3864")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")


def safe_sheet_name(name, used):
    """Excel sheet names: max 31 characters, no []:*?/\\ and must be unique."""
    for ch in "[]:*?/\\":
        name = name.replace(ch, "_")
    name = name[:28] or "Manuscript"
    candidate, n = name, 2
    while candidate in used:
        candidate, n = f"{name[:26]}_{n}", n + 1
    used.add(candidate)
    return candidate


def count_text(issues):
    c = counts(issues)
    return f"{len(issues)} total ({c['must']} must fix, {c['should']} should fix, {c['advisory']} advisory)"


def read_as(info):
    """'manuscript (Word)', 'cover letter (PDF)'…"""
    info = info or {}
    return f"{info.get('role', 'manuscript')} ({info.get('format', 'Word')})"


def write_sheet(ws, filename, issues, profile_name, info=None):
    result = verdict(issues)

    # Summary block at the top
    ws["A1"] = "File";       ws["B1"] = filename
    ws["A2"] = "Read as";    ws["B2"] = read_as(info)
    ws["A3"] = "Profile";    ws["B3"] = profile_name
    ws["A4"] = "Result";     ws["B4"] = result
    ws["A5"] = "Issues";     ws["B5"] = count_text(issues)
    for r in range(1, 6):
        ws.cell(r, 1).font = Font(bold=True)
    ws["B4"].fill = FILLS["OK"] if result == "Ready" else FILLS["must"]
    ws["B4"].font = Font(bold=True)

    # Table header
    headers = ["Section", "Check", "Severity", "Status", "Details", "How to fix", "Source"]
    for col, h in enumerate(headers, start=1):
        c = ws.cell(7, col, h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = HEADER_FILL
        c.border = BORDER
        c.alignment = WRAP

    # One row per issue
    row = 8
    if not issues:
        ws.cell(row, 1, "All checks passed").font = Font(italic=True)
    for i in issues:
        fix, source = FIXES.get(i.rule, ("", ""))
        values = [i.section, i.check, SEVERITY_LABEL[i.severity], i.status, i.details, fix, source]
        for col, value in enumerate(values, start=1):
            c = ws.cell(row, col, value)
            c.border = BORDER
            c.alignment = WRAP
        ws.cell(row, 3).fill = FILLS[i.severity]
        row += 1

    for col, width in zip("ABCDEFG", [22, 26, 12, 10, 70, 60, 26]):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A8"
    ws.auto_filter.ref = f"A7:G{max(row - 1, 7)}"


def build_workbook(results, profile_name="", infos=None):
    """results = list of (file name, issues), where issues is None if the file couldn't be read;
    infos = {file name: what it was read as}. Returns an openpyxl Workbook: one sheet per file,
    plus a Summary sheet for batches."""
    infos = infos or {}
    wb = Workbook()
    wb.remove(wb.active)
    used_names = set()
    summary = []
    for name, issues in results:
        if issues is None:
            summary.append((name, "Could not read", "", "", "", ""))
            continue
        ws = wb.create_sheet(safe_sheet_name(Path(name).stem, used_names))
        write_sheet(ws, name, issues, profile_name, infos.get(name))
        c = counts(issues)
        summary.append((name, verdict(issues), c["must"], c["should"], c["advisory"], read_as(infos.get(name))))

    if len(results) > 1:
        ws = wb.create_sheet("Summary", 0)
        for col, h in enumerate(["File", "Result", "Must fix", "Should fix", "Advisory", "Read as"], start=1):
            c = ws.cell(1, col, h)
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = HEADER_FILL
        for r, rowdata in enumerate(summary, start=2):
            for col, v in enumerate(rowdata, start=1):
                ws.cell(r, col, v)
            ws.cell(r, 2).fill = FILLS["OK"] if rowdata[1] == "Ready" else FILLS["must"]
        ws.cell(len(summary) + 3, 1, f"Profile: {profile_name}").font = Font(italic=True)
        ws.column_dimensions["A"].width = 45
        ws.column_dimensions["B"].width = 16
        for col in "CDE":
            ws.column_dimensions[col].width = 11
        ws.column_dimensions["F"].width = 26
    return wb


def build_word_report(results, profile_name="", infos=None):
    """The same report as a Word document, for sending to authors or printing."""
    from datetime import date
    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.shared import Inches, Pt, RGBColor
    infos = infos or {}
    doc = Document()
    section = doc.sections[0]
    section.orientation = WD_ORIENT.LANDSCAPE
    section.page_width, section.page_height = section.page_height, section.page_width
    doc.styles["Normal"].font.size = Pt(10)
    doc.add_heading("Manuscript screening report", 0)
    doc.add_paragraph(f"Profile: {profile_name}    ·    Date: {date.today():%d %B %Y}    ·    "
                      "A screening aid: issues are flagged for a person to review.")
    colours = {"must": RGBColor(0xC0, 0x39, 0x2B), "should": RGBColor(0xB7, 0x79, 0x0F),
               "advisory": RGBColor(0x2E, 0x6D, 0xA4)}
    for name, issues in results:
        doc.add_heading(name, 1)
        if issues is None:
            doc.add_paragraph("Could not be read. Check that it is a valid .docx, .pdf, .odt, .rtf or .tex file.")
            continue
        c = counts(issues)
        doc.add_paragraph(f"Read as: {read_as(infos.get(name))}.   Result: {verdict(issues)} "
                          f"({c['must']} must fix, {c['should']} should fix, {c['advisory']} advisory).")
        if not issues:
            doc.add_paragraph("All checks passed.")
            continue
        table = doc.add_table(rows=1, cols=4)
        table.style = "Light Grid Accent 1"
        for cell, text in zip(table.rows[0].cells, ["Severity", "Check", "What was found", "How to fix"]):
            cell.text = text
        for i in sorted(issues, key=lambda i: SEVERITY_RANK[i.severity]):      # most serious first
            fix, source = FIXES.get(i.rule, ("", ""))
            row = table.add_row().cells
            run = row[0].paragraphs[0].add_run(SEVERITY_LABEL[i.severity])
            run.bold = True
            run.font.color.rgb = colours[i.severity]
            row[1].text = f"{i.section}: {i.check}"
            row[2].text = i.details
            row[3].text = fix + (f" ({source})" if source and source != "—" else "")
        for row in table.rows:
            for cell, width in zip(row.cells, (Inches(0.9), Inches(2.0), Inches(3.3), Inches(3.3))):
                cell.width = width
    return doc


def option(name):
    """The value after --name on the command line, e.g. --profile strict_screening."""
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def main():
    if "--profiles" in sys.argv:
        print("Available profiles (use with --profile <id>):")
        for pid, pname in list_profiles().items():
            print(f"  {pid:<22} {pname}")
        return

    profile_id = option("--profile")
    args = [a for a in sys.argv[1:] if not a.startswith("--") and a != profile_id]
    to_sheets = "--sheets" in sys.argv
    if not args:
        print("Usage: python checker.py <manuscript or folder> [--profile <id>] [--word] [--sheets]")
        print("       python checker.py --profiles")
        return

    target = Path(args[0])
    if target.is_dir():
        files = sorted(p for p in target.iterdir() if p.suffix.lower() in READABLE and not p.name.startswith("~$"))
    else:
        files = [target]
    if not files:
        print(f"No manuscripts found in '{target}' ({', '.join(READABLE)}).")
        return

    try:
        profile = load_settings(profile_id)
    except (FileNotFoundError, ValueError) as e:
        print(f"Profile problem: {e}")
        return
    print(f"Profile: {profile['name']}\n")

    results = []          # (file name, issues or None)
    infos = {}            # file name -> what it was read as
    for f in files:
        try:
            issues, info = check_file(f, profile)
        except Exception as e:
            print(f"  Skipped {f.name}: could not read it ({e})")
            results.append((f.name, None))
            continue
        results.append((f.name, issues))
        infos[f.name] = info
        c = counts(issues)
        shown_as = "" if info["role"] == "manuscript" and info["format"] == "Word" else \
            f" [{info['role']}{', ' + info['format'] if info['format'] != 'Word' else ''}]"
        print(f"  {f.name}{shown_as}: {verdict(issues)} "
              f"({c['must']} must fix, {c['should']} should fix, {c['advisory']} advisory)")

    wb = build_workbook(results, profile["name"], infos)
    if not wb.sheetnames:
        print("Nothing to save.")
        return

    out = Path("screening_report.xlsx")
    try:
        wb.save(out)
    except PermissionError:
        print("Could not save: close screening_report.xlsx in Excel and run again.")
        return
    print(f"\nReport saved: {out.resolve()}")
    if "--word" in sys.argv:
        word = Path("screening_report.docx")
        build_word_report(results, profile["name"], infos).save(word)
        print(f"Word report saved: {word.resolve()}")

    readable = [(name, issues) for name, issues in results if issues is not None]
    if to_sheets and readable:
        from send_to_sheets import upload
        print()
        upload(readable, profile["name"])


if __name__ == "__main__":
    main()
