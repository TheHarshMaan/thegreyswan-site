"""
Cygnus (the Researcher Check): authors and suggested reviewers, checked against open research databases.

For each person (name, email, affiliation, ORCID iD, role) it looks up:
  - OpenAlex  (openalex.org): researcher profiles, publications, affiliations and co-authors
  - ROR       (ror.org): the registry of research institutions, and their web domains
  - ORCID     (orcid.org): the researcher's public ORCID record, when an iD is given

and reports, with the evidence and a link for every finding:
  - whether a matching researcher profile exists (or several do, for common names)
  - whether the ORCID iD is valid and belongs to this person
  - whether the email address fits the declared affiliation (free webmail, another institution's domain,
    a look-alike domain)
  - whether the declared affiliation appears in the public profile
  - whether their publications fit the manuscript's subject
  - their publication record (established, early-career, limited)
  - for suggested reviewers: co-authorship with the manuscript's authors, shared institution or email domain
and gives each person a plain verdict: green (no issues found), amber (points to check) or red (important points to check
proceeding), with author queries written in the screening-desk style ("Please …").

It flags; it never accuses. A free email address, a short publication record or no profile at all are reasons
to check, not evidence of misconduct, and a clean result doesn't prove identity or independence: only the
journal's own process can confirm who controls an email address.

The co-author network: for a reviewer who checks out, their recent co-authors are ranked as further reviewer
candidates (subject fit, recent activity), leaving out anyone who has published with the manuscript's authors
or works at their institution.

Used by the website (web_entry.py, in the visitor's browser) and from the command line:
    python idcheck.py session.json            (looks everything up live)
    python idcheck.py session.json --word     (also writes a Word report)
session.json: {"manuscript": {"title", "abstract", "keywords": [...]}, "lookback_years": 5,
               "people": [{"id", "name", "email", "affiliation", "orcid", "role": "author" | "reviewer"}]}
Set OPENALEX_API_KEY (free, from openalex.org) and optionally ROR_CLIENT_ID for higher limits.
"""

import asyncio
import json
import re
import sys
import unicodedata
from datetime import date
from urllib.parse import urlencode, urlparse

OPENALEX = "https://api.openalex.org"
ROR = "https://api.ror.org/v2/organizations"
ORCID_API = "https://pub.orcid.org/v3.0"
CONTACT = "editorial@thegreyswan.in"

# ---------------------------------------------------------------------------
# Email domains
# ---------------------------------------------------------------------------
WEBMAIL = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "yahoo.in", "ymail.com",
    "rocketmail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "icloud.com",
    "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net",
    "mail.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "foxmail.com", "163.com", "126.com",
    "yeah.net", "sina.com", "sina.cn", "sohu.com", "139.com", "aliyun.com", "rediffmail.com", "zoho.com",
    "zohomail.in", "naver.com", "daum.net", "hanmail.net", "web.de", "t-online.de", "libero.it", "tutanota.com",
    "hey.com", "fastmail.com", "inbox.com", "usa.com", "seznam.cz", "wp.pl", "o2.pl", "rambler.ru",
}
# Two-part endings under which institutions register (ox.ac.uk, iitd.ac.in, unimelb.edu.au …)
SECOND_LEVEL = {
    "ac.uk", "co.uk", "org.uk", "nhs.uk", "gov.uk", "ac.in", "edu.in", "res.in", "nic.in", "gov.in", "org.in",
    "co.in", "ernet.in", "edu.au", "org.au", "gov.au", "ac.nz", "ac.jp", "go.jp", "ac.kr", "re.kr", "edu.cn",
    "ac.cn", "org.cn", "edu.hk", "edu.tw", "edu.sg", "edu.my", "ac.id", "ac.th", "edu.ph", "edu.vn", "edu.pk",
    "edu.bd", "ac.bd", "edu.np", "ac.lk", "ac.ir", "edu.tr", "ac.il", "edu.sa", "edu.eg", "edu.jo", "edu.lb",
    "ac.za", "ac.ke", "edu.ng", "edu.gh", "ac.ug", "ac.tz", "edu.br", "usp.br", "edu.ar", "edu.mx", "edu.co",
    "edu.pe", "edu.ec", "edu.uy", "edu.cl", "ac.at", "ac.be", "ac.cy", "edu.pl", "ac.rs", "edu.ru", "ac.ru",
    "ac.ma", "ens.tn", "edu.qa", "ac.ae", "edu.om", "edu.kw", "ac.ir", "med.sa",
}


def email_domain(email):
    m = re.search(r"@([\w.-]+\.[a-z]{2,})\s*$", (email or "").strip().lower())
    return m.group(1).strip(".") if m else ""


def registrable(domain):
    """The part an institution actually registers: med.harvard.edu -> harvard.edu, cs.ox.ac.uk -> ox.ac.uk."""
    labels = [l for l in (domain or "").lower().strip(".").split(".") if l]
    if len(labels) >= 3 and ".".join(labels[-2:]) in SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def host_of(url):
    try:
        host = urlparse(url if "//" in url else "//" + url).netloc.lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def domain_fits(domain, candidates):
    """The email domain belongs to one of the institution's domains (or a subdomain of one)."""
    reg = registrable(domain)
    for c in candidates:
        c = (c or "").lower().strip(".")
        if c and (domain == c or domain.endswith("." + c) or reg == registrable(c)):
            return True
    return False


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def lookalike(domain, real):
    """oxfrod.ac.uk for ox.ac.uk-style tricks: close to, but not the same as, the institution's domain."""
    a, b = registrable(domain), registrable(real)
    if not a or not b or a == b or len(b) < 6:
        return False
    return edit_distance(a, b) <= 2 or (b.split(".")[0] in a.split(".")[0] and a.split(".")[-1] == b.split(".")[-1]
                                        and a.split(".")[0] != b.split(".")[0])


# ---------------------------------------------------------------------------
# ORCID iDs
# ---------------------------------------------------------------------------
ORCID_RE = re.compile(r"(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dXx])")


def clean_orcid(text):
    m = ORCID_RE.search(text or "")
    return "-".join(m.groups()).upper() if m else ""


def orcid_valid(orcid):
    """ORCID iDs end in a check digit (ISO 7064 11,2): a typo almost always breaks it."""
    digits = orcid.replace("-", "")
    if not re.fullmatch(r"\d{15}[\dX]", digits):
        return False
    total = 0
    for ch in digits[:-1]:
        total = (total + int(ch)) * 2
    check = (12 - total % 11) % 11
    return digits[-1] == ("X" if check == 10 else str(check))


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------
TITLES = {"dr", "prof", "professor", "mr", "mrs", "ms", "mx", "miss", "sir", "dame", "assoc", "asst", "associate",
          "assistant"}
DEGREES = {"phd", "md", "mbbs", "ms", "msc", "bsc", "ma", "mph", "dm", "mch", "mds", "bds", "dnb", "frcs", "frcp",
           "facs", "mba", "pharmd", "mpharm", "mtech", "btech", "jr", "sr", "ii", "iii", "facp", "fracs", "mrcp"}
OPTIONAL_PREFIX = {"md", "mohammad", "mohammed", "muhammad", "mohd", "mohamed", "mohamad", "syed", "sk", "sheikh"}


def fold(text):
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def name_tokens(name):
    """'Dr. A.K. Sharma, PhD' -> ['a', 'k', 'sharma']; 'Sharma, Anil' -> ['anil', 'sharma']."""
    name = re.sub(r"\(.*?\)", " ", name or "")
    parts = [p.strip() for p in name.split(",") if p.strip()]
    if len(parts) >= 2:
        rest = [p for p in parts[1:] if fold(p).replace(".", "").replace(" ", "") not in DEGREES]
        if rest and len(parts[0].split()) <= 3:             # "Surname, Given" (not "Name, PhD")
            name = " ".join(rest) + " " + parts[0]
        else:
            name = parts[0]
    tokens = re.findall(r"[a-z]+", fold(name).replace("'", ""))
    while tokens and tokens[0] in TITLES:
        tokens = tokens[1:]
    while len(tokens) > 2 and tokens[-1] in DEGREES:
        tokens = tokens[:-1]
    return tokens


def _score(a, b):
    if not a or not b:
        return 0.0
    if a[-1] != b[-1]:
        return 0.0
    ga, gb = a[:-1], b[:-1]
    if not ga or not gb:
        return 0.6
    fa, fb = ga[0], gb[0]
    if fa == fb:
        s = 1.0 if len(fa) > 1 else 0.85
    elif (len(fa) == 1 and fb.startswith(fa)) or (len(fb) == 1 and fa.startswith(fb)):
        s = 0.85
    elif set(ga) & set(gb) and len(set(ga) & set(gb) - {x for x in ga if len(x) == 1}) > 0:
        s = 0.75
    else:
        return 0.2
    # a middle name written out on both sides that disagrees lowers confidence
    if len(ga) > 1 and len(gb) > 1 and len(ga[1]) > 1 and len(gb[1]) > 1 and ga[1] != gb[1]:
        s -= 0.15
    return s


def name_match(a, b):
    """How well two written names fit the same person, 0 to 1. Handles initials, titles, degrees,
    'Surname, Given', reversed order (Wang Qi / Qi Wang) and optional prefixes such as Md."""
    ta, tb = name_tokens(a), name_tokens(b)
    best = 0.0
    for x in (ta, [t for t in ta if t not in OPTIONAL_PREFIX] or ta):
        for y in (tb, [t for t in tb if t not in OPTIONAL_PREFIX] or tb):
            best = max(best, _score(x, y), _score(x, list(reversed(y))) * 0.95 if len(y) == 2 else 0)
            if "".join(x) == "".join(y) and x:
                best = max(best, 0.95)                      # "Jianhua" vs "Jian Hua"
    return round(best, 2)


# ---------------------------------------------------------------------------
# Subject fit
# ---------------------------------------------------------------------------
STOP = set("""a an the and or of in on for to with by from at as is are was were be been this that these those its
their our we using use used based study studies analysis analyses effect effects role new novel approach
case report review between among into via vs versus patients patient human humans clinical data model models
method methods results evaluation assessment association associated among during after before under over""".split())


def stem(word):
    for end in ("ational", "ations", "ation", "ities", "ings", "ing", "ies", "ers", "ics", "es", "ed", "al", "s"):
        if word.endswith(end) and len(word) - len(end) >= 4:
            return word[: -len(end)]
    return word


def terms(text):
    return {stem(w) for w in re.findall(r"[a-z][a-z0-9-]{2,}", fold(text)) if w not in STOP}


def subject_fit(keywords, title, profile_text):
    """(class, hits, overlap) comparing the manuscript's keywords and title with a researcher's topics and
    recent paper titles."""
    have = terms(profile_text)
    hits = []
    for k in keywords:
        want = terms(k)
        if want and len(want & have) >= max(1, (len(want) + 1) // 2):
            hits.append(k)
    t = terms(title)
    overlap = len(t & have) / len(t) if t else 0.0
    return hits, round(overlap, 2)


# ---------------------------------------------------------------------------
# Database records -> plain summaries
# ---------------------------------------------------------------------------
def short_id(url):
    return (url or "").rstrip("/").rsplit("/", 1)[-1]


def inst_summary(i):
    i = i or {}
    return {"id": short_id(i.get("id")), "ror": i.get("ror") or "", "name": i.get("display_name") or "",
            "country": i.get("country_code") or ""}


def author_summary(a, today):
    a = a or {}
    insts, seen = [], set()
    for i in a.get("last_known_institutions") or []:
        s = inst_summary(i)
        if s["id"] and s["id"] not in seen:
            s["current"] = True
            s["years"] = []
            insts.append(s)
            seen.add(s["id"])
    for aff in a.get("affiliations") or []:
        s = inst_summary(aff.get("institution"))
        years = sorted(aff.get("years") or [])
        if not s["id"]:
            continue
        if s["id"] in seen:
            for x in insts:
                if x["id"] == s["id"]:
                    x["years"] = years
            continue
        s["current"] = bool(years) and years[-1] >= today.year - 2
        s["years"] = years
        insts.append(s)
        seen.add(s["id"])
    topics = []
    for t in (a.get("topics") or [])[:10]:
        topics.append({"name": t.get("display_name") or "",
                       "subfield": (t.get("subfield") or {}).get("display_name") or "",
                       "field": (t.get("field") or {}).get("display_name") or "",
                       "count": t.get("count") or 0})
    years = {c.get("year"): c.get("works_count") or 0 for c in a.get("counts_by_year") or []}
    active = [y for y, n in years.items() if n and y]
    return {
        "id": short_id(a.get("id")), "name": a.get("display_name") or "",
        "alternatives": a.get("display_name_alternatives") or [],
        "orcid": clean_orcid(a.get("orcid") or ""), "works_count": a.get("works_count") or 0,
        "cited_by_count": a.get("cited_by_count") or 0, "institutions": insts, "topics": topics,
        "last_year": max(active) if active else None,
        "recent_works": sum(n for y, n in years.items() if y and y >= today.year - 2),
        "url": f"https://openalex.org/{short_id(a.get('id'))}" if a.get("id") else "",
    }


def work_summary(w):
    w = w or {}
    src = ((w.get("primary_location") or {}).get("source") or {})
    authors = []
    for au in w.get("authorships") or []:
        person = au.get("author") or {}
        authors.append({"id": short_id(person.get("id")), "name": person.get("display_name") or "",
                        "institutions": [short_id(i.get("id")) for i in au.get("institutions") or [] if i.get("id")]})
    return {"id": short_id(w.get("id")), "doi": w.get("doi") or "", "title": w.get("display_name") or w.get("title") or "",
            "year": w.get("publication_year"), "venue": src.get("display_name") or "", "authors": authors,
            "topics": [t.get("display_name") or "" for t in (w.get("topics") or [])[:3]],
            "keywords": [k.get("display_name") or "" for k in (w.get("keywords") or [])[:5]]}


def ror_summary(org):
    org = org or {}
    names = org.get("names") or []
    display = next((n.get("value") for n in names if "ror_display" in (n.get("types") or [])),
                   names[0].get("value") if names else org.get("name", ""))
    website = next((l.get("value") for l in org.get("links") or [] if l.get("type") == "website"), "")
    country = ((org.get("locations") or [{}])[0].get("geonames_details") or {}).get("country_name", "")
    return {"id": org.get("id") or "", "name": display or "", "aliases": [n.get("value") for n in names],
            "domains": [d.lower() for d in org.get("domains") or []], "website": website,
            "web_host": host_of(website) if website else "", "country": country,
            "related": [r.get("id") for r in org.get("relationships") or [] if r.get("id")]}


def mentions(text, org):
    """The affiliation as written names this institution (or one of its other names)."""
    t = fold(text or "")
    for n in [org["name"]] + (org.get("aliases") or []):
        n2 = fold(n or "")
        if len(n2) >= 4 and re.search(r"(?<![a-z])" + re.escape(n2) + r"(?![a-z])", t):
            return True
    words = terms(org["name"])
    return bool(words) and len(words & terms(text or "")) >= max(2, len(words) - 1)


def org_domains(org):
    return [d for d in (org.get("domains") or []) + [org.get("web_host")] if d]


def profile_text(profile, works):
    parts = [t["name"] + " " + t["subfield"] + " " + t["field"] for t in profile.get("topics", [])]
    parts += [w["title"] + " " + " ".join(w["topics"]) + " " + " ".join(w["keywords"]) for w in works[:60]]
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Fetching (the browser, the command line and the tests each supply their own way of fetching)
# ---------------------------------------------------------------------------
class Fetcher:
    """Remembers every answer for the session, keeps to each service's polite pace, retries busy answers.
    Subclasses implement _get(url, headers) -> (status, data or None); status None means unreachable."""
    GAP = {"api.openalex.org": 0.11, "api.ror.org": 0.3, "pub.orcid.org": 0.2}
    RETRY_WAIT = 1.5                   # seconds, times the attempt number, before retrying a busy answer

    def __init__(self, openalex_key="", ror_client_id="", concurrency=4):
        self.openalex_key, self.ror_client_id = openalex_key, ror_client_id
        self.cache, self.calls = {}, []
        self.concurrency = concurrency
        self._sem, self._next = None, {}

    async def get(self, url, headers=None):
        if url in self.cache:
            return self.cache[url]
        if self._sem is None:
            self._sem = asyncio.Semaphore(self.concurrency)
        host = urlparse(url).netloc
        async with self._sem:
            result = (None, None)
            for attempt in range(3):
                wait = self._next.get(host, 0) - _now()
                if wait > 0:
                    await asyncio.sleep(wait)
                self._next[host] = _now() + self.GAP.get(host, 0.2)
                try:
                    result = await self._get(url, headers or {})
                except Exception:                          # noqa: BLE001 - network trouble of any kind
                    result = (None, None)
                self.calls.append(url)
                if result[0] in (429, 500, 502, 503, 504) or result[0] is None:
                    await asyncio.sleep(self.RETRY_WAIT * (attempt + 1))
                    continue
                break
        if result[0] in (200, 404, 400):
            self.cache[url] = result
        return result

    async def _get(self, url, headers):
        raise NotImplementedError

    # URLs
    def openalex(self, path, **params):
        params["mailto"] = CONTACT
        if self.openalex_key:
            params["api_key"] = self.openalex_key
        return f"{OPENALEX}{path}?{urlencode(params, safe=':|,')}"

    def ror_headers(self):
        return {"Client-Id": self.ror_client_id} if self.ror_client_id else {}


def _now():
    import time
    return time.monotonic()


class UrllibFetcher(Fetcher):
    """For the command line (and the live test on GitHub)."""

    async def _get(self, url, headers):
        import urllib.error
        import urllib.request

        def go():
            req = urllib.request.Request(url, headers={"User-Agent": f"TheGreySwan-ResearcherCheck (mailto:{CONTACT})",
                                                       "Accept": "application/json", **headers})
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                return e.code, None
            except (urllib.error.URLError, TimeoutError, ValueError):
                return None, None
        return await asyncio.to_thread(go)


class SavedFetcher(Fetcher):
    """Answers from a saved file, for the tests: {url-without-key: [status, data]}."""
    GAP = {}

    def __init__(self, answers, **kw):
        super().__init__(**kw)
        self.answers = answers

    async def _get(self, url, headers):
        key = canonical(url)
        if key not in self.answers:
            return 404, None
        status, data = self.answers[key]
        return status, data


def canonical(url):
    """The URL with the API key and contact address left out, so saved answers don't depend on them."""
    return re.sub(r"[?&](?:api_key|mailto)=[^&]*", "", url).replace("?&", "?").rstrip("?")


# ---------------------------------------------------------------------------
# Looking people up
# ---------------------------------------------------------------------------
AUTHOR_FIELDS = "id,display_name,display_name_alternatives,orcid,works_count,cited_by_count,last_known_institutions,affiliations,topics,counts_by_year"
WORK_FIELDS = "id,doi,display_name,publication_year,authorships,primary_location,topics,keywords"


async def get_author(fetch, ident):
    status, data = await fetch.get(fetch.openalex(f"/authors/{ident}", select=AUTHOR_FIELDS))
    return ("ok", data) if status == 200 and data else ("missing", None) if status in (404, 400) else ("error", None)


async def get_works(fetch, author_id, since):
    url = fetch.openalex("/works", filter=f"authorships.author.id:{author_id},from_publication_date:{since}-01-01",
                         sort="publication_date:desc", per_page=100, select=WORK_FIELDS)
    status, data = await fetch.get(url)
    if status == 200 and data:
        return "ok", [work_summary(w) for w in data.get("results") or []]
    return ("missing", []) if status in (404, 400) else ("error", [])


async def get_orcid_record(fetch, orcid):
    status, data = await fetch.get(f"{ORCID_API}/{orcid}/record", {"Accept": "application/json"})
    if status != 200 or not data:
        return ("missing" if status == 404 else "error"), None
    person = data.get("person") or {}
    nm = person.get("name") or {}
    given = ((nm.get("given-names") or {}).get("value")) or ""
    family = ((nm.get("family-name") or {}).get("value")) or ""
    employers = []
    groups = (((data.get("activities-summary") or {}).get("employments") or {}).get("affiliation-group")) or []
    for g in groups:
        for s in g.get("summaries") or []:
            e = s.get("employment-summary") or {}
            org = (e.get("organization") or {}).get("name")
            if org:
                employers.append({"name": org, "current": not e.get("end-date")})
    return "ok", {"name": f"{given} {family}".strip(), "employers": employers}


async def ror_affiliation(fetch, text):
    if not (text or "").strip():
        return "none", None
    status, data = await fetch.get(f"{ROR}?{urlencode({'affiliation': text[:300]})}", fetch.ror_headers())
    if status != 200 or not data:
        return "error", None
    items = data.get("items") or []
    chosen = next((i for i in items if i.get("chosen")), None)
    if chosen:
        return "ok", ror_summary(chosen.get("organization"))
    if items and (items[0].get("score") or 0) >= 0.9:
        return "probable", ror_summary(items[0].get("organization"))
    return "none", None


async def ror_by_domain(fetch, domain):
    reg = registrable(domain)
    status, data = await fetch.get(f"{ROR}?{urlencode({'query.advanced': f'domains:{reg}'})}", fetch.ror_headers())
    if status != 200 or not data:
        return "error", None
    items = data.get("items") or []
    for org in items:
        s = ror_summary(org)
        if domain_fits(domain, s["domains"]):
            return "ok", s
    return "none", None


def candidate_score(person, author, aff_org, keywords, title):
    s = name_match(person["name"], author["name"])
    for alt in author.get("alternatives") or []:
        s = max(s, name_match(person["name"], alt))
    inst = 0.0
    if aff_org:
        for i in author["institutions"]:
            if i["ror"] and i["ror"] == aff_org["id"]:
                inst = 1.0 if i.get("current") else 0.7
                break
            if inst < 0.5 and fold(i["name"]) and fold(i["name"]) == fold(aff_org["name"]):
                inst = 0.6
    elif person.get("affiliation"):
        words = terms(person["affiliation"])
        for i in author["institutions"]:
            if words and len(terms(i["name"]) & words) >= max(1, len(terms(i["name"])) - 1):
                inst = 0.6
                break
    topic_text = " ".join(t["name"] + " " + t["subfield"] for t in author["topics"])
    hits, overlap = subject_fit(keywords, title, topic_text)
    field = min(1.0, len(hits) / 2 + overlap)
    activity = 1.0 if author.get("last_year") and author["works_count"] >= 3 else 0.3
    return round(0.45 * s + 0.35 * inst + 0.15 * field + 0.05 * activity, 3), s, inst


async def resolve(fetch, person, ctx, rors):
    """Find the person's researcher profile: from their ORCID iD, the profile the user picked, or a name search
    narrowed by affiliation and subject. Returns a dict with profile, works, candidates and how it matched."""
    out = {"profile": None, "works": [], "candidates": [], "match": "none", "orcid_status": None,
           "orcid_record": None, "errors": [], "via": ""}
    today, keywords, title = ctx["today"], ctx["keywords"], ctx["title"]
    aff_org = rors["aff"].get(person.get("affiliation") or "", (None, None))[1]
    orcid = clean_orcid(person.get("orcid"))

    if orcid and orcid_valid(orcid):
        st, rec = await get_orcid_record(fetch, orcid)
        out["orcid_status"], out["orcid_record"] = st, rec
        st2, a = await get_author(fetch, f"orcid:{orcid}")
        if st2 == "ok":
            out["profile"], out["via"] = author_summary(a, today), "orcid"
        elif st2 == "error":
            out["errors"].append("OpenAlex")
    if person.get("pick") and not (out["profile"] and out["profile"]["id"] == person["pick"]):
        st, a = await get_author(fetch, person["pick"])
        if st == "ok":
            out["profile"], out["via"] = author_summary(a, today), "picked"
        elif st == "error":
            out["errors"].append("OpenAlex")

    # Name search: always, so other people with the same name can be offered
    status, data = await fetch.get(fetch.openalex("/autocomplete/authors", q=search_name(person["name"])))
    if status != 200 or data is None:
        if not out["profile"]:
            out["errors"].append("OpenAlex")
    else:
        found = [r for r in data.get("results") or [] if name_match(person["name"], r.get("display_name", "")) >= 0.7]
        found.sort(key=lambda r: -(r.get("works_count") or 0))
        details = await asyncio.gather(*(get_author(fetch, short_id(r["id"])) for r in found[:6]))
        cands = []
        for r, (st, a) in zip(found[:6], details):
            if st != "ok":
                continue
            au = author_summary(a, today)
            score, ns, inst = candidate_score(person, au, aff_org, keywords, title)
            cands.append({**au, "score": score, "name_score": ns, "inst_score": inst, "hint": r.get("hint") or ""})
        cands.sort(key=lambda c: -c["score"])
        out["candidates"] = cands
        if not out["profile"] and cands:
            top = cands[0]
            second = cands[1]["score"] if len(cands) > 1 else 0
            clear = (top["inst_score"] >= 0.6 and top["score"] - second >= 0.1) or len(cands) == 1 or \
                    top["score"] - second >= 0.25
            out["profile"], out["via"] = top, "search"
            out["match"] = "matched" if clear else "multiple"

    if out["profile"]:
        if out["via"] in ("orcid", "picked"):
            out["match"] = "matched"
        since = today.year - max(ctx["lookback"], 6)
        st, works = await get_works(fetch, out["profile"]["id"], since)
        out["works"] = works
        if st == "error":
            out["errors"].append("OpenAlex")
        if out["match"] == "matched" and out["profile"]["works_count"] < 3 and out["via"] == "search" \
                and not (aff_org and any(i["ror"] == aff_org["id"] for i in out["profile"]["institutions"])):
            out["match"] = "limited"
    elif "OpenAlex" not in out["errors"]:
        out["match"] = "none"
    else:
        out["match"] = "unavailable"
    return out


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------
def finding(check, status, label, detail, source="", url="", limitation=""):
    return {"check": check, "status": status, "label": label, "detail": detail, "source": source, "url": url,
            "limitation": limitation}


def first(name):
    return search_name((name or "").split(",")[0].strip())


def papers(n):
    return f"{n} paper" + ("" if n == 1 else "s")


def check_person(person, info, ctx, rors, people_infos):
    """All findings for one person, the verdict, the author queries and the evidence links."""
    name = person["name"]
    role = person.get("role") or "author"
    f, queries, evidence = [], [], []
    prof = info["profile"]
    trusted = info["match"] == "matched"            # a guess among namesakes isn't used for the other checks
    retrieved = ctx["today"].isoformat()

    # 1. Profile
    others = len([c for c in info["candidates"] if not prof or c["id"] != prof["id"]])
    if info["match"] == "unavailable":
        f.append(finding("Researcher profile", "unavailable", "Couldn't check",
                         "OpenAlex couldn't be reached, so the researcher profile wasn't checked. Try again later.",
                         "OpenAlex"))
    elif not prof:
        f.append(finding("Researcher profile", "check", "No matching profile identified",
                         f"No researcher profile in OpenAlex matches “{name}”. Low digital footprint: early-career "
                         "researchers and those publishing in journals OpenAlex doesn't cover often have none. "
                         "Manual check recommended.", "OpenAlex",
                         limitation="No record doesn't mean the researcher doesn't exist."))
        queries.append(f"Please provide a link to {first(name)}'s publication record or institutional profile page "
                       "(for example, ORCID or Google Scholar).")
    else:
        evidence.append({"label": f"OpenAlex profile: {prof['name']}", "url": prof["url"]})
        inst = next((i["name"] for i in prof["institutions"] if i.get("current")), "")
        where = f" at {inst}" if inst else ""
        if info["match"] == "multiple":
            f.append(finding("Researcher profile", "check", "Multiple possible matches",
                             f"At least {others + 1} researchers in OpenAlex match this name. The closest is "
                             f"{prof['name']}{where} ({prof['works_count']} works). Choose the right profile to run the "
                             "affiliation, subject and conflict checks.", "OpenAlex", prof["url"]))
        elif info["match"] == "limited":
            f.append(finding("Researcher profile", "info", "Limited public information",
                             f"A profile matches ({prof['name']}{where}), but with only {prof['works_count']} "
                             "work(s) and no link to the stated affiliation, so the match is tentative.",
                             "OpenAlex", prof["url"]))
        else:
            how = {"orcid": "found from the ORCID iD", "picked": "chosen by you"}.get(info["via"], "matched by name"
                   + (" and affiliation" if info["candidates"] and info["candidates"][0].get("inst_score", 0) >= 0.6 else ""))
            more = f" ({others} other researcher(s) share the name)" if others and info["via"] == "search" else ""
            f.append(finding("Researcher profile", "ok", "Matching profile found",
                             f"{prof['name']}{where}, {prof['works_count']} works; {how}{more}.", "OpenAlex", prof["url"]))

    # 2. ORCID
    given = (person.get("orcid") or "").strip()
    orcid = clean_orcid(given)
    if given and not orcid_valid(orcid):
        f.append(finding("ORCID iD", "concern", "Not a valid ORCID iD",
                         f"“{given}” isn't a valid ORCID iD (the check digit doesn't match), which usually means a typo.",
                         "ORCID check digit"))
        queries.append(f"Please check the ORCID iD given for {first(name)}: “{given}” is not a valid ORCID iD.")
    elif orcid:
        url = f"https://orcid.org/{orcid}"
        evidence.append({"label": f"ORCID record {orcid}", "url": url})
        rec = info["orcid_record"]
        oa_name = prof["name"] if prof and info["via"] == "orcid" else ""
        holder = (rec or {}).get("name") or oa_name
        if holder:
            score = max(name_match(name, holder), name_match(name, oa_name) if oa_name else 0)
            if score >= 0.7:
                f.append(finding("ORCID iD", "ok", "Belongs to this researcher",
                                 f"The ORCID iD is registered to {holder}.", "ORCID" if rec else "OpenAlex", url))
            else:
                f.append(finding("ORCID iD", "concern", "Belongs to a differently named researcher",
                                 f"The ORCID iD {orcid} is registered to {holder}, not {name}.",
                                 "ORCID" if rec else "OpenAlex", url))
                queries.append(f"Please check the ORCID iD given for {first(name)}: {orcid} belongs to a researcher "
                               f"named {holder}.")
        elif info["orcid_status"] == "missing" and info["via"] != "orcid":
            f.append(finding("ORCID iD", "check", "ORCID iD not found",
                             f"No ORCID record or researcher profile was found for {orcid}.", "ORCID", url))
            queries.append(f"Please check the ORCID iD given for {first(name)} ({orcid}); no record was found.")
        else:
            f.append(finding("ORCID iD", "info", "Couldn't confirm",
                             "The ORCID record couldn't be read (private, or the service didn't answer); "
                             "open the link to check it.", "ORCID", url))
    else:
        f.append(finding("ORCID iD", "info", "Not supplied", "No ORCID iD was given. That isn't a concern by itself.", ""))

    # 3. Email
    email = (person.get("email") or "").strip()
    dom = email_domain(email)
    aff_status, aff_org = rors["aff"].get(person.get("affiliation") or "", ("none", None))
    if aff_org:
        evidence.append({"label": f"ROR: {aff_org['name']}", "url": aff_org["id"]})
    if not email:
        f.append(finding("Email and affiliation", "info", "No email given", "No email address was given to check.", ""))
    elif not dom:
        f.append(finding("Email and affiliation", "check", "Not a valid email address", f"“{email}” isn't a valid email address.", ""))
        queries.append(f"Please check the email address given for {first(name)} (“{email}”).")
    elif dom in WEBMAIL or registrable(dom) in WEBMAIL:
        backed = prof and info["match"] == "matched" and prof["works_count"] >= 5
        f.append(finding("Email and affiliation", "check", "Free email provider",
                         f"{email} is a free webmail address ({dom}), so it can't be tied to an institution. "
                         + ("A real researcher of this name exists, but nothing links them to this address: "
                            "confirm it belongs to them." if backed else "Free addresses are common and not "
                            "suspicious in themselves, but they can't be verified."),
                         "Email domain", limitation="No open database links email addresses to researchers."))
        aff_txt = f" at {aff_org['name']}" if aff_org else (f" at {person['affiliation']}" if person.get("affiliation") else "")
        queries.append(f"Please provide an institutional email address for {first(name)}{aff_txt}, or confirm the "
                       f"address {email} by replying from it.")
    else:
        dom_status, dom_org = rors["domain"].get(registrable(dom), ("none", None))
        stated = aff_org["name"] if aff_org else (person.get("affiliation") or "")
        related = bool(aff_org and dom_org and (dom_org["id"] in aff_org["related"] or aff_org["id"] in dom_org["related"]))
        if aff_org and domain_fits(dom, org_domains(aff_org)):
            f.append(finding("Email and affiliation", "ok", "Consistent",
                             f"{dom} belongs to {aff_org['name']}, the stated affiliation.", "ROR", aff_org["id"]))
        elif dom_org and (not aff_org or dom_org["id"] != aff_org["id"]):
            own = trusted and any(i["ror"] == dom_org["id"] for i in prof["institutions"])
            evidence.append({"label": f"ROR: {dom_org['name']}", "url": dom_org["id"]})
            if related or mentions(person.get("affiliation"), dom_org):
                f.append(finding("Email and affiliation", "ok", "Consistent",
                                 f"{dom} belongs to {dom_org['name']}, which is "
                                 + ("linked to the stated affiliation in ROR." if related else "named in the stated affiliation."),
                                 "ROR", dom_org["id"]))
            elif own and aff_org:
                f.append(finding("Email and affiliation", "check", "Requires clarification",
                                 f"{dom} belongs to {dom_org['name']}, which is in their publication history, but the "
                                 f"stated affiliation is {aff_org['name']}. Researchers often keep a former "
                                 "institution's address.", "ROR", dom_org["id"]))
                queries.append(f"Please confirm {first(name)}'s current affiliation: the email address ({dom}) belongs "
                               f"to {dom_org['name']}, not {aff_org['name']}.")
            elif aff_org:
                f.append(finding("Email and affiliation", "concern", "Domain belongs to another institution",
                                 f"{dom} belongs to {dom_org['name']}, but the stated affiliation is {aff_org['name']}"
                                 + (", and their publication record doesn't link them to it." if trusted else "."),
                                 "ROR", dom_org["id"]))
                queries.append(f"Please confirm {first(name)}'s current affiliation and provide an institutional email "
                               f"address: {dom} belongs to {dom_org['name']}, not {aff_org['name']}.")
            elif stated:
                f.append(finding("Email and affiliation", "check", "Requires clarification",
                                 f"{dom} belongs to {dom_org['name']}; the stated affiliation (“{stated}”) couldn't be "
                                 "matched to a registered institution to compare.", "ROR", dom_org["id"]))
                queries.append(f"Please confirm {first(name)}'s affiliation: the email address ({dom}) belongs to "
                               f"{dom_org['name']}.")
            else:
                f.append(finding("Email and affiliation", "ok", "Institutional address",
                                 f"{dom} belongs to {dom_org['name']} (no affiliation was given to compare).", "ROR", dom_org["id"]))
        elif aff_org and any(lookalike(dom, d) for d in org_domains(aff_org)):
            real = next(d for d in org_domains(aff_org) if lookalike(dom, d))
            f.append(finding("Email and affiliation", "concern", "Look-alike domain",
                             f"{dom} closely resembles, but doesn't match, {real} ({aff_org['name']}).", "ROR", aff_org["id"]))
            queries.append(f"Please check the email address for {first(name)}: {dom} resembles but does not match "
                           f"{real} ({aff_org['name']}).")
        elif aff_org:
            hint = ", ".join(org_domains(aff_org)) or "none listed"
            f.append(finding("Email and affiliation", "check", "Domain not identified",
                             f"{dom} couldn't be linked to {aff_org['name']} (its known domains: {hint}). Hospitals "
                             "and affiliated institutes often use their own domains.", "ROR", aff_org["id"],
                             "ROR's domain records are incomplete."))
            queries.append(f"Please confirm that {email} is an institutional address of {aff_org['name']}.")
        else:
            f.append(finding("Email and affiliation", "check", "Domain not identified",
                             f"Neither {dom} nor the stated affiliation could be matched to a registered research "
                             "institution.", "ROR", limitation="ROR's domain records are incomplete."))
            queries.append(f"Please confirm {first(name)}'s institutional affiliation and email address ({email}).")

    # 4. Affiliation in the public profile
    if trusted and aff_org:
        listed = [i for i in prof["institutions"] if i["ror"] == aff_org["id"]]
        if listed:
            yrs = listed[0].get("years") or []
            when = f" (listed {yrs[0]}–{yrs[-1]})" if len(yrs) > 1 else (f" ({yrs[0]})" if yrs else "")
            f.append(finding("Affiliation in profile", "ok", "Consistent",
                             f"Their publication record lists {aff_org['name']}{when}.", "OpenAlex", prof["url"]))
        else:
            current = [i["name"] for i in prof["institutions"] if i.get("current")][:2]
            if current:
                f.append(finding("Affiliation in profile", "check", "Requires clarification",
                                 f"Their publication record lists {', '.join(current)}, not {aff_org['name']}. They "
                                 "may have moved recently.", "OpenAlex", prof["url"],
                                 "Affiliations in OpenAlex lag behind moves by months."))
                queries.append(f"Please confirm {first(name)}'s affiliation: their published work lists "
                               f"{', '.join(current)}.")

    # 5. Subject fit
    if prof and info["match"] in ("matched", "limited"):
        if not ctx["keywords"] and not ctx["title"]:
            pass
        elif prof["works_count"] < 3 and not prof["topics"]:
            f.append(finding("Subject fit", "info", "Limited available evidence",
                             "Too few publications to judge the research area.", "OpenAlex", prof["url"]))
        else:
            hits, overlap = subject_fit(ctx["keywords"], ctx["title"], profile_text(prof, info["works"]))
            fields = list(dict.fromkeys(t["subfield"] or t["field"] for t in prof["topics"] if t["field"] or t["subfield"]))[:3]
            if len(hits) >= 2 or (len(hits) >= 1 and overlap >= 0.25) or overlap >= 0.4:
                f.append(finding("Subject fit", "ok", "Strong subject overlap",
                                 f"Their work covers {', '.join(hits[:4]) or 'the manuscript title'}.", "OpenAlex", prof["url"]))
            elif hits or overlap >= 0.15:
                f.append(finding("Subject fit", "ok", "Partial subject overlap",
                                 f"Some overlap ({', '.join(hits) or 'title terms'}); main fields: {', '.join(fields) or 'n/a'}.",
                                 "OpenAlex", prof["url"]))
            else:
                f.append(finding("Subject fit", "check", "Potential subject mismatch",
                                 f"Their publications are mainly in {', '.join(fields) or 'other areas'}, with no "
                                 "overlap with the manuscript's keywords or title.", "OpenAlex", prof["url"],
                                 "Researchers do change fields; this is a prompt to look, not a finding."))
                if role == "reviewer":
                    queries.append(f"Please confirm the relevant expertise of suggested reviewer {first(name)}: their "
                                   f"recent publications are mainly in {', '.join(fields) or 'other areas'}.")

    # 6. Publication record
    if prof and info["match"] in ("matched", "limited"):
        last = prof["last_year"]
        y = ctx["today"].year
        if prof["works_count"] == 0:
            label, detail = "No identifiable publication record", "No indexed publications."
        elif prof["works_count"] >= 10 and last and last >= y - 3:
            label, detail = "Established publication record", f"{prof['works_count']} works, most recent {last}."
        elif last and last >= y - 3:
            label, detail = "Emerging or early-career publication record", \
                f"{prof['works_count']} work(s), most recent {last}. Early-career researchers aren't a concern."
        else:
            label, detail = "Limited publication record", \
                f"{prof['works_count']} work(s), most recent {last or 'unknown'}: no recent indexed activity."
        f.append(finding("Publication record", "info" if label != "Established publication record" else "ok",
                         label, detail, "OpenAlex", prof["url"]))

    # 7. Overlap between a suggested reviewer and the authors
    if role == "reviewer":
        f += reviewer_conflicts(person, info, ctx, rors, people_infos, queries, evidence)

    if info["errors"]:
        f.append(finding("Completeness", "unavailable", "Some lookups failed",
                         f"{', '.join(sorted(set(info['errors'])))} didn't answer every request; results may be incomplete.",
                         ", ".join(sorted(set(info["errors"])))))

    status = [x["status"] for x in f]
    verdict = "red" if "concern" in status else "amber" if ("check" in status or "unavailable" in status) else "green"
    for x in f:
        x["retrieved"] = retrieved
    return {"findings": f, "verdict": verdict, "queries": list(dict.fromkeys(queries)), "evidence": evidence}


def current_insts(info, rors, person):
    ids = set()
    prof = info["profile"] if info["match"] == "matched" else None
    if prof:
        ids |= {i["ror"] or i["id"] for i in prof["institutions"] if i.get("current")}
    org = rors["aff"].get(person.get("affiliation") or "", (None, None))[1]
    if org:
        ids.add(org["id"])
    return ids


def inst_names(info, rors, person):
    names = {}
    prof = info["profile"]
    if prof:
        for i in prof["institutions"]:
            names[i["ror"] or i["id"]] = i["name"]
    org = rors["aff"].get(person.get("affiliation") or "", (None, None))[1]
    if org:
        names[org["id"]] = org["name"]
    return names


def reviewer_conflicts(rev, info, ctx, rors, people_infos, queries, evidence):
    out = []
    since = ctx["today"].year - ctx["lookback"]
    authors = [(p, i) for p, i in people_infos if (p.get("role") or "author") == "author"]
    if not authors:
        return [finding("Overlap with the authors", "info", "No authors to compare",
                        "Add the manuscript's authors to look for overlap between them and this reviewer.", "")]
    worst = []
    rp = info["profile"] if info["match"] == "matched" else None
    r_email = (rev.get("email") or "").strip().lower()
    r_dom = email_domain(r_email)
    for a, ai in authors:
        ap = ai["profile"] if ai["match"] == "matched" else None
        a_email = (a.get("email") or "").strip().lower()
        if (r_email and r_email == a_email) or (rp and ap and rp["id"] == ap["id"]):
            out.append(finding("Overlap with the authors", "concern", "Possibly the same person as an author",
                               f"This suggested reviewer appears to be the author {a['name']} "
                               f"({'same email address' if r_email and r_email == a_email else 'same researcher profile'}).",
                               "Submission details" if r_email == a_email else "OpenAlex"))
            queries.append(f"Please replace suggested reviewer {first(rev['name'])}, who appears to be the author "
                           f"{first(a['name'])}.")
            worst.append("concern")
            continue
        shared = []
        if rp and ap:
            seen = set()
            for w in info["works"] + ai["works"]:
                if w["id"] in seen or not w["year"] or w["year"] < since:
                    continue
                ids = {x["id"] for x in w["authors"]}
                if rp["id"] in ids and ap["id"] in ids:
                    shared.append(w)
                    seen.add(w["id"])
        if shared:
            shared.sort(key=lambda w: -(w["year"] or 0))
            ex = shared[0]
            link = ex["doi"] or f"https://openalex.org/{ex['id']}"
            out.append(finding("Overlap with the authors", "concern", "Shared publication found",
                               f"OpenAlex lists {papers(len(shared))} co-authored with {a['name']} since {since}, most "
                               f"recently “{ex['title']}” ({ex['year']}).", "OpenAlex", link))
            evidence.append({"label": f"Shared paper: {ex['title'][:80]}", "url": link})
            queries.append(f"Please confirm whether suggested reviewer {first(rev['name'])} has a competing interest "
                           f"with {first(a['name'])}: they appear together on {papers(len(shared))} since {since}, for "
                           f"example “{ex['title']}” ({ex['year']}).")
            worst.append("concern")
        elif rp and not ap:
            names = {x["name"] for w in info["works"] if (w["year"] or 0) >= since for x in w["authors"]}
            close = next((n for n in names if name_match(a["name"], n) >= 0.85), None)
            if close:
                out.append(finding("Overlap with the authors", "check", "Possible shared publication",
                                   f"A co-author named {close} appears in their papers since {since}; the author "
                                   f"{a['name']} has no profile to confirm it's the same person.", "OpenAlex", rp["url"]))
                worst.append("check")
        r_inst, a_inst = current_insts(info, rors, rev), current_insts(ai, rors, a)
        common = r_inst & a_inst
        if common:
            nm = inst_names(info, rors, rev).get(next(iter(common)), "the same institution")
            out.append(finding("Overlap with the authors", "check", "Same institution listed",
                               f"This reviewer and the author {a['name']} are both listed at {nm}.", "OpenAlex / ROR"))
            queries.append(f"Please note that suggested reviewer {first(rev['name'])} appears to be at the same "
                           f"institution as {first(a['name'])} ({nm}); please confirm there is no competing interest, or suggest another reviewer.")
            worst.append("check")
        a_dom = email_domain(a_email)
        if r_dom and a_dom and r_dom not in WEBMAIL and registrable(r_dom) == registrable(a_dom) and not common:
            out.append(finding("Overlap with the authors", "check", "Shared email domain",
                               f"This reviewer and the author {a['name']} both use {registrable(r_dom)} addresses.",
                               "Email domain"))
            worst.append("check")
    if not worst:
        out.append(finding("Overlap with the authors", "ok", "No overlap found in the sources checked",
                           f"OpenAlex and ROR show no publication with the authors since {since}, no shared current "
                           "institution and no shared email domain.", "OpenAlex / ROR",
                           limitation="This doesn't confirm independence: personal, financial or unpublished links, and "
                                      "anything these databases don't hold, can't be seen."))
    return out


# ---------------------------------------------------------------------------
# The whole session
# ---------------------------------------------------------------------------
def context(session):
    ms = session.get("manuscript") or {}
    kws = ms.get("keywords") or []
    if isinstance(kws, str):
        kws = [k.strip() for k in re.split(r"[;,·•|\n]", kws) if k.strip()]
    today = date.fromisoformat(session["today"]) if session.get("today") else date.today()
    return {"keywords": kws[:15], "title": ms.get("title") or "", "abstract": ms.get("abstract") or "",
            "lookback": int(session.get("lookback_years") or 5), "today": today}


async def look_up(session, fetch, progress=None):
    ctx = context(session)
    people = [p for p in session.get("people") or [] if (p.get("name") or "").strip()]
    for i, p in enumerate(people):
        p.setdefault("id", f"p{i + 1}")
    # Institutions: each affiliation and each institutional email domain once
    rors = {"aff": {}, "domain": {}}
    affs = list(dict.fromkeys((p.get("affiliation") or "").strip() for p in people if (p.get("affiliation") or "").strip()))
    doms = list(dict.fromkeys(registrable(email_domain(p.get("email"))) for p in people
                              if email_domain(p.get("email")) and email_domain(p.get("email")) not in WEBMAIL
                              and registrable(email_domain(p.get("email"))) not in WEBMAIL))
    res = await asyncio.gather(*(ror_affiliation(fetch, a) for a in affs), *(ror_by_domain(fetch, d) for d in doms))
    rors["aff"] = dict(zip(affs, res[:len(affs)]))
    rors["domain"] = dict(zip(doms, res[len(affs):]))
    done = 0

    async def one(p):
        nonlocal done
        r = await resolve(fetch, p, ctx, rors)
        done += 1
        if progress:
            progress(done, len(people), p["name"])
        return r
    infos = await asyncio.gather(*(one(p) for p in people))
    return people, list(infos), rors, ctx


async def check(session, fetch, progress=None):
    """Everything for every person: the JSON the page and the reports use."""
    people, infos, rors, ctx = await look_up(session, fetch, progress)
    out = results_from(people, infos, rors, ctx, fetch)
    await add_pulse(out["results"], fetch, ctx["today"])
    return out


async def add_pulse(results, fetch, today):
    """Reviewer Pulse: each person's public reviewing record from ORCID, shown as evidence, never in a verdict.
    The iD is the one given on the manuscript when it's valid, else the one on their matched OpenAlex profile."""
    import pulse
    todo = []
    for r in results:
        given = clean_orcid(r.get("orcid") or "")
        prof = r.get("profile") or {}
        if given and orcid_valid(given):
            todo.append((r["id"], given, r["name"], "ORCID iD given on the manuscript"))
        elif prof.get("orcid") and r.get("match") == "matched":
            todo.append((r["id"], prof["orcid"], r["name"], "ORCID iD on their OpenAlex profile"))
        else:
            r["pulse"] = pulse.empty("no_orcid", "", "", ["No ORCID iD is known for this person, so their public "
                                                          "reviewing record wasn't checked."])
    found = await pulse.pulse_many(fetch, todo, today)
    for r in results:
        if r["id"] in found:
            r["pulse"] = found[r["id"]]


def results_from(people, infos, rors, ctx, fetch):
    """The check's JSON from people already looked up (the Reviewer Finder looks them up itself)."""
    pairs = list(zip(people, infos))
    results = []
    for p, info in pairs:
        r = check_person(p, info, ctx, rors, pairs)
        prof = info["profile"]
        results.append({
            "id": p["id"], "name": p["name"], "role": p.get("role") or "author", "email": p.get("email") or "",
            "affiliation": p.get("affiliation") or "", "orcid": p.get("orcid") or "",
            "match": info["match"], "via": info["via"],
            "profile": prof and {k: prof[k] for k in ("id", "name", "orcid", "works_count", "cited_by_count",
                                                       "institutions", "topics", "last_year", "url")},
            "candidates": [{k: c[k] for k in ("id", "name", "works_count", "last_year", "url", "orcid", "hint", "score")}
                           | {"institution": next((i["name"] for i in c["institutions"] if i.get("current")), c["hint"]),
                              "fields": list(dict.fromkeys(t["field"] for t in c["topics"] if t["field"]))[:2]}
                           for c in info["candidates"][:6]],
            "recent_works": [{k: w[k] for k in ("title", "year", "venue", "doi")} for w in info["works"][:5]],
            **r,
        })
    counts = {v: sum(1 for r in results if r["verdict"] == v) for v in ("green", "amber", "red")}
    return {"results": results, "counts": counts, "retrieved": ctx["today"].isoformat(),
            "manuscript": {"title": ctx["title"], "keywords": ctx["keywords"]}, "lookback_years": ctx["lookback"],
            "requests": len(fetch.calls)}


async def network(session, seed_id, fetch, limit=25):
    """Further reviewer candidates from a person's co-authors: ranked by subject fit and recent activity, with
    anyone linked to the manuscript's authors marked as conflicted."""
    people, infos, rors, ctx = await look_up(session, fetch)
    pairs = list(zip(people, infos))
    seed = next(((p, i) for p, i in pairs if p["id"] == seed_id), None)
    if not seed or not seed[1]["profile"]:
        return {"seed": seed_id, "candidates": [], "note": "This person has no researcher profile to start from."}
    sp, si = seed
    since = ctx["today"].year - ctx["lookback"]
    session_ids = {i["profile"]["id"] for _, i in pairs if i["profile"]}
    author_pairs = [(p, i) for p, i in pairs if (p.get("role") or "author") == "author"]
    # co-authors of the manuscript's authors: a potential overlap
    conflicted = {}
    for a, ai in author_pairs:
        for w in ai["works"]:
            if (w["year"] or 0) >= since:
                for x in w["authors"]:
                    conflicted.setdefault(x["id"], a["name"])
    author_insts = {}
    for a, ai in author_pairs:
        for iid in current_insts(ai, rors, a):
            author_insts[iid] = a["name"]
    seed_insts = current_insts(si, rors, sp)
    tally = {}
    for w in si["works"]:
        if (w["year"] or 0) < since:
            continue
        for x in w["authors"]:
            if not x["id"] or x["id"] in session_ids:
                continue
            t = tally.setdefault(x["id"], {"id": x["id"], "name": x["name"], "shared": 0, "last": 0, "papers": []})
            t["shared"] += 1
            t["last"] = max(t["last"], w["year"] or 0)
            if len(t["papers"]) < 2:
                t["papers"].append({"title": w["title"], "year": w["year"], "doi": w["doi"]})
    pool = sorted(tally.values(), key=lambda t: (-t["shared"], -t["last"]))[:60]
    if not pool:
        return {"seed": seed_id, "candidates": [], "note": f"No co-authors found in their papers since {since}."}
    details = {}
    for chunk in (pool[:50], pool[50:]):
        if not chunk:
            continue
        url = fetch.openalex("/authors", filter="id:" + "|".join(t["id"] for t in chunk), per_page=100, select=AUTHOR_FIELDS)
        status, data = await fetch.get(url)
        if status == 200 and data:
            for a in data.get("results") or []:
                s = author_summary(a, ctx["today"])
                details[s["id"]] = s
    cands = []
    for t in pool:
        a = details.get(t["id"])
        if not a:
            continue
        text = " ".join(x["name"] + " " + x["subfield"] + " " + x["field"] for x in a["topics"])
        hits, overlap = subject_fit(ctx["keywords"], ctx["title"], text)
        flags = []
        if t["id"] in conflicted:
            flags.append({"level": "concern", "text": f"Shared publication with the author {conflicted[t['id']]} (since {since}, OpenAlex)"})
        cur = {i["ror"] or i["id"] for i in a["institutions"] if i.get("current")}
        same_author = next((author_insts[i] for i in cur if i in author_insts), None)
        if same_author:
            flags.append({"level": "concern", "text": f"Same current institution as the author {same_author} (OpenAlex)"})
        if cur & seed_insts:
            flags.append({"level": "check", "text": f"Same institution as {sp['name']}: pick only one of them"})
        if a["recent_works"] == 0:
            flags.append({"level": "check", "text": f"No indexed publications in {ctx['today'].year - 2}–{ctx['today'].year}"})
        if a["works_count"] < 5:
            flags.append({"level": "check", "text": "Early-career: check seniority against the journal's policy"})
        score = 3 * len(hits) + 5 * overlap + min(a["recent_works"], 10) / 5 + min(t["shared"], 5) / 5 - (3 if a["recent_works"] == 0 else 0)
        inst = next((i for i in a["institutions"] if i.get("current")), None)
        cands.append({"id": a["id"], "name": a["name"], "orcid": a["orcid"], "url": a["url"],
                      "institution": inst["name"] if inst else "", "country": inst["country"] if inst else "",
                      "ror": inst["ror"] if inst else "", "works_count": a["works_count"], "recent_works": a["recent_works"],
                      "last_year": a["last_year"], "fields": list(dict.fromkeys(x["subfield"] for x in a["topics"] if x["subfield"]))[:3],
                      "matches": hits, "shared_with_seed": t["shared"], "papers_with_seed": t["papers"],
                      "score": round(score, 2), "flags": flags,
                      "conflicted": any(fl["level"] == "concern" for fl in flags)})
    cands.sort(key=lambda c: (c["conflicted"], c["recent_works"] == 0, -c["score"]))
    return {"seed": seed_id, "seed_name": sp["name"], "since": since, "candidates": cands[:limit],
            "considered": len(pool), "requests": len(fetch.calls)}


# ---------------------------------------------------------------------------
# Reading people from a manuscript, a title page, a cover letter or a pasted list
# ---------------------------------------------------------------------------
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
INST_WORDS = re.compile(r"\b(?:Department|Dept\.?|Faculty|School|Institute|College|Centre|Center|Division|University|"
                        r"Hospital|Laboratory|Lab|Unit|Clinic|Academy|Foundation|Ministry|Council|Programme|Program|"
                        r"Corporation|Ltd|Inc|GmbH|Universit\w*|Instituto|Universidad|Université|Klinikum|AIIMS|IIT|ICMR|"
                        r"Research Cent\w+|Medical Cent\w+|Graduate School)\b", re.IGNORECASE)
ARTICLE_TYPE = re.compile(r"^(?:original|research|review|case|short|brief|systematic|narrative)\b.{0,30}"
                          r"(?:article|report|paper|communication|review)s?\s*$|^(?:letter|editorial|commentary)\b", re.IGNORECASE)
REVIEWER_HEAD = re.compile(r"\b(?:suggested|potential|recommended|preferred|proposed|possible)\s+(?:peer\s+)?reviewers?\b", re.IGNORECASE)
STOP_HEAD = re.compile(r"\b(?:opposed|excluded|non-?preferred|do not|conflicting)\s+(?:peer\s+)?reviewers?\b|"
                       r"^(?:sincerely|yours|regards|thank you|best wishes|kind regards)\b", re.IGNORECASE)
LABEL = re.compile(r"\b(?:e-?mail|email address|orcid(?: id| iD)?|affiliation|name|role|reviewer|author|"
                   r"corresponding author|correspondence(?: to)?|address for correspondence)\s*[:\-–]\s*", re.IGNORECASE)
TITLE_PREFIX = re.compile(r"^\s*(?:(?:Dr|Prof|Professor|Mr|Mrs|Ms|Mx|Miss)\.?\s+)+")
DEGREE_SUFFIX = re.compile(r"(?:,\s*(?:PhD|MD|MBBS|MSc|MS|MPH|DM|MCh|MDS|BDS|DNB|FRCS|FRCP|MA|BSc|MBA|PharmD)\.?)+\s*$",
                           re.IGNORECASE)


def search_name(name):
    """The name as a search query: no titles, degrees or bracketed notes."""
    n = re.sub(r"\(.*?\)", " ", name or "")
    n = DEGREE_SUFFIX.sub("", TITLE_PREFIX.sub("", n.strip()))
    return " ".join(n.replace("*", " ").split())


ROLE_START = re.compile(r"^(?:(?:associate|assistant|adjunct|visiting|full|senior|junior|emeritus|research|clinical|"
                        r"honorary|principal|postdoctoral|doctoral|phd|graduate|undergraduate|master'?s?)\s+)*"
                        r"(?:professor|lecturer|reader|researcher|scientist|fellow|student|candidate|scholar|director|"
                        r"head|dean|chair|consultant|resident|registrar|physician|surgeon|nurse|associate|instructor)\b"
                        r"(?!\s+(?:research\s+committee|committee|union|council|affairs|association|research\s+cent))",
                        re.IGNORECASE)


def clean_affiliation(text):
    """'1 Associate professor in the Department of X, Y University' -> 'Department of X, Y University'."""
    t = re.sub(r"^\s*(?:affiliations?|institutions?|address)\s*[:\-–]\s*", "", (text or "").strip(), flags=re.IGNORECASE)
    t = re.sub(r"^\s*(?:\[\d+\]|\d+|[a-f](?=[\s.)])|[*†‡§¶])[\s.)\]]*", "", t)
    m = ROLE_START.match(t)
    if m:
        rest = re.sub(r"^(?:\s|,|;|-|–|\b(?:in|at|of|the|with)\b)+", "", t[m.end():], flags=re.IGNORECASE)
        if INST_WORDS.search(rest):
            t = rest
    return t.strip(" ,;.")


def _person(name, email="", affiliation="", orcid="", role="author"):
    return {"name": search_name(" ".join((name or "").split()).strip(" ,;:*")), "email": email, "affiliation": clean_affiliation(affiliation),
            "orcid": orcid, "role": role, "corresponding": False}


def parse_people(text, role="author"):
    """A pasted list: one person per line (or per block, separated by blank lines), in any order:
    'Dr Priya Sharma, priya.sharma@aiims.edu, AIIMS New Delhi, 0000-0002-…, reviewer'. Tabs from a
    spreadsheet work too."""
    text = (text or "").strip()
    if not text:
        return []
    chunks = [c for c in re.split(r"\n\s*\n", text) if c.strip()]
    if len(chunks) == 1 or all(len(c.strip().splitlines()) == 1 for c in chunks):
        chunks = [l for l in text.splitlines() if l.strip()]
    people = []
    for chunk in chunks:
        if re.fullmatch(r"\s*(?:name|full name)\b.*", chunk.splitlines()[0], re.IGNORECASE) and "@" not in chunk:
            continue                                                  # a header row
        r = role
        if re.search(r"\breviewers?\b", chunk, re.IGNORECASE):
            r = "reviewer"
        elif re.search(r"\bauthors?\b", chunk, re.IGNORECASE):
            r = "author"
        email = (EMAIL_RE.search(chunk) or [""])[0]
        orcid = clean_orcid(chunk)
        rest = EMAIL_RE.sub(" ", chunk)
        rest = re.sub(r"(?:https?://)?orcid\.org/", " ", rest, flags=re.IGNORECASE)
        rest = ORCID_RE.sub(" ", rest)
        rest = re.sub(r"\bORCID(?:\s*iD)?\b", " ", rest, flags=re.IGNORECASE)
        rest = re.sub(r"\b(?:suggested\s+)?(?:reviewers?|authors?|corresponding)\b\s*[:\-–]?", " ", rest, flags=re.IGNORECASE)
        rest = LABEL.sub(" | ", rest)
        rest = re.sub(r"^\s*(?:\d+[.)]|[-•*])\s+", "", rest)
        parts = [p.strip(" ,;|()[]") for p in re.split(r"\t|\||;|\n|,", rest)]
        parts = [p for p in parts if p and not re.fullmatch(r"[\W\d]+", p)]
        if not parts:
            continue
        name = parts[0]
        aff = ", ".join(parts[1:])
        if DEGREE_SUFFIX.match("," + aff.split(",")[0]) if aff else False:
            aff = ", ".join(aff.split(",")[1:])
        if len(name.split()) > 6 or INST_WORDS.search(name):
            continue
        people.append(_person(name, email, aff, orcid, r))
    return people


def _names_in(line):
    from step5_anonymisation import NAME, not_person
    found = []
    pat = re.compile(rf"(?:(?:Dr|Prof|Professor)\.?\s+)?({NAME})\s*((?:\[[\d,\s–-]+\]|[\d,]+(?=[\s,;&*†‡§¶#]|$)|[*†‡§¶#])*)")
    for m in pat.finditer(line):
        nm = m.group(1)
        if not_person(nm) or INST_WORDS.search(nm):
            continue
        marks = set(re.findall(r"\d+", m.group(2) or ""))
        found.append({"name": nm, "marks": marks, "star": bool(re.search(r"[*†]", m.group(2) or "")),
                      "span": m.span()})
    return found


def _is_name_line(line):
    if EMAIL_RE.search(line) or len(line) > 400:
        return []
    head = re.split(r"\.\s+(?=[A-Z][a-z]+ (?:of|for)\b|" + INST_WORDS.pattern + ")", line, maxsplit=1)[0]
    names = _names_in(head)
    if not names:
        return []
    covered = sum(e - b for b, e in (n["span"] for n in names))
    bare = re.sub(r"\b(?:and|&)\b|[,;\s\d\[\]*†‡§¶#–-]", "", head)
    letters = re.sub(r"[^A-Za-z]", "", head)
    if covered >= 0.6 * len(head.strip()) or (letters and len(bare) <= covered):
        return names
    return []


def _match_by_email(people, email):
    local = re.sub(r"[^a-z]", " ", fold(email.split("@")[0])).split()
    joined = "".join(local)
    best, score = None, 0
    for p in people:
        toks = name_tokens(p["name"])
        if not toks:
            continue
        sur, giv = toks[-1], toks[:-1]
        s = 0
        if len(sur) >= 3 and sur in joined:
            s = 2 + (1 if giv and joined.startswith(giv[0][:1]) else 0) + (1 if giv and giv[0] in joined else 0)
        elif giv and len(giv[0]) >= 3 and giv[0] in joined:
            s = 1.5
        if s > score:
            best, score = p, s
    return best


from step5_anonymisation import HEADER_JUNK, JOURNAL_NAME                 # noqa: E402
NOT_TITLE_START = re.compile(r"^(?:dear|to:|date|please|we|i|this|thank|enclosed|herewith|kindly|by)\b", re.IGNORECASE)
TITLE_GOES_ON = re.compile(r"(?:[:,–-]|\b(?:of|and|in|for|the|with|to|on|a|an|from|by|versus|vs\.?))$", re.IGNORECASE)


def _title_candidate(line):
    """Could this front-page line be (part of) the title?"""
    from step5_anonymisation import title_score
    line = line.strip()
    if not line or EMAIL_RE.search(line) or ARTICLE_TYPE.search(line) or REVIEWER_HEAD.search(line) \
            or NOT_TITLE_START.match(line) or HEADER_JUNK.search(line):
        return False
    score = title_score(line)
    if JOURNAL_NAME.match(line) and ":" not in line and len(line.split()) <= 10:
        return False
    if score < 3 and (_is_name_line(line) or INST_WORDS.search(line)):
        return False                                           # people, or an affiliation
    return True


def front_title(lines):
    """The title among the front-page lines -> (title, indices of the lines it sits on)."""
    for i, line in enumerate(lines[:15]):
        text = re.sub(r"^title\s*[:\-]\s*", "", line.strip(), flags=re.IGNORECASE)
        if not (15 <= len(text) <= 300) or text.rstrip().endswith(":") and len(text.split()) <= 3:
            continue
        if not _title_candidate(text):
            # "Zeolite Imidazolate Nanocrystals" reads like one person's name; with the authors on the very next line,
            # it is the title
            after = next((l.strip() for l in lines[i + 1:i + 3] if l.strip()), "")
            if not (_is_name_line(text) and not re.search(r"[,;&\d*†‡§¶]|\band\b", text) and len(text.split()) >= 3
                    and _is_name_line(after) and not HEADER_JUNK.search(text) and not ARTICLE_TYPE.search(text)):
                continue
        used = [i]
        # a title broken over lines (a PDF, or a hard line break): keep reading while it plainly goes on
        while len(used) < 4 and used[-1] + 1 < len(lines) and len(text) < 300:
            nxt = lines[used[-1] + 1].strip()
            from step5_anonymisation import title_score
            if not nxt or len(nxt) > 200 or not _title_candidate(nxt) or INST_WORDS.search(nxt) and title_score(nxt) < 3:
                break
            if not (TITLE_GOES_ON.search(text) or (title_score(nxt) >= 3 and not re.search(r"[.!?]$", text) and len(nxt) < 120
                                                   and not _is_name_line(nxt) and nxt[:1].isupper() and len(text) < 90)):
                break
            text += ("" if text.endswith("-") and not text.endswith(" -") and nxt[:1].islower() else " ") + nxt
            used.append(used[-1] + 1)
        text = re.split(r"\s+(?:Journal|Manuscript ID|Manuscript Type|Article Type|Submission Type|Keywords|"
                        r"Running (?:head|title)|Date Submitted)\b\s*:?", text, maxsplit=1)[0].strip(" .:")
        return text, used
    return "", []


def parse_title_page(lines):
    """Authors (with affiliations, emails and ORCID iDs) from title-page lines."""
    _, title_at = front_title(lines)
    cut = next((i for i, l in enumerate(lines) if REVIEWER_HEAD.search(l) or STOP_HEAD.search(l)
                and re.search(r"reviewer", l, re.IGNORECASE)), None)
    if cut is not None:
        lines = lines[:cut]
    people, affs, default_aff = [], {}, ""
    star_people = []
    name_line_seen = False
    for i, line in enumerate(lines[:40]):
        line = line.strip()
        if not line:
            continue
        if i in title_at or HEADER_JUNK.search(line):
            continue
        names = [] if (i == 0 and not title_at and not name_line_seen and len(_names_in(line)) < 2) else _is_name_line(line)
        if names and not name_line_seen or (names and len(names) >= 2):
            name_line_seen = True
            for n in names:
                p = _person(n["name"])
                p["_marks"], p["_star"] = n["marks"], n["star"]
                people.append(p)
                if n["star"]:
                    star_people.append(p)
            tail = re.split(r"\.\s+(?=[A-Z])", line, maxsplit=1)
            if len(tail) == 2 and INST_WORDS.search(tail[1]):
                default_aff = clean_affiliation(tail[1])
            continue
        m = re.match(r"^\s*(?:\[(\d+)\]|(\d+)(?=[\s.)\]A-Z])|([a-f])(?=[\s.)\]])|([*†‡§¶]))[\s.)\]]*(.+)$", line)
        if m and INST_WORDS.search(m.group(5)) and not EMAIL_RE.search(m.group(5)):
            key = m.group(1) or m.group(2) or m.group(3) or m.group(4)
            affs[key] = clean_affiliation(m.group(5))
            continue
        if name_line_seen and INST_WORDS.search(line) and not EMAIL_RE.search(line) and not default_aff \
                and not re.search(r"correspond", line, re.IGNORECASE) and len(line) < 300:
            default_aff = clean_affiliation(line)
    # Block layout: one person per line, details on the lines below
    block = []
    if len(people) <= 1:
        current = None
        for j, line in enumerate(lines[:40]):
            if j in title_at or (j == 0 and not title_at):
                continue
            line = line.strip()
            only = _names_in(line)
            if only and not EMAIL_RE.search(line) and not INST_WORDS.search(line) and len(line) < 70 \
                    and only[0]["span"][1] - only[0]["span"][0] >= 0.6 * len(line):
                current = _person(only[0]["name"])
                current["_marks"], current["_star"] = only[0]["marks"], only[0]["star"]
                block.append(current)
                continue
            if current:
                if EMAIL_RE.search(line) and not current["email"]:
                    current["email"] = EMAIL_RE.search(line).group(0)
                if clean_orcid(line) and not current["orcid"]:
                    current["orcid"] = clean_orcid(line)
                if INST_WORDS.search(line) and not current["affiliation"] and not EMAIL_RE.search(line):
                    current["affiliation"] = clean_affiliation(re.sub(r"^(?:affiliation\s*[:\-]\s*)", "", line, flags=re.IGNORECASE))
        if len(block) > len(people):
            people = block
    for p in people:
        marks = sorted(p.get("_marks") or [], key=lambda x: int(x) if x.isdigit() else 0)
        if not p["affiliation"]:
            found = [affs[k] for k in marks if k in affs]
            p["affiliation"] = found[0] if found else (default_aff or (next(iter(affs.values())) if len(affs) == 1 else ""))
    # Emails and ORCID iDs anywhere on the page
    unplaced = []
    for line in lines[:60]:
        for email in EMAIL_RE.findall(line):
            if any(p["email"] == email for p in people):
                continue
            here = [p for p in people if not p["email"] and name_tokens(p["name"]) and
                    name_tokens(p["name"])[-1] in fold(line)]
            target = here[0] if len(here) == 1 else _match_by_email([p for p in people if not p["email"]], email)
            if not target and re.search(r"correspond", line, re.IGNORECASE):
                target = next((p for p in star_people if not p["email"]), None)
            if target:
                target["email"] = email
            else:
                unplaced.append(email)
        for m in ORCID_RE.finditer(line):
            orcid = "-".join(m.groups()).upper()
            if any(p["orcid"] == orcid for p in people):
                continue
            before = line[:m.start()]
            here = [p for p in people if not p["orcid"] and name_tokens(p["name"]) and name_tokens(p["name"])[-1] in fold(before)]
            if here:
                here[-1]["orcid"] = orcid
            else:
                free = [p for p in people if not p["orcid"]]
                if len(free) == 1:
                    free[0]["orcid"] = orcid
                else:
                    unplaced.append(orcid)
    for p in people:
        p["corresponding"] = bool(p.pop("_star", False))
        p.pop("_marks", None)
    return people, unplaced


KEYWORDS_INLINE = re.compile(r"\b(?:key[\s-]?words?|index terms|key terms)\s*[:\-–—]\s*(.{3,400})", re.IGNORECASE)


def reviewers_in(paragraphs):
    """Suggested reviewers listed in a cover letter or a 'Suggested reviewers' section."""
    out, on = [], False
    for text in paragraphs:
        if STOP_HEAD.search(text):
            if on:
                break
            continue
        if REVIEWER_HEAD.search(text):
            on = True
            after = REVIEWER_HEAD.split(text, maxsplit=1)[-1].lstrip(" :.-–")
            if len(after) > 5:
                out += [p for p in parse_people(after, "reviewer") if p["name"]]
            continue
        if on:
            if len(out) >= 12 or (len(text) > 400 and not EMAIL_RE.search(text)):
                break
            for p in parse_people(text, "reviewer"):
                if p["name"] and len(p["name"].split()) >= 2 and (p["email"] or p["affiliation"]):
                    p["role"] = "reviewer"
                    out.append(p)
    return out


def merge_people(lists):
    merged = []
    for lst in lists:
        for p in lst:
            same = next((m for m in merged if m["role"] == p["role"] and name_match(m["name"], p["name"]) >= 0.85), None)
            if same:
                for k in ("email", "affiliation", "orcid"):
                    if not same.get(k) and p.get(k):
                        same[k] = p[k]
                same["corresponding"] = same.get("corresponding") or p.get("corresponding", False)
            else:
                merged.append(dict(p))
    for i, p in enumerate(merged):
        p["id"] = f"p{i + 1}"
    return merged


def extract(files):
    """files: [(path, original name)] -> {title, abstract, keywords, people, unplaced}"""
    from step1_split_sections import split_into_sections
    title, abstract, keywords, lists, unplaced = "", "", [], [], []
    for path, name in files:
        try:
            sections, _ = split_into_sections(path, name)
        except Exception as e:                                  # noqa: BLE001
            raise ValueError(f"{name}: {e}") from e
        front = [t for n, paras in sections if n == "Front matter" for t in paras]
        if not title:
            title = front_title(front)[0]
        if not abstract:
            abstract = " ".join(t for n, paras in sections if n == "Abstract" for t in paras)[:2500]
        if not abstract:                                        # "Abstract: …" written as one paragraph, no heading
            for t in front:
                m = re.match(r"^\s*abstract\s*[:.\-–—]?\s+(?=\S)(.{80,})", t, re.IGNORECASE | re.DOTALL)
                if m:
                    abstract = m.group(1).strip()[:2500]
                    break
        if not keywords:
            kw = " ; ".join(t for n, paras in sections if n == "Keywords" for t in paras)
            if not kw.strip():
                # "Keywords: a; b; c" sitting at the end of the abstract's paragraph, or on the front page
                for t in [abstract] + front:
                    m = KEYWORDS_INLINE.search(t)
                    if m:
                        kw = re.split(r"\s(?:\d\.?\s+)?(?:Introduction|Background)\b", m.group(1))[0]
                        if t is abstract:
                            abstract = t[:m.start()].strip()
                        break
            keywords = [k.strip(" .") for k in re.split(r"[;,·•|]", kw) if 1 < len(k.strip(" .")) < 80][:15]
        people, loose = parse_title_page(front)
        lists.append(people)
        unplaced += loose
        lists.append(reviewers_in([t for _, paras in sections for t in paras]))
    return {"title": title, "abstract": abstract, "keywords": keywords, "people": merge_people(lists),
            "unplaced": list(dict.fromkeys(unplaced))}


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------
VERDICT_TEXT = {"green": "No issues found", "amber": "Points to check", "red": "Important points to check"}
STATUS_TEXT = {"ok": "OK", "check": "Check", "concern": "Concern", "info": "Note", "unavailable": "Couldn't check"}


def build_excel(out, path):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    wb = Workbook()
    fills = {"green": "D9EAD3", "amber": "FCE8B2", "red": "F4CCCC", "ok": "D9EAD3", "check": "FCE8B2",
             "concern": "F4CCCC", "info": "EEEEEE", "unavailable": "EEEEEE"}
    ws = wb.active
    ws.title = "Summary"
    ws.append(["Researcher check", out.get("manuscript", {}).get("title", ""), "", "", "", "", ""])
    ws.append([f"Checked {out['retrieved']} against OpenAlex, ROR and ORCID. Flags are prompts to verify, not findings of misconduct."])
    ws.append([])
    ws.append(["Role", "Name", "Email", "Affiliation", "Result", "Profile", "Key points"])
    for r in out["results"]:
        key = "; ".join(f["label"] for f in r["findings"] if f["status"] in ("concern", "check"))
        ws.append([r["role"].title(), r["name"], r["email"], r["affiliation"], VERDICT_TEXT[r["verdict"]],
                   (r["profile"] or {}).get("url", ""), key or "—"])
        ws.cell(ws.max_row, 5).fill = PatternFill("solid", fgColor=fills[r["verdict"]])
    for c in ws[4]:
        c.font = Font(bold=True)
    ws["A1"].font = Font(bold=True, size=14)
    for col, w in zip("ABCDEFG", (10, 26, 30, 36, 22, 34, 60)):
        ws.column_dimensions[col].width = w
    ws2 = wb.create_sheet("Findings")
    ws2.append(["Name", "Role", "Check", "Result", "What was found", "Source", "Link", "Retrieved", "Limitations"])
    for r in out["results"]:
        for f in r["findings"]:
            ws2.append([r["name"], r["role"], f["check"], f"{STATUS_TEXT[f['status']]}: {f['label']}", f["detail"],
                        f["source"], f["url"], f["retrieved"], f["limitation"]])
            ws2.cell(ws2.max_row, 4).fill = PatternFill("solid", fgColor=fills[f["status"]])
    for c in ws2[1]:
        c.font = Font(bold=True)
    for col, w in zip("ABCDEFGHI", (24, 10, 22, 30, 70, 14, 40, 12, 40)):
        ws2.column_dimensions[col].width = w
    for row in ws2.iter_rows(min_row=2):
        for c in row:
            c.alignment = Alignment(wrap_text=True, vertical="top")
    ws3 = wb.create_sheet("Author queries")
    ws3.append(["Name", "Role", "Query"])
    for r in out["results"]:
        for q in r["queries"]:
            ws3.append([r["name"], r["role"], q])
    for c in ws3[1]:
        c.font = Font(bold=True)
    ws3.column_dimensions["A"].width, ws3.column_dimensions["B"].width, ws3.column_dimensions["C"].width = 24, 10, 110
    ws4 = wb.create_sheet("Evidence")
    ws4.append(["Name", "Evidence", "Link"])
    for r in out["results"]:
        for e in r["evidence"]:
            ws4.append([r["name"], e["label"], e["url"]])
    for c in ws4[1]:
        c.font = Font(bold=True)
    ws4.column_dimensions["A"].width, ws4.column_dimensions["B"].width, ws4.column_dimensions["C"].width = 24, 60, 60
    wb.save(path)
    return path


def build_word(out, path):
    from docx import Document
    from docx.shared import Pt, RGBColor
    doc = Document()
    doc.styles["Normal"].font.name = "Calibri"
    doc.styles["Normal"].font.size = Pt(10.5)
    doc.add_heading("Researcher check", 0)
    title = out.get("manuscript", {}).get("title")
    if title:
        doc.add_paragraph(title).runs[0].italic = True
    doc.add_paragraph(f"Checked {out['retrieved']} against OpenAlex, ROR and ORCID. Results: "
                      f"{out['counts']['green']} consistent, {out['counts']['amber']} quick check, "
                      f"{out['counts']['red']} important points to check.")
    note = doc.add_paragraph("Flags are prompts to verify, not findings of misconduct. A consistent result does not "
                             "prove identity or independence; only the journal can confirm who controls an email address.")
    note.runs[0].font.size = Pt(9)
    colours = {"green": RGBColor(0x2E, 0x7D, 0x32), "amber": RGBColor(0xB2, 0x6A, 0x00), "red": RGBColor(0xC6, 0x28, 0x28)}
    all_queries = [(r["name"], q) for r in out["results"] for q in r["queries"]]
    if all_queries:
        doc.add_heading("Queries for the authors", 1)
        for _, q in all_queries:
            doc.add_paragraph(q, style="List Number")
    for r in out["results"]:
        doc.add_heading(f"{r['name']} ({r['role']})", 1)
        p = doc.add_paragraph()
        run = p.add_run(VERDICT_TEXT[r["verdict"]])
        run.bold = True
        run.font.color.rgb = colours[r["verdict"]]
        bits = [x for x in (r["email"], r["affiliation"], r["orcid"]) if x]
        if bits:
            p.add_run("  ·  " + "  ·  ".join(bits))
        t = doc.add_table(rows=1, cols=3)
        t.style = "Light Grid Accent 1"
        for c, h in zip(t.rows[0].cells, ("Check", "Result", "What was found")):
            c.text = h
        for f in r["findings"]:
            row = t.add_row().cells
            row[0].text, row[1].text = f["check"], f"{STATUS_TEXT[f['status']]}: {f['label']}"
            row[2].text = f["detail"] + (f" Source: {f['source']}." if f["source"] else "") + \
                (f" {f['url']}" if f["url"] else "") + (f" Limitation: {f['limitation']}" if f["limitation"] else "")
    doc.save(path)
    return path


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------
def main():
    import os
    if len(sys.argv) < 2:
        print(__doc__)
        return
    session = json.loads(open(sys.argv[1], encoding="utf-8").read())
    fetch = UrllibFetcher(os.environ.get("OPENALEX_API_KEY", ""), os.environ.get("ROR_CLIENT_ID", ""))
    out = asyncio.run(check(session, fetch, lambda d, n, who: print(f"  looked up {who} ({d}/{n})")))
    icons = {"green": "OK ", "amber": "?? ", "red": "!! "}
    for r in out["results"]:
        print(f"\n{icons[r['verdict']]}{r['name']} ({r['role']}): {VERDICT_TEXT[r['verdict']]}")
        for f in r["findings"]:
            print(f"    [{STATUS_TEXT[f['status']]}] {f['check']}: {f['label']}. {f['detail']}")
        for q in r["queries"]:
            print(f"    -> {q}")
    build_excel(out, "cygnus_report.xlsx")
    print("\nSaved cygnus_report.xlsx")
    if "--word" in sys.argv:
        build_word(out, "cygnus_report.docx")
        print("Saved cygnus_report.docx")


if __name__ == "__main__":
    main()
