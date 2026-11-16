"""
Manuscript Checker - Milestone 2 (part 1)
Checks that figures and tables are cited in the text, in order, with no gaps.

How to run (in a terminal, from this folder):
    python step2_figures_tables.py my_manuscript.docx
"""

import sys
import re
from step1_split_sections import split_into_sections   # reuse your step 1 code

# Matches "Figure 1", "Fig. 2", "Figs 3-5", "Table 1", "Tables 2 and 3",
# "Figures 1, 2 and 4", "Supplementary Figure 1" is skipped on purpose.
MENTION = re.compile(
    r"(?<!Supplementary )\b(Fig(?:ure)?s?\.?|Tables?)\s*"
    r"(\d+(?:\s*(?:,|and|&|–|-|to)\s*\d+)*)",
    re.IGNORECASE,
)

# A caption is a paragraph that STARTS with "Figure 2." / "Fig. 2:" / "Table 1 "
CAPTION = re.compile(r"^(Fig(?:ure)?\.?|Table)\s*(\d+)\s*[.:\-–|]?\s", re.IGNORECASE)


def kind_of(label):
    """Turn 'Fig.', 'Figures', 'tables' into 'Figure' or 'Table'."""
    return "Table" if label.lower().startswith("tab") else "Figure"


def numbers_in(text):
    """'1, 2 and 4' -> [1, 2, 4];  '3-5' or '3–5' -> [3, 4, 5]."""
    nums = []
    parts = re.split(r"\s*(?:,|and|&)\s*", text)
    for part in parts:
        rng = re.match(r"(\d+)\s*(?:–|-|to)\s*(\d+)", part)
        if rng:
            start, end = int(rng.group(1)), int(rng.group(2))
            if start <= end and end - start < 20:      # guard against odd text
                nums.extend(range(start, end + 1))
        elif part.strip().isdigit():
            nums.append(int(part.strip()))
    return nums


def check_figures_tables(path, sections=None, doc=None):
    """`sections` and `doc` can be passed in when the manuscript has already been read."""
    if sections is None:
        sections, doc = split_into_sections(path)

    cited = {"Figure": [], "Table": []}       # in order of first appearance
    captions = {"Figure": set(), "Table": set()}

    for name, paragraphs in sections:
        if name == "References":
            continue                          # "Table 2" in a reference title isn't a citation
        for text in paragraphs:
            cap = CAPTION.match(text)
            if cap:
                captions[kind_of(cap.group(1))].add(int(cap.group(2)))
                continue                      # a caption is not a citation
            for m in MENTION.finditer(text):
                kind = kind_of(m.group(1))
                for n in numbers_in(m.group(2)):
                    if n not in cited[kind]:
                        cited[kind].append(n)

    issues = []   # each issue: (check, status, details, rule ID)

    for kind in ["Figure", "Table"]:
        order = cited[kind]
        all_nums = set(order) | captions[kind]
        if not all_nums:
            continue

        # 1. Gaps in numbering
        expected = set(range(1, max(all_nums) + 1))
        for n in sorted(expected - all_nums):
            issues.append((f"{kind} numbering", "Missing",
                           f"{kind} {n} is never mentioned, but higher numbers are", "figtab_numbering"))

        # 2. Order of first citation
        if order != sorted(order):
            issues.append((f"{kind} order", "Concern",
                           f"First cited in this order: {', '.join(map(str, order))}", "figtab_order"))

        # 3. Caption present but never cited
        for n in sorted(captions[kind] - set(order)):
            issues.append((f"{kind} citation", "Missing",
                           f"{kind} {n} has a caption but is not cited in the text", "figtab_not_cited"))

        # 4. Cited but no caption (only checked if the manuscript has captions at all)
        if captions[kind]:
            for n in sorted(set(order) - captions[kind]):
                issues.append((f"{kind} caption", "Concern",
                               f"{kind} {n} is cited but no caption was found", "figtab_no_caption"))

    # 5. Real Word tables vs tables cited
    if len(doc.tables) > len(cited["Table"]):
        issues.append(("Table citation", "Concern",
                       f"{len(doc.tables)} table(s) in the file, "
                       f"{len(cited['Table'])} cited in the text", "table_count"))

    return cited, captions, issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python step2_figures_tables.py <manuscript.docx>")
        return

    path = sys.argv[1]
    try:
        cited, captions, issues = check_figures_tables(path)
    except Exception as e:
        print(f"Could not read '{path}': {e}")
        return

    print(f"\nFile: {path}\n")
    for kind in ["Figure", "Table"]:
        print(f"{kind}s cited (in order): {cited[kind] or 'none'}")
        print(f"{kind} captions found:     {sorted(captions[kind]) or 'none'}")
    print()

    if not issues:
        print("No figure/table issues found.")
        return

    print(f"{len(issues)} issue(s):\n")
    for check, status, details, _rule in issues:
        print(f"[{status}] {check}: {details}")


if __name__ == "__main__":
    main()
