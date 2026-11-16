"""
Reviewer Finder: active reviewers for a manuscript, ranked by how well their work fits and how likely
they are to say yes, with every reason shown.

Where candidates come from (OpenAlex, the open research database):
  - Topic search: recent papers that match the manuscript's title, keywords and abstract; their authors, weighted by
    how close the paper is, their place on it (first, last or corresponding author count most) and how recent it is.
  - Field leaders: the most-cited recent papers in the manuscript's research topics.
  - Cited authors: authors of recent papers in the manuscript's own reference list.
  - Your reviewers: people in the Reviewer Tracker whose keywords fit, with their history and email address.
  - Networks of reliable reviewers: co-authors of people who have accepted your invitations before, and of anyone
    the editor picks ("more like this").

Every candidate is then checked:
  - Overlap with the authors: a shared publication with any of the manuscript's authors in the look-back period, the
    same current institution as an author, or a name on the exclusion list. These are listed separately as potential
    overlaps and kept out of the ranking. Finding no overlap doesn't confirm independence: only what OpenAlex holds
    is checked.
  - Retracted papers, no recent publications, an email that bounced, an invitation from you still open.
  - Candidates who have published together or share an institution are marked, so a shortlist can avoid them.

Ranking (shown with its reasons for every candidate):
  - Fit (60%): how closely their recent work matches the manuscript (term similarity and search evidence).
  - Outlook (25%): how likely they are to accept: your own history with them first, then what research on reviewer
    responses shows (recent activity, career stage, an open invitation from you, a recent one).
  - Activity (15%): papers in this calendar year and the two before.
Suggested reviewers named by the authors are checked by Cygnus (idcheck.py) and listed separately.

Usage (command line):
    python revfind.py session.json            # writes reviewer_finder.xlsx (and .docx with --word)
"""
import asyncio
import json
import math
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import idcheck as ic

WORK_SELECT = "id,doi,display_name,publication_year,authorships,topics,keywords,primary_location,cited_by_count"
AUTHOR_SELECT = ic.AUTHOR_FIELDS + ",summary_stats"
POOL_LIMIT = 120               # candidates whose profiles are fetched
SEARCH_PAGE = 50
MAX_QUERIES = 8
CHUNK = 50                     # ids per OR filter
ACCEPTED = {"accepted", "submitted"}
PENDING_DAYS = 21
RECENT_INVITE_DAYS = 45

def years_label(year):
    """The calendar-year window used for "recent" everywhere: this year and the two before."""
    return f"{year - 2}–{year}"


SOURCE_TEXT = {"search": "Recent papers match the manuscript", "topic": "Leading recent papers in the manuscript's topics",
               "cited": "Cited in the manuscript's references", "tracker": "In your Invitations list",
               "network": "Co-author of a reviewer you trust"}
SOURCE_WEIGHT = {"search": 1.0, "topic": 0.6, "cited": 0.9, "network": 0.5, "tracker": 0.4}


# ---------------------------------------------------------------------------
# The manuscript: what to search for, and its words for comparing with each candidate's work
# ---------------------------------------------------------------------------
def words(text):
    return [ic.stem(w) for w in re.findall(r"[a-z][a-z0-9-]{2,}", ic.fold(text or "")) if w not in ic.STOP]


def manuscript_vector(ctx):
    v = {}
    for w in words(ctx["title"]):
        v[w] = v.get(w, 0) + 3
    for k in ctx["keywords"]:
        for w in words(k):
            v[w] = v.get(w, 0) + 3
    for w in words(ctx["abstract"]):
        v[w] = v.get(w, 0) + 1
    return v


def search_queries(ctx):
    """A few different ways into the literature: the title's key words, each keyword, the abstract's key terms."""
    qs = []
    tw = [w for w in re.findall(r"[A-Za-z][A-Za-z0-9-]{3,}", ctx["title"]) if w.lower() not in ic.STOP]
    if tw:
        qs.append(" ".join(tw[:9]))
    for k in ctx["keywords"][:6]:
        k = re.sub(r"[\"()]", " ", k).strip()
        if len(k) >= 3:
            qs.append(k)
    if ctx["abstract"]:
        title_terms = set(words(ctx["title"]))
        freq = {}
        for w in re.findall(r"[A-Za-z][A-Za-z0-9-]{4,}", ctx["abstract"]):
            lw = w.lower()
            if lw in ic.STOP or ic.stem(lw) in title_terms:
                continue
            freq[lw] = freq.get(lw, 0) + 1
        top = [w for w, n in sorted(freq.items(), key=lambda x: (-x[1], x[0])) if n >= 2][:6]
        if len(top) >= 3:
            qs.append(" ".join(top))
    seen, out = set(), []
    for q in qs:
        key = q.lower()
        if key not in seen:
            seen.add(key)
            out.append(q)
    return out[:MAX_QUERIES]


def same_title(a, b):
    """Two titles that are the same paper's: equal once case, punctuation and spacing are ignored, or very nearly."""
    ta, tb = (re.findall(r"[a-z0-9]+", (t or "").lower()) for t in (a, b))
    if len(ta) < 4 or len(tb) < 4:
        return False
    if ta == tb:
        return True
    import difflib
    return abs(len(ta) - len(tb)) <= 3 and difflib.SequenceMatcher(None, " ".join(ta), " ".join(tb)).ratio() >= 0.93


def cosine(a, b, idf):
    num = sum(a[w] * b.get(w, 0) * idf.get(w, 1) ** 2 for w in a)
    na = math.sqrt(sum((a[w] * idf.get(w, 1)) ** 2 for w in a))
    nb = math.sqrt(sum((b[w] * idf.get(w, 1)) ** 2 for w in b))
    return num / (na * nb) if na and nb else 0.0


# ---------------------------------------------------------------------------
# The Reviewer Tracker: who you've invited, how they answered
# ---------------------------------------------------------------------------
OPENALEX_IN_NOTES = re.compile(r"openalex\.org/(A\d+)", re.IGNORECASE)


def tracker_index(tracker, today, manuscript_id=""):
    """Each tracker reviewer with their history. Invitations for this manuscript (by its ID) are noted separately:
    they say the reviewer is already invited for it, not that they are slow to answer."""
    tracker = tracker or {}
    invites, this_ms = {}, {}
    mid = (manuscript_id or "").strip().lower()
    for inv in tracker.get("invites") or []:
        if mid and (inv.get("manuscript") or "").strip().lower() == mid:
            this_ms[inv.get("reviewerId")] = inv.get("outcome") or "awaiting"
            continue
        invites.setdefault(inv.get("reviewerId"), []).append(inv)
    out = []
    for r in tracker.get("reviewers") or []:
        if not (r.get("name") or "").strip():
            continue
        inv = sorted(invites.get(r.get("id"), []), key=lambda i: i.get("invited") or "")
        dates = []
        for i in inv:
            try:
                dates.append(date.fromisoformat((i.get("invited") or "")[:10]))
            except ValueError:
                dates.append(None)
        pending = [d for i, d in zip(inv, dates) if i.get("outcome") == "awaiting" and d and (today - d).days <= PENDING_DAYS]
        recent = [d for d in dates if d and (today - d).days <= RECENT_INVITE_DAYS]
        busy = [i for i in inv if i.get("outcome") == "accepted"]
        last_two = [i.get("outcome") for i in inv if i.get("outcome") != "awaiting"][-2:]
        m = OPENALEX_IN_NOTES.search(r.get("notes") or "")
        out.append({
            "tracker_id": r.get("id"), "name": r["name"].strip(), "email": (r.get("email") or "").strip(),
            "affiliation": r.get("affiliation") or "", "keywords": r.get("keywords") or [], "dead": bool(r.get("dead")),
            "openalex": m.group(1) if m else "", "orcid": ic.clean_orcid(r.get("notes") or ""),
            "invited": len(inv), "accepted": sum(1 for i in inv if i.get("outcome") in ACCEPTED),
            "submitted": sum(1 for i in inv if i.get("outcome") == "submitted"),
            "declined": sum(1 for i in inv if i.get("outcome") == "declined"),
            "noreply": sum(1 for i in inv if i.get("outcome") == "noreply"),
            "reviewing_now": len(busy),
            "pending_since": max(pending).isoformat() if pending else "",
            "last_invited": max(d for d in dates if d).isoformat() if any(dates) else "",
            "recently_invited": bool(recent),
            "last_two": last_two, "this_manuscript": this_ms.get(r.get("id"), ""),
        })
    return out


def tracker_match(cand, index):
    """The tracker entry for a candidate: same OpenAlex profile, same ORCID iD, or the same name at a fitting place."""
    for t in index:
        if t["openalex"] and t["openalex"] == cand["id"]:
            return t
        if t["orcid"] and cand.get("orcid") and t["orcid"] == cand["orcid"]:
            return t
    best = None
    for t in index:
        s = max([ic.name_match(t["name"], cand["name"])] + [ic.name_match(t["name"], a) for a in cand.get("alternatives") or []])
        if s < 0.85:
            continue
        if t["affiliation"]:
            aff = ic.terms(t["affiliation"])
            inst_ok = any(len(ic.terms(i["name"]) & aff) >= max(1, len(ic.terms(i["name"])) - 1) for i in cand["institutions"])
            if not inst_ok and s < 0.97:
                continue
        if not best or s > best[0]:
            best = (s, t)
    return best[1] if best else None


# ---------------------------------------------------------------------------
# Gathering candidates
# ---------------------------------------------------------------------------
def credit_for(authorship, n_authors):
    pos = authorship.get("author_position") or "middle"
    lead = pos in ("first", "last") or authorship.get("is_corresponding")
    if n_authors > 50:
        return 0.5 if lead else 0.0
    if n_authors > 15:
        return 0.6 if lead else 0.25
    return 1.0 if lead else 0.6


def recency(year, today):
    age = today.year - (year or 0)
    return 1.0 if age <= 2 else 0.8 if age <= 5 else 0.5


class Pool:
    def __init__(self, today, skip_ids):
        self.today, self.skip = today, set(skip_ids)
        self.people = {}          # id -> {id, name, credit, sources:{}, works:{}}
        self.works = {}           # work id -> summary (with authorship details)
        self.links = {}           # id -> set of co-author ids (within the pool's works)

    def add_work(self, w, source, rank_weight=1.0):
        wid = ic.short_id(w.get("id"))
        auths = w.get("authorships") or []
        summary = self.works.get(wid)
        if not summary:
            src = ((w.get("primary_location") or {}).get("source") or {})
            summary = {"id": wid, "doi": w.get("doi") or "", "title": w.get("display_name") or "",
                       "year": w.get("publication_year"), "venue": src.get("display_name") or "",
                       "topics": [t.get("display_name") or "" for t in (w.get("topics") or [])[:3]],
                       "topic_ids": [ic.short_id(t.get("id")) for t in (w.get("topics") or [])[:3] if t.get("id")],
                       "keywords": [k.get("display_name") or "" for k in (w.get("keywords") or [])[:5]],
                       "cited_by": w.get("cited_by_count") or 0, "n_authors": len(auths),
                       "authors": [{"id": ic.short_id((a.get("author") or {}).get("id")),
                                    "name": (a.get("author") or {}).get("display_name") or "",
                                    "position": a.get("author_position") or "",
                                    "corresponding": bool(a.get("is_corresponding"))} for a in auths]}
            self.works[wid] = summary
        ids = [x["id"] for x in summary["authors"] if x["id"]]
        for a in auths:
            aid = ic.short_id((a.get("author") or {}).get("id"))
            if not aid or aid in self.skip:
                continue
            c = credit_for(a, len(auths)) * recency(summary["year"], self.today) * rank_weight * SOURCE_WEIGHT[source]
            if c <= 0:
                continue
            p = self.people.setdefault(aid, {"id": aid, "name": (a.get("author") or {}).get("display_name") or "",
                                             "credit": 0.0, "sources": {}, "works": {}})
            p["credit"] += c
            p["sources"][source] = p["sources"].get(source, 0) + 1
            role = "corresponding" if a.get("is_corresponding") else (a.get("author_position") or "middle")
            prev = p["works"].get(wid)
            if not prev or c > prev["credit"]:
                p["works"][wid] = {"credit": c, "role": role, "source": source}
        for aid in ids:
            if aid in self.skip:
                continue
            self.links.setdefault(aid, set()).update(x for x in ids if x != aid)

    def add_person(self, aid, name, source, credit, note=""):
        if not aid or aid in self.skip:
            return
        p = self.people.setdefault(aid, {"id": aid, "name": name, "credit": 0.0, "sources": {}, "works": {}})
        p["credit"] += credit * SOURCE_WEIGHT[source]
        p["sources"][source] = p["sources"].get(source, 0) + 1
        if note:
            p.setdefault("notes", []).append(note)


async def search_works(fetch, query, since):
    url = fetch.openalex("/works", search=query, filter=f"from_publication_date:{since}-01-01,type:article|review",
                         per_page=SEARCH_PAGE, select=WORK_SELECT)
    status, data = await fetch.get(url)
    return (data.get("results") or []) if status == 200 and data else None


async def topic_works(fetch, topic_ids, since):
    url = fetch.openalex("/works", filter=f"topics.id:{'|'.join(topic_ids)},from_publication_date:{since}-01-01,"
                                          f"type:article|review", sort="cited_by_count:desc", per_page=SEARCH_PAGE,
                         select=WORK_SELECT)
    status, data = await fetch.get(url)
    return (data.get("results") or []) if status == 200 and data else None


async def works_by_doi(fetch, dois):
    out = []
    for i in range(0, len(dois), CHUNK):
        chunk = dois[i:i + CHUNK]
        url = fetch.openalex("/works", filter="doi:" + "|".join(chunk), per_page=CHUNK, select=WORK_SELECT)
        status, data = await fetch.get(url)
        if status == 200 and data:
            out += data.get("results") or []
    return out


async def works_of(fetch, author_id, since):
    url = fetch.openalex("/works", filter=f"authorships.author.id:{author_id},from_publication_date:{since}-01-01",
                         sort="publication_date:desc", per_page=100, select=WORK_SELECT)
    status, data = await fetch.get(url)
    return (data.get("results") or []) if status == 200 and data else []


async def profiles(fetch, ids):
    out = {}
    chunks = [ids[i:i + CHUNK] for i in range(0, len(ids), CHUNK)]
    res = await asyncio.gather(*(fetch.get(fetch.openalex("/authors", filter="id:" + "|".join(c), per_page=CHUNK,
                                                          select=AUTHOR_SELECT)) for c in chunks))
    for status, data in res:
        if status == 200 and data:
            for a in data.get("results") or []:
                out[ic.short_id(a.get("id"))] = a
    return out


async def retraction_counts(fetch, ids):
    """How many retracted papers each candidate has (one request per 50 candidates)."""
    out, ok = {}, True
    chunks = [ids[i:i + CHUNK] for i in range(0, len(ids), CHUNK)]
    res = await asyncio.gather(*(fetch.get(fetch.openalex("/works", filter="authorships.author.id:" + "|".join(c) +
                                                          ",is_retracted:true", group_by="authorships.author.id"))
                                 for c in chunks))
    wanted = set(ids)
    for status, data in res:
        if status != 200 or data is None:
            ok = False
            continue
        for g in data.get("group_by") or []:
            aid = ic.short_id(g.get("key"))
            if aid in wanted and g.get("count"):
                out[aid] = g["count"]
    return out, ok


async def autocomplete_one(fetch, person):
    """A tracker reviewer's profile, cheaply: the name search, checked against their affiliation."""
    status, data = await fetch.get(fetch.openalex("/autocomplete/authors", q=ic.search_name(person["name"])))
    if status != 200 or not data:
        return None
    aff = ic.terms(person.get("affiliation") or "")
    best = None
    for r in data.get("results") or []:
        s = ic.name_match(person["name"], r.get("display_name") or "")
        if s < 0.85:
            continue
        hint = ic.terms(r.get("hint") or "")
        inst = bool(aff and hint and len(aff & hint) >= max(1, min(len(aff), len(hint)) - 1))
        key = (inst, s, r.get("works_count") or 0)
        if not best or key > best[0]:
            best = (key, r)
    if not best:
        return None
    (inst, s, _), r = best
    if aff and not inst:
        return None
    return ic.short_id(r.get("id"))


# ---------------------------------------------------------------------------
# Judging each candidate
# ---------------------------------------------------------------------------
def seniority(profile, stats):
    h = (stats or {}).get("h_index") or 0
    n = profile["works_count"]
    if n < 15 or h < 6:
        return "early"
    if h >= 25 or n >= 120:
        return "senior"
    return "mid"


SENIORITY_TEXT = {"early": "Early career", "mid": "Mid career", "senior": "Senior"}


def outlook(c, t, fit_label, journal_country, today_year=None):
    pts, why = 0.0, []
    today_year = today_year or date.today().year
    if t:
        if t["invited"]:
            rate = (t["accepted"] + 1) / (t["invited"] + 2)
            if t["accepted"] and rate >= 0.5:
                pts += 2
                why.append(("+", f"Accepted {t['accepted']} of {t['invited']} of your invitations"))
            elif t["invited"] >= 2 and t["accepted"] == 0:
                pts -= 2
                why.append(("-", f"Declined or didn't answer all {t['invited']} of your invitations"))
            if t["submitted"]:
                pts += 1
                why.append(("+", f"Completed {t['submitted']} review{'s' if t['submitted'] > 1 else ''} for you"))
            if t["last_two"] and all(o in ("declined", "noreply") for o in t["last_two"]) and len(t["last_two"]) == 2:
                pts -= 1
                why.append(("-", "Turned down your last two invitations"))
        if t["pending_since"]:
            pts -= 2
            why.append(("-", f"Has an invitation from you still unanswered (sent {t['pending_since']})"))
        elif t["recently_invited"]:
            pts -= 1
            why.append(("-", f"You invited them recently ({t['last_invited']})"))
        if t["reviewing_now"]:
            pts -= 1
            why.append(("-", "Is already reviewing for you"))
        if t["dead"]:
            pts -= 3
            why.append(("-", "Their email bounced before"))
    if c["recent_works"] == 0:
        pts -= 2
        why.append(("-", f"No indexed papers in {today_year - 2}–{today_year}"))
    if c["seniority"] == "early":
        pts += 1
        why.append(("+", "Earlier-career researchers accept more often"))
    elif c["seniority"] == "senior":
        pts -= 0.5
        why.append(("-", "Senior researchers accept less often"))
    if fit_label == "Strong":
        pts += 1
        why.append(("+", "The manuscript is close to their own recent work"))
    if journal_country and c["country"] and c["country"].upper() == journal_country.upper():
        pts += 0.5
        why.append(("+", "Based in the journal's country"))
    label = "High" if pts >= 2 else "Medium" if pts >= 0 else "Low"
    return label, pts, why


def mmr_order(cands, limit=None):
    """Best first, but a candidate who shares an institution with, or has published with, someone already chosen
    moves down, and one country can't fill the list."""
    left = [c for c in cands if not c["conflicted"]]
    chosen, inst_seen, country_n = [], set(), {}
    ids_chosen = set()
    while left and (limit is None or len(chosen) < limit):
        def value(c):
            v = c["score"]
            if c["institution_key"] and c["institution_key"] in inst_seen:
                v -= 25
            if set(c["coauthors_in_list"]) & ids_chosen:
                v -= 15
            n = country_n.get(c["country"] or "?", 0)
            v -= 6 * max(0, n - 1)
            return v
        best = max(left, key=value)
        left.remove(best)
        chosen.append(best)
        ids_chosen.add(best["id"])
        if best["institution_key"]:
            inst_seen.add(best["institution_key"])
        country_n[best["country"] or "?"] = country_n.get(best["country"] or "?", 0) + 1
    return chosen + left


# ---------------------------------------------------------------------------
# The whole search
# ---------------------------------------------------------------------------
def context(session):
    ctx = ic.context(session)
    opts = session.get("options") or {}
    ctx["journal_country"] = (opts.get("journal_country") or "").strip().upper()[:2]
    ctx["recent_years"] = int(opts.get("recent_years") or 5)
    ctx["limit"] = int(opts.get("limit") or 40)
    ctx["seeds"] = [s for s in opts.get("seeds") or [] if re.fullmatch(r"A\d+", s or "")]
    ctx["manuscript_id"] = (opts.get("manuscript_id") or "").strip()
    # Reviewer Pulse look-ups: every candidate returned, unless a limit is set (beyond it, cards say so and offer a check)
    ctx["pulse_limit"] = None if opts.get("pulse_limit") is None else max(0, int(opts["pulse_limit"]))
    return ctx


async def find(session, fetch, progress=None):
    def tell(step, text):
        if progress:
            progress(step, 8, text)

    ctx = context(session)
    today = ctx["today"]
    since = today.year - ctx["recent_years"]
    coi_since = today.year - ctx["lookback"]
    if not (ctx["title"] or ctx["keywords"] or ctx["abstract"]):
        raise ValueError("Add the manuscript's title, keywords or abstract, so there is something to match reviewers to.")
    warnings = []

    # 1. The manuscript's authors (to look for overlap) and the authors' own suggested reviewers (checked by Cygnus)
    tell(1, "Finding the manuscript's authors")
    authors = [dict(p, role="author") for p in session.get("authors") or [] if (p.get("name") or "").strip()]
    suggested = [dict(p, role="reviewer") for p in session.get("suggested") or [] if (p.get("name") or "").strip()]
    excluded = [p for p in session.get("excluded") or [] if (p.get("name") or "").strip()]
    people_session = {"people": authors + suggested, "manuscript": session.get("manuscript") or {},
                      "lookback_years": ctx["lookback"], "today": today.isoformat()}
    if authors or suggested:
        people, infos, rors, _ = await ic.look_up(people_session, fetch)
    else:
        people, infos, rors = [], [], {"aff": {}, "domain": {}}
    pairs = list(zip(people, infos))
    author_pairs = [(p, i) for p, i in pairs if p["role"] == "author"]
    author_ids, coauthored, author_insts, unresolved = set(), {}, {}, []
    for p, i in author_pairs:
        if i["profile"] and i["match"] in ("matched", "limited"):
            author_ids.add(i["profile"]["id"])
            for w in i["works"]:
                if (w["year"] or 0) >= coi_since:
                    for x in w["authors"]:
                        if x["id"]:
                            coauthored.setdefault(x["id"], (p["name"], w))
            for iid in ic.current_insts(i, rors, p):
                author_insts[iid] = p["name"]
        else:
            unresolved.append(p["name"])
            if i["profile"] and i["match"] == "multiple":
                for c in [i["profile"]] + i["candidates"][:2]:
                    author_ids.add(c["id"])
    if unresolved:
        warnings.append("Couldn't confirm a research profile for " + ", ".join(unresolved) + ": co-authorship with "
                        + ("them" if len(unresolved) > 1 else "this author")
                        + " is checked by name only. Pick their profile in Check a person for a full check.")
    suggested_results = ic.results_from(people, infos, rors, {**ctx}, fetch)
    suggested_results = [r for r in suggested_results["results"] if r["role"] == "reviewer"] if pairs else []

    # 2. Topic search
    tell(2, "Searching recent papers on the manuscript's subject")
    pool = Pool(today, author_ids)
    queries = search_queries(ctx)
    found = await asyncio.gather(*(search_works(fetch, q, since) for q in queries))
    failed = sum(1 for f in found if f is None)
    if failed == len(found) and found:
        raise RuntimeError("OpenAlex couldn't be reached, so no reviewers could be searched for. Please try again; if it "
                           "keeps happening, check the OpenAlex API key in Settings.")
    if failed:
        warnings.append(f"{failed} of {len(found)} searches couldn't be completed; results may be thinner than usual.")
    topic_count = {}
    for res in found:
        for rank, w in enumerate(res or []):
            pool.add_work(w, "search", 1 / (1 + rank / 10))
            if rank < 20:
                for t in (w.get("topics") or [])[:1]:
                    tid = ic.short_id(t.get("id"))
                    if tid:
                        topic_count[tid] = (topic_count.get(tid, (0, t.get("display_name") or ""))[0] + 1, t.get("display_name") or "")
    topics = [tid for tid, _ in sorted(topic_count.items(), key=lambda x: -x[1][0])[:3]]

    # 3. Leaders in the topics, and authors the manuscript cites
    tell(3, "Looking at leading papers and the reference list")
    refs = session.get("manuscript", {}).get("references") or []
    dois = list(dict.fromkeys(d.lower() for d in (r.get("doi") for r in refs) if d))[:150]
    jobs = [topic_works(fetch, topics, since)] if topics else []
    jobs.append(works_by_doi(fetch, dois))
    res = await asyncio.gather(*jobs)
    if topics:
        for rank, w in enumerate(res[0] or []):
            pool.add_work(w, "topic", 1 / (1 + rank / 10))
    cited = res[-1]
    for w in cited:
        if (w.get("publication_year") or 0) >= today.year - 10:
            pool.add_work(w, "cited", 1.0)

    # The manuscript may already be public (a preprint, or a published paper being tried out). Whoever wrote that
    # paper is an author here, even if no authors were given: they and their co-authors must not be suggested.
    self_authors = {}                                   # author id -> (name, the paper)
    for w in pool.works.values():
        if same_title(ctx["title"], w["title"]):
            for x in w["authors"]:
                if x["id"] and x["id"] not in author_ids:
                    self_authors.setdefault(x["id"], (x["name"], w))
    if self_authors:
        own = await asyncio.gather(*(works_of(fetch, aid, coi_since) for aid in list(self_authors)[:12]))
        for aid, ws in zip(list(self_authors)[:12], own):
            for raw in ws or []:
                sw = ic.work_summary(raw)
                if (sw["year"] or 0) >= coi_since and not same_title(ctx["title"], sw["title"]):
                    for x in sw["authors"]:
                        if x["id"] and x["id"] not in self_authors:
                            coauthored.setdefault(x["id"], (self_authors[aid][0], sw))
        paper = next(iter(self_authors.values()))[1]
        who = ", ".join(n for n, _ in list(self_authors.values())[:4]) + (" and others" if len(self_authors) > 4 else "")
        warnings.append(f"This manuscript looks already published: OpenAlex lists a paper with the same title"
                        f"{' in ' + paper['venue'] if paper['venue'] else ''}{' (' + str(paper['year']) + ')' if paper['year'] else ''}"
                        f" by {who}. They are treated as its authors and left out, along with their recent co-authors.")

    # 4. Your reviewers, and the networks of the reliable ones
    tell(4, "Checking your Invitations list")
    index = tracker_index(session.get("tracker"), today, ctx["manuscript_id"])
    mvec = manuscript_vector(ctx)
    fitting = []
    for t in index:
        text = " ".join(t["keywords"])
        hits, overlap = ic.subject_fit(ctx["keywords"], ctx["title"], text + " " + t["affiliation"])
        tv = {}
        for w in words(text):
            tv[w] = tv.get(w, 0) + 1
        sim = cosine(mvec, tv, {})
        if hits or sim >= 0.12:
            fitting.append((t, len(hits) + sim))
    fitting.sort(key=lambda x: -x[1])
    need = [t for t, _ in fitting[:12] if not t["openalex"]]
    resolved = await asyncio.gather(*(autocomplete_one(fetch, t) for t in need))
    for t, aid in zip(need, resolved):
        if aid:
            t["openalex"] = aid
    tracker_only = []
    for t, s in fitting[:12]:
        if t["openalex"]:
            pool.add_person(t["openalex"], t["name"], "tracker", 1.0 + s)
        else:
            tracker_only.append(t)
    seeds = [(sid, " (you picked)") for sid in ctx["seeds"]]
    reliable = [t for t, _ in fitting if t["openalex"] and t["accepted"] and not t["dead"]][:3]
    seeds += [(t["openalex"], ", who has accepted your invitations before") for t in reliable if t["openalex"] not in ctx["seeds"]]
    seed_works = await asyncio.gather(*(works_of(fetch, sid, coi_since) for sid, _ in seeds))
    seed_names = {}
    for (sid, why), ws in zip(seeds, seed_works):
        for w in ws:
            for a in w.get("authorships") or []:
                aid = ic.short_id((a.get("author") or {}).get("id"))
                if aid == sid:
                    seed_names[sid] = (a.get("author") or {}).get("display_name") or ""
        for w in ws:
            for a in w.get("authorships") or []:
                aid = ic.short_id((a.get("author") or {}).get("id"))
                if aid and aid != sid:
                    pool.add_person(aid, (a.get("author") or {}).get("display_name") or "", "network", 0.6,
                                    f"Co-author of {seed_names.get(sid) or 'a reviewer you trust'}{why}")
            pool.add_work(w, "network", 0.0)       # for co-author links and evidence only

    # 5. Profiles of the strongest candidates
    tell(5, "Reading candidates' research profiles")
    excluded_names = [p["name"] for p in excluded]
    ranked = sorted(pool.people.values(), key=lambda p: -p["credit"])
    picked = [p for p in ranked if p["credit"] > 0][:POOL_LIMIT]
    must = [p for p in pool.people.values() if ("tracker" in p["sources"] or "network" in p["sources"]) and p not in picked]
    picked += must[:30]
    ids = [p["id"] for p in picked]
    profs = await profiles(fetch, ids)
    retracted, retractions_ok = await retraction_counts(fetch, [i for i in ids if i in profs])
    if not retractions_ok:
        warnings.append("Retracted papers couldn't be checked for every candidate this time.")

    # 6. Judging and ranking
    tell(6, "Looking for overlap with the authors, and ranking")
    texts, idf_df = {}, {}
    for p in picked:
        a = profs.get(p["id"])
        if not a:
            continue
        parts = []
        for wid in p["works"]:
            w = pool.works.get(wid)
            if w:
                parts.append((w["title"] + " ") * 2 + " ".join(w["topics"] + w["keywords"]))
        parts += [t.get("display_name") or "" for t in (a.get("topics") or [])[:8]]
        vec = {}
        for w in words(" ".join(parts)):
            vec[w] = vec.get(w, 0) + 1
        texts[p["id"]] = vec
        for w in vec:
            idf_df[w] = idf_df.get(w, 0) + 1
    n_docs = max(1, len(texts))
    idf = {w: math.log((n_docs + 1) / (df + 1)) + 1 for w, df in idf_df.items()}
    sims = {pid: cosine(mvec, vec, idf) for pid, vec in texts.items()}
    max_sim = max(sims.values(), default=0) or 1
    max_credit = max((p["credit"] for p in picked if p["id"] in profs), default=0) or 1

    cands, conflicted, dropped = [], [], 0
    for p in picked:
        a = profs.get(p["id"])
        if not a:
            continue
        prof = ic.author_summary(a, today)
        stats = a.get("summary_stats") or {}
        inst = next((i for i in prof["institutions"] if i.get("current")), None)
        matched = sorted((pool.works[wid] | {"role": info["role"], "w_credit": info["credit"]}
                          for wid, info in p["works"].items() if wid in pool.works and info["credit"] > 0),
                         key=lambda w: -w["w_credit"])
        evidence_papers = [{k: w[k] for k in ("title", "year", "venue", "doi", "role")} for w in matched[:3]]
        contact = next((w for w in matched if w["role"] == "corresponding" and w["doi"]), None)
        profile_text = " ".join(t["name"] + " " + t["subfield"] + " " + t["field"] for t in prof["topics"]) + " " + \
            " ".join(w["title"] + " " + " ".join(w["keywords"]) for w in matched[:10])
        hits, _ = ic.subject_fit(ctx["keywords"], ctx["title"], profile_text)
        sim = sims.get(p["id"], 0) / max_sim
        if sim < 0.15 and not hits:
            dropped += 1                       # their work doesn't match the manuscript (e.g. a cited methods paper)
            continue
        fit = round(0.65 * sim + 0.35 * min(1.0, p["credit"] / max_credit), 3)
        fit_label = "Strong" if fit >= 0.6 else "Good" if fit >= 0.38 else "Partial"
        c = {"id": prof["id"], "name": prof["name"], "alternatives": prof["alternatives"], "orcid": prof["orcid"],
             "url": prof["url"], "institution": inst["name"] if inst else "", "country": inst["country"] if inst else "",
             "institution_key": (inst["ror"] or inst["id"]) if inst else "", "institutions": prof["institutions"],
             "works_count": prof["works_count"], "cited_by_count": prof["cited_by_count"],
             "h_index": stats.get("h_index") or 0, "recent_works": prof["recent_works"], "last_year": prof["last_year"],
             "fields": list(dict.fromkeys(t["subfield"] for t in prof["topics"] if t["subfield"]))[:3],
             "matches": hits, "papers": evidence_papers, "matched_count": len(matched),
             "contact_paper": {k: contact[k] for k in ("title", "year", "doi")} if contact else None,
             "sources": [SOURCE_TEXT[s] for s in ("search", "topic", "cited", "tracker", "network") if s in p["sources"]],
             "source_keys": [s for s in ("search", "topic", "cited", "tracker", "network") if s in p["sources"]],
             "notes": list(dict.fromkeys(p.get("notes") or []))[:2], "fit": fit, "fit_label": fit_label,
             "retracted": retracted.get(p["id"], 0)}
        c["seniority"] = seniority(prof, stats)
        # Independence
        reasons = []
        if p["id"] in self_authors:
            w = self_authors[p["id"]][1]
            reasons.append({"text": f"An author of this manuscript: OpenAlex lists them on a paper with the same title ({w['year']})",
                            "paper": w["title"], "doi": w["doi"]})
        if p["id"] in coauthored:
            who, w = coauthored[p["id"]]
            reasons.append({"text": f"Shared publication with the author {who} ({w['year']}, OpenAlex)", "paper": w["title"], "doi": w["doi"]})
        if c["institution_key"] and c["institution_key"] in author_insts:
            reasons.append({"text": f"Same current institution as the author {author_insts[c['institution_key']]} (OpenAlex)"})
        elif inst and inst["ror"]:
            for ap, ai in author_pairs:
                aff = ap.get("affiliation") or ""
                if aff and ic.fold(inst["name"]) and ic.fold(inst["name"]) in ic.fold(aff):
                    reasons.append({"text": f"Same institution as the author {ap['name']} (matched by name)"})
                    break
        for name in unresolved:
            for w in matched + [pool.works[x] for x in p["works"] if x in pool.works]:
                if (w["year"] or 0) >= coi_since and any(ic.name_match(name, x["name"]) >= 0.9 for x in w["authors"]
                                                          if x["id"] != p["id"]):
                    reasons.append({"text": f"Possible shared publication with the author {name} ({w['year']}): "
                                            "matched by name only, please check", "paper": w["title"], "doi": w["doi"]})
                    break
        for name in excluded_names:
            if ic.name_match(name, c["name"]) >= 0.9 or any(ic.name_match(name, x) >= 0.9 for x in c["alternatives"]):
                reasons.append({"text": "On the exclusion list"})
        for sp, si in pairs:
            if sp["role"] == "reviewer" and si["profile"] and si["profile"]["id"] == c["id"]:
                c["suggested_by_authors"] = True
        c["conflicts"] = reasons
        c["conflicted"] = bool(reasons)
        # Tracker and outlook
        t = tracker_match(c, index)
        c["tracker"] = t and {k: t[k] for k in ("tracker_id", "email", "invited", "accepted", "submitted", "declined",
                                                 "noreply", "pending_since", "last_invited", "dead",
                                                 "this_manuscript")}
        c["email"] = t["email"] if t and not t["dead"] else ""
        label, pts, why = outlook(c, t, fit_label, ctx["journal_country"], today.year)
        c["outlook"], c["outlook_points"], c["outlook_why"] = label, pts, why
        flags = []
        if c["retracted"]:
            flags.append({"level": "concern", "text": f"OpenAlex lists {c['retracted']} retracted paper{'s' if c['retracted'] > 1 else ''}"
                                                      ": please check before inviting"})
        if c["recent_works"] == 0:
            flags.append({"level": "check", "text": f"No indexed papers in {today.year - 2}–{today.year}"})
        if t and t["dead"]:
            flags.append({"level": "check", "text": "Email marked as bounced in your tracker"})
        if t and t["pending_since"]:
            flags.append({"level": "check", "text": f"Your invitation of {t['pending_since']} is still unanswered"})
        if c.get("suggested_by_authors"):
            flags.append({"level": "check", "text": "Also suggested by the authors: see their identity check below"})
        if c["works_count"] < 5:
            flags.append({"level": "check", "text": "Very short publication record: check seniority against the journal's policy"})
        c["flags"] = flags
        activity = min(c["recent_works"], 10) / 10
        score = 100 * (0.6 * fit + 0.25 * (max(-4, min(4, pts)) + 4) / 8 + 0.15 * activity)
        score -= 10 if c["retracted"] else 0
        score -= 12 if c["recent_works"] == 0 else 0
        score -= 8 if t and t["dead"] else 0
        c["score"] = round(score, 1)
        (conflicted if c["conflicted"] else cands).append(c)

    ids_in = {c["id"] for c in cands}
    for c in cands:
        c["coauthors_in_list"] = sorted(x for x in pool.links.get(c["id"], set()) if x in ids_in)
    by_id = {c["id"]: c for c in cands}
    for c in cands:
        c["pair_notes"] = [f"Has published with {by_id[x]['name']} (also listed)" for x in c["coauthors_in_list"]][:3]
        same = [o["name"] for o in cands if o is not c and o["institution_key"] and o["institution_key"] == c["institution_key"]]
        if same:
            c["pair_notes"].append(f"Same institution as {', '.join(same[:2])}{' and others' if len(same) > 2 else ''} (also listed)")
    cands.sort(key=lambda c: -c["score"])
    ordered = mmr_order(cands)
    for n, c in enumerate(ordered, 1):
        c["rank"] = n
    ordered = ordered[:max(ctx["limit"], 10) + 20]
    conflicted.sort(key=lambda c: -c["fit"])

    # Tracker reviewers who fit but have no research profile yet
    extra = []
    for t in tracker_only[:8]:
        if any(ic.name_match(t["name"], c["name"]) >= 0.9 for c in ordered + conflicted):
            continue
        reasons = []
        for ap, _ in author_pairs:
            if t["affiliation"] and ap.get("affiliation") and len(ic.terms(t["affiliation"]) & ic.terms(ap["affiliation"])) >= 2:
                reasons.append(f"Affiliation looks similar to the author {ap['name']}'s")
        extra.append({"name": t["name"], "email": "" if t["dead"] else t["email"], "affiliation": t["affiliation"],
                      "keywords": t["keywords"], "tracker_id": t["tracker_id"], "invited": t["invited"],
                      "accepted": t["accepted"], "pending_since": t["pending_since"], "dead": t["dead"],
                      "warnings": reasons + ["No research profile found: overlap with the authors couldn't be checked "
                                             "against publication records"]})

    # 7. Reviewer Pulse: public reviewing records from ORCID, shown with each candidate, never counted in the score
    tell(7, "Reading public reviewing records (ORCID)")
    import pulse
    limit = len(ordered) if ctx["pulse_limit"] is None else ctx["pulse_limit"]
    todo = [(c["id"], c["orcid"], c["name"], "ORCID iD on their OpenAlex profile") for c in ordered[:limit] if c["orcid"]]
    found_pulse = await pulse.pulse_many(fetch, todo, today)
    for c in ordered:
        if c["id"] in found_pulse:
            c["pulse"] = found_pulse[c["id"]]
        elif not c["orcid"]:
            c["pulse"] = pulse.empty("no_orcid", "", "", ["No ORCID iD on their OpenAlex profile, so their public "
                                                          "reviewing record wasn't checked."])
        else:
            c["pulse"] = pulse.empty("limit", c["orcid"], "ORCID iD on their OpenAlex profile",
                                     [f"Only the first {limit} candidates were looked up, to keep the search quick. "
                                      "Use “Check now” to look this one up."])
    tell(8, "Done")
    return {
        "candidates": ordered, "conflicted": conflicted[:30], "tracker_extra": extra, "suggested": suggested_results,
        "author_countries": sorted({x["country"] for _, i in author_pairs if i["profile"] and i["match"] in ("matched", "limited")
                                    for x in i["profile"]["institutions"] if x.get("current") and x["country"]}),
        "authors": [{"name": p["name"], "match": i["match"],
                     "profile": i["profile"] and {"id": i["profile"]["id"], "name": i["profile"]["name"], "url": i["profile"]["url"],
                                                  "institution": next((x["name"] for x in i["profile"]["institutions"] if x.get("current")), "")}}
                    for p, i in author_pairs],
        "method": {"queries": queries, "topics": [topic_count[t][1] for t in topics], "references_with_doi": len(dois),
                   "references_found": len(cited), "considered": len(pool.people), "profiles": len(profs), "low_fit": dropped,
                   "since": since, "independence_since": coi_since, "seeds": [s for s, _ in seeds],
                   "tracker_matches": sum(1 for c in ordered + conflicted if c.get("tracker"))},
        "warnings": warnings, "manuscript": {"title": ctx["title"], "keywords": ctx["keywords"]},
        "retrieved": today.isoformat(), "requests": len(fetch.calls), "limit": ctx["limit"],
    }


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------
def _shortlist(out):
    by_id = {c["id"]: c for c in out["candidates"] + out["conflicted"]}
    rows = []
    for s in out.get("shortlist") or []:
        c = by_id.get(s.get("id"))
        if c:
            rows.append((s.get("role") or "primary", c))
    return rows


def _why(c, out_year=None):
    out_year = out_year or date.today().year
    bits = [f"{c['fit_label']} fit"]
    if c["matches"]:
        bits.append("matches " + ", ".join(c["matches"][:4]))
    bits.append(f"{c['recent_works']} papers in {years_label(out_year)}")
    return "; ".join(bits)


def pulse_line(p):
    import pulse
    return pulse.one_line(p)


def build_excel(out, path):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    wb = Workbook()
    head = Font(bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor="2A2620")
    wrap = Alignment(wrap_text=True, vertical="top")

    def sheet(ws, headers, rows, widths):
        ws.append(headers)
        for cell in ws[1]:
            cell.font, cell.fill = head, fill
        for r in rows:
            ws.append(r)
        for i, w in enumerate(widths):
            ws.column_dimensions[chr(65 + i)].width = w
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = wrap
        ws.freeze_panes = "A2"

    ws = wb.active
    ws.title = "Candidates"
    short = {c["id"]: role for role, c in _shortlist(out)}
    sheet(ws, ["Rank", "Shortlist", "Name", "Institution", "Country", "Fit", "Outlook", "Score", "Why", "Matching papers",
               "Flags", "Found through", f"Papers {years_label(int(out['retrieved'][:4]))}", "h-index", "Public reviewing record (ORCID; not in the score)",
               "Email (tracker)", "Contact via paper", "OpenAlex", "ORCID"],
          [[c["rank"], short.get(c["id"], ""), c["name"], c["institution"], c["country"], c["fit_label"], c["outlook"], c["score"],
            _why(c, int(out["retrieved"][:4])) + ("\n" + "\n".join(("+ " if s == "+" else "- ") + t for s, t in c["outlook_why"]) if c["outlook_why"] else ""),
            "\n".join(f"{p['title']} ({p['year']}) {p['doi']}" for p in c["papers"]),
            "\n".join(f["text"] for f in c["flags"]) + ("\n" if c["flags"] and c["pair_notes"] else "") + "\n".join(c["pair_notes"]),
            "; ".join(c["sources"]), c["recent_works"], c["h_index"], pulse_line(c.get("pulse")), c["email"],
            (c["contact_paper"]["doi"] if c["contact_paper"] else ""), c["url"],
            f"https://orcid.org/{c['orcid']}" if c["orcid"] else ""] for c in out["candidates"]],
          [6, 10, 24, 30, 8, 9, 9, 7, 46, 60, 40, 30, 10, 8, 46, 26, 30, 32, 30])
    ws2 = wb.create_sheet("Potential overlaps")
    sheet(ws2, ["Name", "Institution", "What was found", "Evidence", "Fit", "OpenAlex"],
          [[c["name"], c["institution"], "\n".join(r["text"] for r in c["conflicts"]),
            "\n".join(f"{r.get('paper', '')} {r.get('doi', '')}".strip() for r in c["conflicts"] if r.get("paper")),
            c["fit_label"], c["url"]] for c in out["conflicted"]], [24, 30, 50, 60, 9, 32])
    if out.get("suggested"):
        ws3 = wb.create_sheet("Author-suggested")
        sheet(ws3, ["Name", "Email", "Affiliation", "Identity and overlap", "Findings", "Queries"],
              [[r["name"], r["email"], r["affiliation"], ic.VERDICT_TEXT.get(r["verdict"], r["verdict"]),
                "\n".join(f"{f['check']}: {f['label']}" for f in r["findings"]), "\n".join(r["queries"])]
               for r in out["suggested"]], [24, 30, 30, 22, 60, 60])
    ws4 = wb.create_sheet("How this was found")
    m = out["method"]
    rows = [["Manuscript", out["manuscript"]["title"]], ["Keywords", ", ".join(out["manuscript"]["keywords"])],
            ["Searched on", out["retrieved"]], ["Papers searched from", str(m["since"])],
            ["Overlap with the authors checked from", str(m["independence_since"])],
            ["Searches", "\n".join(m["queries"])], ["Research topics", ", ".join(m["topics"])],
            ["References with a DOI", f"{m['references_with_doi']} ({m['references_found']} found)"],
            ["Researchers considered", str(m["considered"])], ["Profiles read", str(m["profiles"])],
            ["Left out: work doesn't match", str(m.get("low_fit", 0))],
            ["Public reviewing records", "Read from public ORCID records for candidates with an ORCID iD (Reviewer Pulse). "
                                         "Shown as evidence only: not counted in the ranking."],
            ["Ranking", "Fit 60% (similarity of their recent work to the manuscript, and search evidence), outlook 25% "
                        "(your tracker history first, then career stage, recent activity, open invitations), "
                        "activity 15% (papers in this calendar year and the two before). Anyone with a potential overlap "
                        "with the authors is listed separately and kept out of the ranking; finding no overlap doesn't "
                        "confirm independence."],
            ["Limits", "Built on OpenAlex, which doesn't hold every researcher, email address or unpublished link. "
                       "Check each candidate before inviting."]]
    rows += [["Note", w] for w in out.get("warnings") or []]
    sheet(ws4, ["", ""], rows, [28, 100])
    wb.save(path)


def build_word(out, path):
    from docx import Document
    from docx.shared import Pt
    doc = Document()
    doc.styles["Normal"].font.size = Pt(10)
    doc.add_heading("Find reviewers", 0)
    doc.add_paragraph(out["manuscript"]["title"] or "Manuscript")
    doc.add_paragraph(f"Searched {out['retrieved']}. Overlap with the authors looked for in OpenAlex from "
                      f"{out['method']['independence_since']}; finding none doesn't confirm independence.")
    chosen = _shortlist(out) or [("candidate", c) for c in out["candidates"][:10]]
    doc.add_heading("Shortlist" if out.get("shortlist") else "Top candidates", 1)
    for role, c in chosen:
        p = doc.add_paragraph(style="List Number")
        p.add_run(c["name"]).bold = True
        p.add_run(f" — {c['institution'] or 'institution not known'}{', ' + c['country'] if c['country'] else ''}"
                  f"{'  (alternate)' if role == 'alternate' else ''}")
        doc.add_paragraph(f"{c['fit_label']} fit · outlook {c['outlook']} · {_why(c, int(out['retrieved'][:4]))}")
        for paper in c["papers"][:2]:
            doc.add_paragraph(f"{paper['title']} ({paper['year']}) {paper['doi']}", style="List Bullet")
        for f in c["flags"] + [{"text": n} for n in c["pair_notes"]]:
            doc.add_paragraph("Note: " + f["text"], style="List Bullet")
        doc.add_paragraph(f"OpenAlex: {c['url']}" + (f" · ORCID: https://orcid.org/{c['orcid']}" if c["orcid"] else "")
                          + (f" · Email: {c['email']}" if c["email"] else ""))
    if out["conflicted"]:
        doc.add_heading("Potential overlap with the authors (kept out of the ranking)", 1)
        for c in out["conflicted"][:15]:
            doc.add_paragraph(f"{c['name']} ({c['institution']}): " + "; ".join(r["text"] for r in c["conflicts"]),
                              style="List Bullet")
    if out.get("suggested"):
        doc.add_heading("Reviewers suggested by the authors", 1)
        for r in out["suggested"]:
            doc.add_paragraph(f"{r['name']}: {ic.VERDICT_TEXT.get(r['verdict'], r['verdict'])}", style="List Bullet")
    doc.add_paragraph("Built on OpenAlex. Check each candidate before inviting: the tool suggests, the editor decides.")
    doc.save(path)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    session = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    import os
    fetch = ic.UrllibFetcher(openalex_key=os.environ.get("OPENALEX_API_KEY", ""),
                             ror_client_id=os.environ.get("ROR_CLIENT_ID", ""))

    def show(step, total, text):
        print(f"[{step}/{total}] {text}")
    out = asyncio.run(find(session, fetch, show))
    for c in out["candidates"][:15]:
        print(f"{c['rank']:>2}. {c['name']} — {c['institution']} ({c['country']}) · {c['fit_label']} fit · "
              f"outlook {c['outlook']} · score {c['score']}")
    if out["conflicted"]:
        print("\nPotential overlap with the authors:")
        for c in out["conflicted"][:10]:
            print(f"  {c['name']}: " + "; ".join(r["text"] for r in c["conflicts"]))
    for w in out["warnings"]:
        print("Note:", w)
    build_excel(out, "reviewer_finder.xlsx")
    print("\nSaved reviewer_finder.xlsx")
    if "--word" in sys.argv:
        build_word(out, "reviewer_finder.docx")
        print("Saved reviewer_finder.docx")


if __name__ == "__main__":
    main()
