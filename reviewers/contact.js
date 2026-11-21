// The Grey Swan Editorial: reviewer contact details for Find reviewers.
//
// 1. Official profiles: ORCID, OpenAlex, Europe PMC and searches on Google Scholar and PubMed, so an editor can
//    confirm who the person is.
// 2. Their latest public email: the most recent paper in Europe PMC (which carries PubMed's records) where this
//    person's own affiliation lists an email address. The address is shown with the paper it came from, so the
//    editor can open it and see the address printed there before inviting anyone.
//
// Only the researcher's name and ORCID iD are sent (to Europe PMC); nothing about the manuscript.
(function (root) {
  "use strict";

  const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
  const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  const FREE = /@(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mail|gmx|protonmail|proton|yandex|qq|163|126|sina|rediffmail|zoho)\./i;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fold = (t) => String(t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // "Elham Goodarzi" -> { last: "Goodarzi", given: "Elham", initials: "E" }
  function splitName(name) {
    const parts = String(name || "").replace(/\(.*?\)/g, " ").replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
    if (!parts.length) return { last: "", given: "", initials: "" };
    const last = parts[parts.length - 1];
    const given = parts.slice(0, -1).join(" ");
    return { last, given, initials: parts.slice(0, -1).map((p) => p[0].toUpperCase()).join("") };
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------
  function profileLinks(c) {
    const n = splitName(c.name);
    const links = [];
    if (c.orcid) links.push(["ORCID", `https://orcid.org/${c.orcid}`, "Their ORCID record: identity, employment and works"]);
    if (c.url) links.push(["OpenAlex", c.url, "Their research profile in OpenAlex"]);
    if (c.orcid) links.push(["Europe PMC", `https://europepmc.org/authors/${c.orcid}`, "Their papers in Europe PMC, by ORCID iD"]);
    links.push(["Google Scholar", `https://scholar.google.com/citations?view_op=search_authors&mauthors=${encodeURIComponent(`${c.name} ${c.institution || ""}`.trim())}`,
      "Search Google Scholar for their profile (Scholar has no public directory, so check it's the same person)"]);
    if (n.last) links.push(["PubMed", `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(`${n.last} ${n.initials}[Author]`)}`, "Their papers in PubMed, by name"]);
    return links.map(([label, href, title]) => `<a href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(label)}</a>`).join(" · ");
  }

  // -------------------------------------------------------------------------
  // The latest public email
  // -------------------------------------------------------------------------
  function query(c) {
    const n = splitName(c.name);
    if (c.orcid) return `AUTHORID:"${c.orcid}"`;
    return `AUTH:"${n.last} ${n.initials}"`;
  }

  // Is this author entry the person we're looking for?
  function sameAuthor(a, c) {
    const id = a.authorId && String(a.authorId.type || "").toUpperCase() === "ORCID" ? String(a.authorId.value || "") : "";
    if (c.orcid && id) return id.endsWith(c.orcid);
    const n = splitName(c.name);
    if (!n.last || fold(a.lastName) !== fold(n.last)) return false;
    const first = fold(a.firstName || a.initials || "")[0];
    return !n.given || !first || first === fold(n.given)[0];
  }

  // How sure we are the address is theirs: their name appears in it, or it's the only one in their affiliation
  function confidence(email, c, count) {
    const local = fold(email.split("@")[0]).replace(/[^a-z]/g, "");
    const n = splitName(c.name);
    const last = fold(n.last).replace(/[^a-z]/g, ""), given = fold(n.given.split(" ")[0] || "").replace(/[^a-z]/g, "");
    if ((last.length >= 3 && local.includes(last)) || (given.length >= 3 && local.includes(given))) return "name";
    return count === 1 ? "only" : "weak";
  }

  // Pure: the best email in a Europe PMC search answer, or null
  function pickEmail(json, c) {
    const results = (json && json.resultList && json.resultList.result) || [];
    let best = null;
    for (const r of results) {
      const authors = (r.authorList && r.authorList.author) || [];
      for (const a of authors) {
        if (!sameAuthor(a, c)) continue;
        const affs = ((a.authorAffiliationDetailsList || {}).authorAffiliation || []).map((x) => x.affiliation || "");
        const text = affs.join(" ; ");
        const found = [...new Set((text.match(EMAIL) || []).map((e) => e.replace(/[.,;:]+$/, "")))];
        for (const email of found) {
          const conf = confidence(email, c, found.length);
          if (conf === "weak") continue;
          const date = r.firstPublicationDate || r.pubYear || "";
          const cand = {
            email, date, confidence: conf, free: FREE.test(email),
            title: r.title || "", journal: (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || r.journalTitle || "",
            affiliation: affs.find((x) => x.includes(email)) || text,
            url: r.pmid ? `https://europepmc.org/article/MED/${r.pmid}` : r.doi ? `https://doi.org/${r.doi}` : `https://europepmc.org/search?query=${encodeURIComponent(email)}`,
          };
          if (!best || cand.date > best.date || (cand.date === best.date && conf === "name" && best.confidence !== "name")) best = cand;
        }
      }
    }
    return best;
  }

  const cache = new Map();
  async function findEmail(c, fetchImpl) {
    const key = c.orcid || c.name;
    if (cache.has(key)) return cache.get(key);
    const url = `${EPMC}?${new URLSearchParams({ query: query(c), resultType: "core", format: "json", pageSize: "25",
                                                 sort: "P_PDATE_D desc" })}`;
    const job = (async () => {
      const r = await (fetchImpl || fetch)(url);
      if (!r.ok) throw new Error(`Europe PMC answered ${r.status}`);
      return pickEmail(await r.json(), c);
    })();
    cache.set(key, job);
    try { return await job; } catch (e) { cache.delete(key); throw e; }
  }

  // -------------------------------------------------------------------------
  // How it shows on a card
  // -------------------------------------------------------------------------
  function emailHtml(c) {
    const f = c.found_email;
    if (f === undefined) return `<button type="button" class="text-button small" data-act="find-email" data-id="${esc(c.id)}">Find their latest public email</button>`;
    if (f === "busy") return `<span class="muted small">Looking for their latest public email…</span>`;
    if (f === "error") return `<span class="muted small">Europe PMC couldn't be reached.</span> <button type="button" class="text-button small" data-act="find-email" data-id="${esc(c.id)}">Try again</button>`;
    if (!f) return `<span class="muted small">No public email found in their papers in Europe PMC.</span>`;
    const notes = [f.confidence === "name" ? "their name is in the address" : "the only address in their affiliation",
      f.free ? "a personal (free) email" : "an institutional email"];
    return `<span class="email-found"><code class="email">${esc(f.email)}</code>
      <button type="button" class="button ghost small" data-act="copy-email" data-id="${esc(c.id)}">Copy</button>
      <a class="small" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.affiliation)}">Verify: printed in their ${esc(String(f.date).slice(0, 4))} paper</a>
      <span class="muted small">(${esc(notes.join("; "))})</span></span>`;
  }

  const api = { splitName, profileLinks, pickEmail, findEmail, emailHtml, query };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GSContact = api;
})(typeof window !== "undefined" ? window : globalThis);
