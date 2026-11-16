"""
Manuscript Checker - research integrity red flags (for an editor's attention, not a verdict)

  - "tortured phrases": odd synonyms left by paraphrasing tools, a known sign of paper mills
    (e.g. "counterfeit consciousness" for artificial intelligence, "bosom malignant growth" for breast cancer)
  - text left over from AI chatbots ("As an AI language model…", "Certainly! Here is…")
  - hidden text (white, tiny or hidden font), including instructions aimed at AI reviewers
  - an AI tool listed as an author
  - a corresponding author using a free email address (advisory)
  - percentages that don't match their numbers ("45/120 (40.0%)"), and impossible values
  - a high share of self-citations

None of these proves misconduct. They tell an editor where to look.

How to run (in a terminal, from this folder):
    python step9_integrity.py my_manuscript.docx
"""

import re
import sys

from step1_split_sections import split_into_sections
from step5_anonymisation import title_page, EMAIL

I = re.IGNORECASE

# tortured phrase -> the usual term (from the Problematic Paper Screener literature)
TORTURED = {
    "counterfeit consciousness": "artificial intelligence", "human-made consciousness": "artificial intelligence",
    "manufactured brainpower": "artificial intelligence", "profound learning": "deep learning",
    "profound neural organization": "deep neural network", "fake neural organization": "artificial neural network",
    "colossal information": "big data", "enormous information": "big data", "huge information": "big data",
    "irregular woodland": "random forest", "arbitrary woodland": "random forest", "choice tree": "decision tree",
    "bolster vector machine": "support vector machine", "backing vector machine": "support vector machine",
    "mean square blunder": "mean square error", "mean squared blunder": "mean squared error",
    "flag to commotion": "signal to noise", "flag preparing": "signal processing", "haze figuring": "cloud computing",
    "cloud figuring": "cloud computing", "quantum figuring": "quantum computing", "dispersed figuring": "distributed computing",
    "subterranean insect state": "ant colony", "molecule swarm": "particle swarm", "hereditary calculation": "genetic algorithm",
    "direct relapse": "linear regression", "calculated relapse": "logistic regression", "pseudo-arbitrary": "pseudo-random",
    "irregular access memory": "random access memory", "remote sensor organization": "wireless sensor network",
    "web of things": "internet of things", "picture handling": "image processing", "facial acknowledgment": "face recognition",
    "discourse acknowledgment": "speech recognition", "head part examination": "principal component analysis",
    "quick fourier change": "fast Fourier transform", "nonstop wavelet change": "continuous wavelet transform",
    "unwavering quality": "reliability", "bosom malignant growth": "breast cancer", "bosom disease": "breast cancer",
    "lung malignant growth": "lung cancer", "prostate malignant growth": "prostate cancer",
    "colorectal malignant growth": "colorectal cancer", "kidney disappointment": "kidney failure",
    "renal disappointment": "renal failure", "heart disappointment": "heart failure", "liver disappointment": "liver failure",
    "lactose bigotry": "lactose intolerance", "glucose bigotry": "glucose intolerance", "amino corrosive": "amino acid",
    "nucleic corrosive": "nucleic acid", "lactic corrosive": "lactic acid", "greasy corrosive": "fatty acid",
    "tumor rot factor": "tumour necrosis factor", "tumour rot factor": "tumour necrosis factor",
    "irresistible illness": "infectious disease", "oxidative pressure": "oxidative stress",
    "invulnerable framework": "immune system", "insusceptible framework": "immune system", "safe framework": "immune system",
    "circulatory strain": "blood pressure", "intense kidney injury": "acute kidney injury",
    "myocardial localized necrosis": "myocardial infarction", "coronary illness": "heart disease",
    "danger factors": "risk factors", "creature model": "animal model", "sign transduction": "signal transduction",
}
TORTURED_RE = re.compile(r"\b(" + "|".join(re.escape(t) for t in sorted(TORTURED, key=len, reverse=True)) + r")\b", I)

AI_LEFTOVERS = re.compile(
    r"as an ai(?: language)? model|as a large language model|as of my (?:last )?(?:knowledge|training) (?:update|cut-?off)|"
    r"my knowledge cut-?off|i (?:do not|don't) have access to real-time|regenerate response|"
    r"certainly[!,.]? here (?:is|are)|here is (?:a|the) (?:revised|rewritten|improved) version|i hope this helps|"
    r"i cannot fulfil+|i'm unable to (?:provide|browse|access)|please note that as an ai|"
    r"\[insert [^\]]{1,40}\]|lorem ipsum", I)

PROMPT_INJECTION = re.compile(
    r"ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|prompts)|"
    r"give (?:a |only )?(?:positive|favou?rable) review|(?:recommend|suggest) (?:acceptance|accept)\b|"
    r"do not (?:highlight|mention) (?:any )?(?:negatives|weaknesses|limitations)|"
    r"(?:for|to) (?:llm|ai|language model) reviewers?|as an? (?:ai|llm) reviewer", I)

AI_NAMES = re.compile(r"\b(?:chat ?gpt|gpt-?\d|openai|claude|gemini|copilot|bard|llama|deepseek)(?![a-z])", I)

FREEMAIL = {"gmail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com",
            "rediffmail.com", "aol.com", "icloud.com", "protonmail.com", "proton.me", "163.com", "126.com", "qq.com",
            "mail.ru", "yandex.com", "gmx.com", "zoho.com"}

COUNT_WORDS = (r"patients?|participants?|respondents?|subjects?|cases?|samples?|isolates?|children|women|men|nurses|"
               r"students|doctors|people|individuals|adults|mothers|infants|households|specimens|animals|mice|rats")


def short(text, limit=80):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def all_paragraphs(doc):
    """Every paragraph in the body, tables, headers and footers."""
    if doc is None:
        return []
    paras = list(doc.paragraphs)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                paras.extend(cell.paragraphs)
    for section in getattr(doc, "sections", []):
        for part in (section.header, section.footer):
            try:
                paras.extend(part.paragraphs)
            except Exception:
                pass
    return paras


def hidden_runs(doc):
    """Text written in white, in a tiny font, or marked hidden."""
    found = []
    for p in all_paragraphs(doc):
        for run in getattr(p, "runs", []):
            text = (run.text or "").strip()
            if len(text) < 3:
                continue
            why = None
            try:
                rgb = run.font.color.rgb if run.font.color is not None and run.font.color.type is not None else None
            except Exception:
                rgb = None
            if rgb is not None and all(int(str(rgb)[i:i + 2], 16) >= 0xF0 for i in (0, 2, 4)):
                why = "white text"
            elif run.font.size is not None and run.font.size.pt <= 2:
                why = "text in a tiny font"
            elif run.font.hidden:
                why = "hidden text"
            if why:
                found.append((why, text))
    return found


def percentage_mismatches(text):
    """'45/120 (40.0%)', '45 of 120 patients (40%)' or 'Of the 312 nurses, 241 (77.2%)…' where the % is wrong."""
    wrong = []
    patterns = [
        r"(?P<a>\d[\d,]*)\s*/\s*(?P<b>\d[\d,]*)\s*\(\s*(?P<p>\d+(?:\.\d+)?)\s?%\s*\)",
        rf"(?P<a>\d[\d,]*) (?:of|out of) (?:the |all )?(?P<b>\d[\d,]*)(?: [a-z][a-z\- ]{{0,30}}?)?\s*\(\s*(?P<p>\d+(?:\.\d+)?)\s?%\s*\)",
        rf"\b[Oo]f (?:the |all |these )?(?P<b>\d[\d,]*) [a-z][a-z\- ]{{0,40}}?,\s*(?P<a>\d[\d,]*)\s*\(\s*(?P<p>\d+(?:\.\d+)?)\s?%\s*\)",
    ]
    for pattern in patterns:
        for m in re.finditer(pattern, text):
            a, b = int(m.group("a").replace(",", "")), int(m.group("b").replace(",", ""))
            reported = float(m.group("p"))
            if b == 0:
                continue
            decimals = len(m.group("p").split(".")[1]) if "." in m.group("p") else 0
            actual = 100 * a / b
            if a > b or abs(actual - reported) > 0.5 * 10 ** -decimals + 0.05:
                wrong.append(f"“{short(m.group(0), 50)}” (should be {actual:.{max(decimals, 1)}f}%)")
    return list(dict.fromkeys(wrong))


def impossible_values(text):
    found = []
    for m in re.finditer(rf"\b(\d{{3,}}(?:\.\d+)?)\s?% of (?:the |all )?(?:{COUNT_WORDS})\b", text, I):
        if float(m.group(1)) > 100:
            found.append(f"“{m.group(0)}”")
    for m in re.finditer(r"\bp\s?[=<>≤]\s?(\d+(?:\.\d+)?)\b", text, I):
        try:
            if float(m.group(1)) > 1:
                found.append(f"“{m.group(0)}”")
        except ValueError:
            pass
    return list(dict.fromkeys(found))


def check_integrity(sections, doc=None, settings=None):
    """Returns (section, check, status, details, rule ID) tuples."""
    issues = []
    body = " ".join(t for name, paras in sections if name != "References" for t in paras)
    everything = " ".join(t for _, paras in sections for t in paras)

    # --- Tortured phrases
    hits = {}
    for m in TORTURED_RE.finditer(body):
        hits.setdefault(m.group(1).lower(), 0)
        hits[m.group(1).lower()] += 1
    if hits:
        listed = "; ".join(f"“{t}” (usually “{TORTURED[t]}”)" for t in list(hits)[:4])
        issues.append(("Integrity", "Tortured phrases", "Concern",
                       f"{sum(hits.values())} unusual phrase(s) typical of paraphrasing tools: {listed}", "tortured_phrases"))

    # --- AI chatbot leftovers
    leftovers = [m.group(0) for m in AI_LEFTOVERS.finditer(everything)]
    if leftovers:
        issues.append(("Integrity", "AI chatbot text", "Concern",
                       f"Text that looks left over from an AI chatbot: “{leftovers[0]}”"
                       + (f" and {len(leftovers) - 1} more" if len(leftovers) > 1 else ""), "ai_artifacts"))

    # --- Hidden text and prompt injection
    hidden = hidden_runs(doc)
    injected = [m.group(0) for m in PROMPT_INJECTION.finditer(everything)]
    injected += [m.group(0) for _, t in hidden for m in PROMPT_INJECTION.finditer(t)]
    if injected:
        issues.append(("Integrity", "Instructions to AI reviewers", "Concern",
                       f"The manuscript contains instructions aimed at AI tools or reviewers: “{injected[0]}”",
                       "prompt_injection"))
    if hidden:
        why, text = hidden[0]
        issues.append(("Integrity", "Hidden text", "Concern",
                       f"{len(hidden)} piece(s) of text readers can't see ({why}: “{short(text, 60)}”)", "hidden_text"))

    # --- An AI tool as an author
    found, names = title_page(sections)
    after_title = [t for name, paras in sections if name == "Front matter" for t in paras][1:4]
    author_lines = [line for line in after_title
                    if len(line) < 200 and not EMAIL.search(line) and re.search(r"[,;&*]|\band\b|\d", line)]
    ai_line = next((line for line in author_lines if AI_NAMES.search(line)), None)
    if ai_line:
        issues.append(("Integrity", "AI tool as author", "Concern",
                       f"An AI tool appears in the author list: “{short(ai_line, 60)}”. AI tools can't be authors "
                       "(ICMJE, COPE)", "ai_author"))

    # --- Free-mail corresponding author
    front_text = " ".join(t for name, paras in sections if name == "Front matter" for t in paras)
    free = sorted({e for e in EMAIL.findall(front_text) if e.split("@")[-1].lower() in FREEMAIL})
    if free:
        issues.append(("Integrity", "Free email address", "Concern",
                       f"The title page uses a free email address ({', '.join(free[:2])}); many journals ask for an "
                       "institutional address to verify authors", "freemail"))

    # --- Percentages and impossible values
    wrong = percentage_mismatches(body)
    if wrong:
        issues.append(("Integrity", "Percentages don't match", "Concern",
                       f"{len(wrong)} percentage(s) don't match their numbers: {'; '.join(wrong[:3])}",
                       "percentage_check"))
    impossible = impossible_values(body)
    if impossible:
        issues.append(("Integrity", "Impossible values", "Concern",
                       f"Values that can't be right: {', '.join(impossible[:3])}", "impossible_values"))

    # --- Self-citation share
    refs = [t for name, paras in sections if name == "References" for t in paras]
    surnames = {n.split()[-1] for n in names if len(n.split()[-1]) > 2}
    if surnames and len(refs) >= 5:
        own = [r for r in refs if any(re.search(rf"\b{re.escape(s)}\b", r) for s in surnames)]
        share = 100 * len(own) / len(refs)
        limit = float((settings or {}).get("self_citation_share", 30))
        if share > limit:
            issues.append(("Integrity", "Self-citation", "Concern",
                           f"{len(own)} of {len(refs)} references ({share:.0f}%) include an author's surname "
                           f"({', '.join(sorted(surnames))}); common surnames can inflate this", "self_citation_ratio"))
    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python step9_integrity.py <manuscript.docx>")
        return
    try:
        sections, doc = split_into_sections(sys.argv[1])
    except Exception as e:
        print(f"Could not read '{sys.argv[1]}': {e}")
        return
    issues = check_integrity(sections, doc)
    print(f"\nFile: {sys.argv[1]}\n")
    for section, check, status, details, _rule in issues or [("", "", "", "No integrity flags.", "")]:
        print(f"[{status}] {check}: {details}" if check else details)


if __name__ == "__main__":
    main()
