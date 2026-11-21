"""
The bridge between the website (web/) and the checker.

The website runs this Python inside the visitor's browser (with Pyodide), so manuscripts are
checked on their own computer and never uploaded anywhere. Every function here takes and
returns plain JSON text, which is easy to pass to and from JavaScript.
"""

import json
from pathlib import Path

import yaml

from checker import check_file, build_workbook, build_word_report, verdict, counts
from settings import list_profiles, load_profile, merge, check_profile
from rules import RULES, SEVERITY_LABEL, REVIEW_MODELS, CITATION_STYLES, FIXES

UPLOADS = Path("/tmp/uploads")        # where the page puts uploaded files (in the browser's memory)
REPORT = Path("/tmp/screening_report.xlsx")
WORD_REPORT = Path("/tmp/screening_report.docx")


def catalogue():
    """Every profile and every rule, for building the sidebar."""
    return json.dumps({
        "profiles": [{"id": pid, "name": name} for pid, name in list_profiles().items()],
        "rules": [{"id": rid, "area": area, "label": label, "what": what}
                  for rid, (area, label, what) in RULES.items()],
        "severity_labels": SEVERITY_LABEL,
        "review_models": REVIEW_MODELS,
        "citation_styles": CITATION_STYLES,
    })


def profile(profile_id):
    """One profile, combined with everything it is based on."""
    return json.dumps(load_profile(profile_id))


def read_profile(text, filename):
    """A profile file the visitor loaded (one saved from the page, or written by hand)."""
    data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        raise ValueError("this file doesn't look like a profile")
    parent = data.pop("based_on", None) or "generic"     # anything not set falls back to generic
    result = merge(load_profile(parent), data)
    result["id"] = Path(filename).stem
    result.setdefault("name", result["id"])
    result["based_on"] = parent
    check_profile(result)
    return json.dumps(result)


def save_profile(profile_json, base_json):
    """The adjusted profile as YAML, listing only what differs from the profile it started from."""
    current, base = json.loads(profile_json), json.loads(base_json)
    parent = base.get("based_on") if base["id"] not in list_profiles() else base["id"]
    parent_profile = load_profile(parent or "generic")
    out = {"name": current.get("name") or f"{base['name']} (adjusted)", "based_on": parent or "generic"}
    for part in ("settings", "required_sections", "rules"):
        changed = {k: v for k, v in current.get(part, {}).items() if parent_profile.get(part, {}).get(k) != v}
        if changed:
            out[part] = changed
    return yaml.safe_dump(out, sort_keys=False, allow_unicode=True)


def check(files_json, profile_json, dismissed_json="[]"):
    """Check the uploaded files (already written to /tmp/uploads by the page) and build the Excel and Word reports.
    files: [{"path", "name"}]; dismissed: [{"name", "key"}] issues the visitor marked as false alarms, which are
    left out of the downloaded reports."""
    files, prof = json.loads(files_json), json.loads(profile_json)
    dismissed = {(d["name"], d["key"]) for d in json.loads(dismissed_json or "[]")}
    check_profile(prof)
    results, infos, out = [], {}, []
    for f in files:
        name = f["name"]
        try:
            issues, info = check_file(UPLOADS / f["path"], prof, name)
        except Exception as e:
            results.append((name, None))
            reason = str(e) if "can't be read" in str(e) else f"could not read this file ({type(e).__name__})"
            out.append({"name": name, "error": reason[:1].upper() + reason[1:]})
            continue
        infos[name] = info
        results.append((name, [i for i in issues if (name, f"{i.section}|{i.check}") not in dismissed]))
        out.append({"name": name, "verdict": verdict(issues), "counts": counts(issues), "info": info,
                    "issues": [{"section": i.section, "check": i.check, "status": i.status, "details": i.details,
                                "rule": i.rule, "severity": i.severity, "key": f"{i.section}|{i.check}",
                                "fix": FIXES.get(i.rule, ("", ""))[0], "source": FIXES.get(i.rule, ("", ""))[1]}
                               for i in issues]})
    wb = build_workbook(results, prof.get("name", ""), infos)
    has_report = bool(wb.sheetnames)
    if has_report:
        wb.save(REPORT)
        build_word_report(results, prof.get("name", ""), infos).save(WORD_REPORT)
    return json.dumps({"results": out, "report": str(REPORT) if has_report else None,
                       "word": str(WORD_REPORT) if has_report else None})


# ---------------------------------------------------------------------------
# Reference integrity checker (the page at /references/). The page does the Crossref lookups (the browser
# fetches); these functions read the references, decide each verdict and build the reports.
# ---------------------------------------------------------------------------
import refcheck                                       # noqa: E402

REF_REPORT = Path("/tmp/reference_report.xlsx")
REF_WORD = Path("/tmp/reference_report.docx")


def refs_extract(files_json, text):
    """References from an uploaded file (written to /tmp/uploads by the page) or from pasted text."""
    files = json.loads(files_json or "[]")
    if files:
        refs = refcheck.extract(UPLOADS / files[0]["path"], files[0]["name"])
    else:
        refs = refcheck.extract(text=text or "")
    for ref in refs:
        ref["query"] = refcheck.search_query(ref)
    return json.dumps({"references": refs, "api": refcheck.API, "fields": refcheck.SEARCH_FIELDS,
                       "contact": refcheck.CONTACT})


def refs_assess(ref_json, record_json, record_status, items_json, list_json, updates_json):
    """The verdict for one reference, from what Crossref answered (see refcheck.assess)."""
    loads = lambda s: json.loads(s) if s else None
    status = int(record_status) if record_status not in (None, "", "null") else None
    return json.dumps(refcheck.assess(loads(ref_json), loads(record_json), status, loads(items_json),
                                      loads(list_json), loads(updates_json)))


def refs_report(results_json, source_name):
    results = json.loads(results_json)
    refcheck.build_excel(results, source_name).save(REF_REPORT)
    refcheck.build_word(results, source_name).save(REF_WORD)
    return json.dumps({"report": str(REF_REPORT), "word": str(REF_WORD)})


# ---------------------------------------------------------------------------
# Cygnus, the researcher check (the page at /researchers/). Python looks the people up itself, through the browser's fetch.
# ---------------------------------------------------------------------------
import idcheck                                        # noqa: E402

IDS_REPORT = Path("/tmp/researcher_check.xlsx")
IDS_WORD = Path("/tmp/researcher_check.docx")


class BrowserFetcher(idcheck.Fetcher):
    """Fetches with the browser (pyodide.http.pyfetch). Answers are remembered for the visit, so choosing another
    profile or opening a co-author network doesn't ask the databases again."""

    async def _get(self, url, headers):
        from pyodide.http import pyfetch
        try:
            r = await pyfetch(url, headers=headers)
        except Exception:                             # noqa: BLE001
            if headers.get("Client-Id"):              # a site that refuses the extra header: ask without it
                return await self._get(url, {k: v for k, v in headers.items() if k != "Client-Id"})
            return None, None
        if r.status == 200:
            try:
                return 200, await r.json()
            except Exception:                         # noqa: BLE001
                return None, None
        return r.status, None

    # The Grey Swan Engine (engine/worker.js, on Cloudflare): when the site has one, OpenAlex is asked through it. It
    # adds the site's OpenAlex key and remembers answers for a day, so visitors need no key of their own.
    engine = ""

    def openalex(self, path, **params):
        url = super().openalex(path, **params)
        if self.engine:
            url = self.engine.rstrip("/") + "/openalex" + url[len(idcheck.OPENALEX):]
        return url


_FETCHER = {"keys": None, "fetcher": None}


def _fetcher(keys_json):
    keys = json.loads(keys_json or "{}")
    engine = (keys.get("engine") or "").strip()
    engine = engine if engine.startswith("https://") else ""
    sig = ("" if engine else keys.get("openalex") or "", keys.get("ror") or "", engine)   # the engine holds the key
    if _FETCHER["keys"] != sig:
        _FETCHER["fetcher"] = BrowserFetcher(openalex_key=sig[0], ror_client_id=sig[1])
        if engine:
            from urllib.parse import urlparse
            _FETCHER["fetcher"].engine = engine
            _FETCHER["fetcher"].GAP = {**idcheck.Fetcher.GAP, urlparse(engine).netloc: 0.05}
        _FETCHER["keys"] = sig
    return _FETCHER["fetcher"]


def ids_extract(files_json):
    """Authors, suggested reviewers, title and keywords from the uploaded files."""
    files = [(UPLOADS / f["path"], f["name"]) for f in json.loads(files_json)]
    return json.dumps(idcheck.extract(files))


def ids_parse(text, role="author"):
    return json.dumps(idcheck.parse_people(text, role))


async def ids_check(session_json, keys_json="{}", progress=None):
    def tell(done, total, who):
        if progress:
            progress(done, total, who)
    out = await idcheck.check(json.loads(session_json), _fetcher(keys_json), tell)
    return json.dumps(out)


async def ids_network(session_json, seed_id, keys_json="{}"):
    return json.dumps(await idcheck.network(json.loads(session_json), seed_id, _fetcher(keys_json)))


def ids_report(out_json):
    out = json.loads(out_json)
    idcheck.build_excel(out, IDS_REPORT)
    idcheck.build_word(out, IDS_WORD)
    return json.dumps({"report": str(IDS_REPORT), "word": str(IDS_WORD)})


# ---------------------------------------------------------------------------
# Reviewer Finder (the page at /reviewers/): candidates from OpenAlex, checked for independence and ranked.
# ---------------------------------------------------------------------------
import revfind                                        # noqa: E402

RF_REPORT = Path("/tmp/reviewer_finder.xlsx")
RF_WORD = Path("/tmp/reviewer_finder.docx")


def rf_extract(files_json):
    """Title, abstract, keywords, authors, the authors' suggested reviewers and the reference DOIs, from the files."""
    files = [(UPLOADS / f["path"], f["name"]) for f in json.loads(files_json)]
    out = idcheck.extract(files)
    dois, refs = [], 0
    for path, name in files:
        try:
            found = refcheck.extract(path, name)
        except Exception:                             # noqa: BLE001 - a file without a reference list
            continue
        refs += len(found)
        dois += [r["doi"] for r in found if r.get("doi")]
    people = out.pop("people")
    out["authors"] = [p for p in people if p.get("role") != "reviewer"]
    out["suggested"] = [p for p in people if p.get("role") == "reviewer"]
    out["references"] = [{"doi": d} for d in dict.fromkeys(dois)]
    out["reference_count"] = refs
    return json.dumps(out)


def rf_refs(text):
    found = refcheck.extract(text=text)
    return json.dumps({"references": [{"doi": d} for d in dict.fromkeys(r["doi"] for r in found if r.get("doi"))],
                       "reference_count": len(found)})


async def rf_find(session_json, keys_json="{}", progress=None):
    def tell(step, total, text):
        if progress:
            progress(step, total, text)
    return json.dumps(await revfind.find(json.loads(session_json), _fetcher(keys_json), tell))


def rf_report(out_json):
    out = json.loads(out_json)
    revfind.build_excel(out, RF_REPORT)
    revfind.build_word(out, RF_WORD)
    return json.dumps({"report": str(RF_REPORT), "word": str(RF_WORD)})


async def rf_pulse(orcid, name, association, keys_json="{}"):
    """Reviewer Pulse for one person, on request (a candidate beyond the look-up limit, or a re-check)."""
    import pulse
    from datetime import date
    return json.dumps(await pulse.pulse_for(_fetcher(keys_json), orcid, name, association, date.today()))


# ---------------------------------------------------------------------------
# Studio, the writing tool (the page at /studio/): Word files in and out
# ---------------------------------------------------------------------------
import studio_docx                                    # noqa: E402


def studio_export(paper_json):
    return studio_docx.export_word(paper_json)


def studio_import(path):
    return studio_docx.import_word(path)


def studio_sheet(path, sheet=""):
    return studio_docx.sheet_rows(path, sheet)
