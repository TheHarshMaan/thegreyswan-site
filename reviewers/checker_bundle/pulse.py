"""
Reviewer Pulse: public evidence of a researcher's peer-review activity. Phase 1 reads the public ORCID record.

What it establishes, and what it doesn't
  - A peer-review item on an ORCID record can only be added by the organisation that ran the review (a publisher, a
    journal system, a recognition service) with the researcher's permission: researchers can't type one in. So each
    item is evidence that a review took place, for that organisation, around that date.
  - It doesn't establish subject expertise (a journal can cover many subjects), the quality of the review, or whether
    the person is available now. Most peer review is never made public, so finding nothing proves nothing.
  - This evidence is shown alongside the Reviewer Finder's ranking, never counted in it.

Each record keeps its provenance: source (ORCID), the organisation that asserted it, the record's put-code and path,
the review's DOI if given, the ISSN from its group id, the journal title if the ISSN resolves in OpenAlex (the ISSN is
kept when it doesn't), the date exactly as given (year, month or day), and when it was retrieved.

Identity: an ORCID iD is a strong identifier but can be mistyped or attached to the wrong profile. The record's
public name is compared with the person's name; a mismatch means the reviews are not shown for this person. Where the
iD came from (the manuscript, or the researcher's OpenAlex profile) is kept.

Recent means a calendar-year window: a dated review in this calendar year or the two before (in 2026: 2024-2026).
The label names the years, so it reads the same way as the Reviewer Finder's "papers in 2024-2026".

Three steps, each with its own state, so one failing never hides another's evidence:
  retrieval  ok | no_orcid | invalid | not_found | rate_limited | unavailable   (getting the ORCID record)
  parsing    ok | partial | failed | not_attempted                            (reading its peer-review section)
  journals   resolved | partial | failed | not_needed | not_attempted         (naming journals from ISSNs, OpenAlex)
A failed journal lookup keeps every record, with its ISSN.

Roles (ORCID's list: reviewer, editor, member, chair, organizer): "reviewer" is peer-review evidence; "editor" and
"chair" (who, in ORCID's definitions, coordinate reviews or decide on content) are editorial service; "member",
"organizer", a missing role or any other value are kept as unclassified evidence and never counted as reviews.

Format: ORCID public API v3.0, GET https://pub.orcid.org/v3.0/{orcid}/record (Accept: application/json). Its
activities-summary/peer-reviews holds groups (one per journal, review-group-id such as issn:1234-5678), each holding
peer-review-group items (one per review, with ORCID's own de-duplication of copies from several sources), each holding
peer-review-summary copies. Older records put the summaries directly in the group; both are read.
"""
import asyncio
import re
from datetime import datetime, timezone

import idcheck as ic

ORCID_API = ic.ORCID_API
RECENT_YEARS = 3                       # calendar years, counting this one
REVIEW_ROLES = {"reviewer"}
EDITORIAL_ROLES = {"editor", "chair"}
ISSN_RE = re.compile(r"^(\d{4})-?(\d{3}[\dXx])$")

LABELS = {
    "recent": "Verified reviewing in {window}",
    "historical": "Verified reviewing, latest {latest}",
    "undated": "Verified reviewing, dates not given",
    "editorial": "Editorial service only",
    "unclassified": "Review-related records, role not stated",
    "none": "No public review records",
    "limit": "Not checked: lookup limit reached",
    "no_orcid": "Not checked: no ORCID iD",
    "invalid": "Not checked: ORCID iD isn't valid",
    "mismatch": "Not shown: ORCID name doesn't match",
    "not_found": "Not checked: ORCID iD not found",
    "rate_limited": "Couldn't check: ORCID is busy",
    "unavailable": "Couldn't check: ORCID didn't answer",
    "unreadable": "Couldn't read the review records",
}
LIMIT_NONE = ("Most peer review is never made public, so no record here doesn't mean they haven't reviewed.")
LIMIT_SCOPE = ("A record shows a review took place for that journal or organisation. It doesn't show the subject "
               "reviewed, the quality of the review, or whether they're available now.")


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _v(x):
    """ORCID wraps many values as {"value": …}."""
    if isinstance(x, dict):
        return x.get("value")
    return x


def norm_doi(text):
    t = (text or "").strip()
    t = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", t, flags=re.IGNORECASE)
    return t.lower() if t.startswith("10.") else ""


def issn_of(group_id):
    g = (group_id or "").strip()
    if not g.lower().startswith("issn:"):
        return ""
    m = ISSN_RE.match(g[5:].strip())
    return f"{m.group(1)}-{m.group(2).upper()}" if m else ""


def fuzzy_date(d):
    """(text, year) exactly as given: '2025', '2025-03' or '2025-03-14'; (None, None) when not given."""
    if not isinstance(d, dict):
        return None, None
    y, m, day = _v(d.get("year")), _v(d.get("month")), _v(d.get("day"))
    if not (y and str(y).isdigit()):
        return None, None
    text = str(y)
    if m and str(m).isdigit():
        text += f"-{int(m):02d}"
        if day and str(day).isdigit():
            text += f"-{int(day):02d}"
    return text, int(y)


def record_name(data):
    """(main names, other names) on an ORCID record: given + family and the credit name if public; other names."""
    person = (data or {}).get("person") or {}
    nm = person.get("name") or {}
    names = []
    full = " ".join(x for x in (_v(nm.get("given-names")), _v(nm.get("family-name"))) if x)
    if full.strip():
        names.append(full.strip())
    credit = _v(nm.get("credit-name"))
    if credit:
        names.append(credit)
    others = [o["content"] for o in ((person.get("other-names") or {}).get("other-name") or [])
              if isinstance(o, dict) and o.get("content")]
    return names, others


_TRANSLIT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss", "æ": "ae",
                           "Æ": "Ae", "œ": "oe", "Œ": "Oe", "ø": "oe", "Ø": "Oe"})


def _name_sets(name):
    """The name's tokens in the spellings people actually use: accents dropped (ö -> o) or written out (ö -> oe),
    hyphenated parts apart (xiao teng) or joined (xiaoteng)."""
    out = []
    for text in {name or "", (name or "").translate(_TRANSLIT)}:
        for t in (text, re.sub(r"(?<=\w)-(?=\w)", "", text)):
            toks = {x for x in ic.name_tokens(t) if len(x) > 1}
            if toks:
                out.append(toks)
    return out


def name_relation(a, b):
    """'same' (the same names, whatever the order, accents or hyphens), 'partial' (one is a shorter form of the other:
    a missing family name, an extra given or grandfather name) or 'different'. Used only to decide whether an ORCID
    record clearly belongs to someone else; initials are left to ic.name_match."""
    sa, sb = _name_sets(a), _name_sets(b)
    if any(x == y for x in sa for y in sb):
        return "same"
    if any(x < y or y < x for x in sa for y in sb):
        return "partial"
    return "different"


def summaries_in(peer_reviews):
    """[(review summaries, ORCID group id)], one entry per review. Defensive about shape."""
    out = []
    groups = (peer_reviews or {}).get("group") if isinstance(peer_reviews, dict) else None
    if not isinstance(groups, list):
        return out
    for g in groups:
        if not isinstance(g, dict):
            continue
        gid = ""
        for e in ((g.get("external-ids") or {}).get("external-id") or []):
            if isinstance(e, dict) and e.get("external-id-type") == "peer-review":
                gid = e.get("external-id-value") or ""
        inner = g.get("peer-review-group")
        if isinstance(inner, list):                         # v3.0: group -> review -> copies
            for review in inner:
                copies = [s for s in (review or {}).get("peer-review-summary") or [] if isinstance(s, dict)]
                if copies:
                    out.append((copies, gid))
        else:                                               # older layout: group -> copies
            copies = [s for s in g.get("peer-review-summary") or [] if isinstance(s, dict)]
            for s in copies:
                out.append(([s], gid))
    return out


def section_shape_ok(data):
    """Whether the record has a peer-review section of the documented shape (empty is fine)."""
    acts = (data or {}).get("activities-summary")
    if not isinstance(acts, dict):
        return False
    pr = acts.get("peer-reviews")
    if pr is None:
        return True                                         # no peer-review section: no public reviews
    return isinstance(pr, dict) and isinstance(pr.get("group") if pr.get("group") is not None else [], list)


def parse_record(data, orcid, retrieved_at, stats=None):
    """The peer-review activities on a public ORCID record, one per review, with provenance.
    stats (a dict) receives seen/read/skipped counts."""
    acts = (data or {}).get("activities-summary") or {}
    raw = summaries_in(acts.get("peer-reviews"))
    records = []
    seen_items = skipped = 0
    for copies, gid in raw:
        seen_items += 1
        try:
            rec = _one_review(copies, gid, orcid, retrieved_at)
        except Exception:                                   # noqa: BLE001 - one odd item mustn't hide the rest
            skipped += 1
            continue
        if rec:
            records.append(rec)
    if stats is not None:
        stats.update(seen=seen_items, read=len(records), skipped=skipped)
    return dedupe(records)


def _one_review(copies, gid, orcid, retrieved_at):
    """One review from its copies (ORCID groups copies of the same review from different sources)."""
    public = [s for s in copies if (s.get("visibility") or "public") == "public"]
    if not public:
        return None
    s = sorted(public, key=lambda x: str(x.get("display-index") or "0"), reverse=True)[0]
    group_id = s.get("review-group-id") or gid or ""
    date_text, year = fuzzy_date(s.get("completion-date") or s.get("review-completion-date"))
    doi = ""
    for e in ((s.get("external-ids") or s.get("review-identifiers") or {}).get("external-id") or []):
        if isinstance(e, dict) and (e.get("external-id-type") or "").lower() == "doi" \
                and (e.get("external-id-relationship") or "self") == "self":
            doi = norm_doi(e.get("external-id-value") or _v(e.get("external-id-url")) or "")
            if doi:
                break
    review_url = _v(s.get("review-url")) or ""
    if not doi:
        doi = norm_doi(review_url)
    org = s.get("convening-organization") or {}
    dis = org.get("disambiguated-organization") or {}
    src = s.get("source") or {}
    role = (s.get("reviewer-role") or "").strip().lower()
    evidence = "verified_peer_review" if role in REVIEW_ROLES else "editorial_service" if role in EDITORIAL_ROLES \
        else "unclassified"
    return {
        "evidence_class": evidence,
        "source": {"name": "ORCID", "asserted_by": (_v(src.get("source-name")) or "").strip(),
                   "assertion_origin": (_v(src.get("assertion-origin-name")) or "").strip(),
                   "record_id": str(s.get("put-code") or ""), "path": s.get("path") or "",
                   "api_url": f"{ORCID_API}{s['path']}" if s.get("path") else "",
                   "url": f"https://orcid.org/{orcid}", "retrieved_at": retrieved_at, "copies": len(public)},
        "activity": {"group_id": group_id, "issn": issn_of(group_id), "journal": None, "journal_openalex": None,
                     "organisation": org.get("name") or "",
                     "organisation_id": (dis.get("disambiguated-organization-identifier") or ""),
                     "organisation_id_source": (dis.get("disambiguation-source") or ""),
                     "date": date_text, "year": year, "role": role or None,
                     "review_type": (s.get("review-type") or "").lower() or None,
                     "review_doi": doi or None, "review_url": review_url or None},
    }


def dedupe(records):
    """The same review DOI under two groups is one review (both copies noted). Records without a DOI are never
    merged: two reviews for the same journal on the same date can be two different reviews."""
    seen, out = {}, []
    for r in records:
        d = r["activity"]["review_doi"]
        if d and d in seen:
            seen[d]["source"]["copies"] += r["source"]["copies"]
            continue
        if d:
            seen[d] = r
        out.append(r)
    out.sort(key=lambda r: (r["activity"]["date"] or ""), reverse=True)
    return out


async def resolve_issns(fetch, issns):
    """ISSN -> {title, openalex id, publisher} from OpenAlex. ISSNs that don't resolve are simply absent."""
    found, ok = {}, True
    issns = sorted(set(i for i in issns if i))
    for k in range(0, len(issns), 50):
        chunk = issns[k:k + 50]
        status, data = await fetch.get(fetch.openalex("/sources", filter="issn:" + "|".join(chunk), per_page=50,
                                                      select="id,display_name,issn,issn_l,host_organization_name"))
        if status != 200 or not data:
            ok = False
            continue
        for src in data.get("results") or []:
            listed = {x.upper() for x in (src.get("issn") or []) + [src.get("issn_l") or ""] if x}
            for i in chunk:
                if i in listed and i not in found:
                    found[i] = {"title": src.get("display_name") or "", "openalex": ic.short_id(src.get("id")),
                                "publisher": src.get("host_organization_name") or ""}
    return found, ok


def window(today, recent_years=RECENT_YEARS):
    """The calendar years that count as recent: this year and the (recent_years - 1) before."""
    return today.year - (recent_years - 1), today.year


def summarise(records, today, recent_years=RECENT_YEARS):
    reviews = [r for r in records if r["evidence_class"] == "verified_peer_review"]
    editorial = [r for r in records if r["evidence_class"] == "editorial_service"]
    unclassified = [r for r in records if r["evidence_class"] == "unclassified"]
    start, end = window(today, recent_years)
    years = [r["activity"]["year"] for r in reviews if r["activity"]["year"]]
    latest = max(years) if years else None
    journals = {}
    for r in reviews:
        a = r["activity"]
        key = a["issn"] or a["group_id"] or a["organisation"] or "unknown"
        j = journals.setdefault(key, {"title": a["journal"], "issn": a["issn"], "organisation": a["organisation"],
                                      "count": 0, "latest": None})
        j["count"] += 1
        if a["year"] and (not j["latest"] or a["year"] > j["latest"]):
            j["latest"] = a["year"]
    if reviews:
        state = "recent" if latest and latest >= start else "historical" if latest else "undated"
    elif editorial:
        state = "editorial"
    elif unclassified:
        state = "unclassified"
    else:
        state = "none"
    return {"state": state, "label": LABELS[state].format(window=f"{start}–{end}", latest=latest),
            "reviews": len(reviews), "editorial": len(editorial), "unclassified": len(unclassified),
            "latest_year": latest, "recent_years": recent_years, "window": [start, end],
            "journals": sorted(journals.values(), key=lambda j: (-j["count"], -(j["latest"] or 0)))}


def empty(state, orcid="", association="", limitations=None, retrieval=None):
    retr = retrieval or {"no_orcid": "no_orcid", "invalid": "invalid", "limit": "not_attempted"}.get(state, state)
    return {"orcid": orcid, "association": association, "state": state, "label": LABELS[state],
            "retrieval": {"status": retr}, "parsing": {"status": "not_attempted"},
            "journals": {"status": "not_attempted"},
            "identity": {"status": "unresolved", "basis": []}, "records": [], "summary": None,
            "limitations": limitations or [], "retrieved_at": now_iso(),
            "sources_checked": ["ORCID public record"] if state not in ("no_orcid", "invalid", "limit") else []}


async def pulse_for(fetch, orcid, name, association, today, recent_years=RECENT_YEARS, known=None, answer=None):
    """Everything Reviewer Pulse shows for one person. association: where the ORCID iD came from."""
    o = ic.clean_orcid(orcid or "")
    if not o:
        return empty("no_orcid", "", association, ["No ORCID iD is known for this person, so their public "
                                                   "reviewing record wasn't checked."])
    if not ic.orcid_valid(o):
        return empty("invalid", o, association, ["The ORCID iD's check digit is wrong, so it can't be a real iD."])
    retrieved = now_iso()
    # answer: ORCID's reply already fetched for this iD by pulse_many, so a failure isn't asked (and retried) twice
    status, data = answer if answer is not None else await fetch.get(f"{ORCID_API}/{o}/record", {"Accept": "application/json"})
    if status == 404:
        return empty("not_found", o, association, ["ORCID has no public record with this iD."])
    if status == 429:
        return empty("rate_limited", o, association, ["ORCID asked us to slow down. Try again in a minute."])
    if status != 200 or not isinstance(data, dict):
        return empty("unavailable", o, association,
                     [f"ORCID didn't answer{f' (HTTP {status})' if status else ''}, so nothing can be said either way."])
    retrieval = {"status": "ok", "http": 200}
    # Identity: the record's public name against the person's
    try:
        names, others = record_name(data)
    except Exception:                                          # noqa: BLE001
        names, others = [], []
    basis = [association] if association else []
    # The main public name decides a mismatch; other names can confirm a match but never rule one out
    if not names and name and others and max(ic.name_match(name, n) for n in others) >= 0.75:
        names = [n for n in others if ic.name_match(name, n) >= 0.75][:1]
    partial = None
    if names and name:
        best = max(ic.name_match(name, n) for n in names)
        rel = max((name_relation(name, n) for n in names), key=lambda r: ("different", "partial", "same").index(r))
        if rel == "same":
            best = max(best, 0.75)
        elif rel == "partial" and best < 0.75:
            partial = next(n for n in names if name_relation(name, n) == "partial")
            best = 0.75
        if best < 0.75:
            out = empty("mismatch", o, association,
                        [f"The ORCID record is in the name of {names[0]}, not {name}. Its review records aren't shown "
                         "for this person. Check that the right iD is attached."], retrieval="ok")
            out["identity"] = {"status": "mismatch", "basis": basis + [f"ORCID name: {names[0]}"]}
            out["retrieved_at"] = retrieved
            return out
    if names and name and partial:
        identity = {"status": "probable", "basis": basis + [f"ORCID name partly matches: {partial}"]}
        limits = [f"The ORCID record's name ({partial}) is a shorter or longer form of {name}, so the link to this "
                  "person is probable rather than confirmed."]
    elif names and name:
        identity, limits = {"status": "confirmed", "basis": basis + ["name on the ORCID record matches"]}, []
    elif names:
        identity, limits = {"status": "probable", "basis": basis + ["no name given to compare"]}, []
    else:
        identity = {"status": "probable", "basis": basis}
        limits = ["The name on this ORCID record isn't public, so the link to this person couldn't be double-checked."]
    # Parsing
    if not section_shape_ok(data):
        out = empty("unreadable", o, association, ["ORCID answered, but its peer-review section wasn't in the "
                                                   "documented form, so it couldn't be read."], retrieval="ok")
        out.update(identity=identity, parsing={"status": "failed"}, retrieved_at=retrieved)
        return out
    stats = {}
    records = parse_record(data, o, retrieved, stats)
    parsing = {"status": "partial" if stats.get("skipped") else "ok", **stats}
    if stats.get("skipped"):
        limits.append(f"{stats['skipped']} item(s) on the record couldn't be read and aren't shown.")
    # Journal names (a failure here keeps every record, with its ISSN)
    issns = sorted({r["activity"]["issn"] for r in records if r["activity"]["issn"]})
    if issns:
        # known: ISSNs already looked up for a whole batch (pulse_many), so a batch costs one look-up, not one each
        kf, kok, asked = known if known else ({}, True, set())
        rest = [i for i in issns if i not in asked]
        found, ok = await resolve_issns(fetch, rest) if rest else ({}, True)
        found, ok = {**{i: kf[i] for i in issns if i in kf}, **found}, ok and (kok or not (set(issns) & asked))
        for r in records:
            j = found.get(r["activity"]["issn"])
            if j:
                r["activity"]["journal"], r["activity"]["journal_openalex"] = j["title"], j["openalex"]
        n = sum(1 for i in issns if i in found)
        journals = {"status": "failed" if not ok and not n else "partial" if (not ok or n < len(issns)) and n else
                    "resolved" if n == len(issns) else "unresolved", "issns": len(issns), "resolved": n, "lookup_ok": ok}
        if not ok:
            limits.append("Journal names couldn't be looked up this time; their ISSNs are shown instead.")
        elif n < len(issns):
            limits.append("Some ISSNs aren't known to OpenAlex; they're shown as ISSNs.")
    else:
        journals = {"status": "not_needed", "issns": 0, "resolved": 0}
    summary = summarise(records, today, recent_years)
    limits.append(LIMIT_NONE if summary["state"] == "none" else LIMIT_SCOPE)
    if summary["unclassified"]:
        limits.append("Records without a reviewer or editor role are listed but not counted as reviews.")
    if summary["state"] == "none":
        limits.append("Only ORCID was checked.")
    return {"orcid": o, "association": association, "state": summary["state"], "label": summary["label"],
            "retrieval": retrieval, "parsing": parsing, "journals": journals,
            "identity": identity, "records": records, "summary": summary, "limitations": limits,
            "retrieved_at": retrieved, "sources_checked": ["ORCID public record"]}


async def pulse_many(fetch, people, today, recent_years=RECENT_YEARS):
    """people: [(key, orcid, name, association)] -> {key: pulse}"""
    # One journal look-up for the whole batch: read each record first (the fetcher keeps the answers), collect every
    # ISSN, resolve them together, then build each person's view from the same answers.
    answers = {}

    async def issns_of(o):
        o = ic.clean_orcid(o or "")
        if not o or not ic.orcid_valid(o):
            return set()
        try:
            if o not in answers:
                answers[o] = None
                answers[o] = await fetch.get(f"{ORCID_API}/{o}/record", {"Accept": "application/json"})
            status, data = answers[o] or (None, None)
            if status != 200 or not isinstance(data, dict):
                return set()
            return {issn_of(c.get("review-group-id")) for copies, _ in
                    summaries_in(((data.get("activities-summary") or {}).get("peer-reviews") or {})) for c in copies} - {None, ""}
        except Exception:                                      # noqa: BLE001 - pulse_for reports it per person
            return set()
    issns = set().union(*(await asyncio.gather(*(issns_of(o) for _, o, _, _ in people)))) if people else set()
    known = None
    if issns:
        found, ok = await resolve_issns(fetch, sorted(issns))
        known = (found, ok, issns)
    res = await asyncio.gather(*(pulse_for(fetch, o, n, a, today, recent_years, known, answers.get(ic.clean_orcid(o or "")))
                                 for _, o, n, a in people))
    return {k: r for (k, _, _, _), r in zip(people, res)}


def one_line(p):
    """A plain one-line summary for reports."""
    if not p:
        return ""
    s = p.get("summary")
    if not s or not s["reviews"]:
        return p["label"]
    js = "; ".join(f"{j['title'] or ('ISSN ' + j['issn'] if j['issn'] else j['organisation'] or 'journal not named')} "
                   f"({j['count']})" for j in s["journals"][:4])
    return (f"{s['reviews']} public review record{'s' if s['reviews'] != 1 else ''} in ORCID"
            f"{', latest ' + str(s['latest_year']) if s['latest_year'] else ''}: {js}. Checked {p['retrieved_at'][:10]}.")
