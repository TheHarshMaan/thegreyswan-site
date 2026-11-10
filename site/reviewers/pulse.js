// The Grey Swan Editorial: Reviewer Pulse view, shared by Check a person and Find reviewers.
// Shows public peer-review records (from ORCID) as evidence: what was found, where it came from, when it was checked,
// and what it doesn't establish. Never a score, never a verdict.
(function () {
  "use strict";
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function when(d) {
    if (!d) return "date not given";
    const [y, m, day] = d.split("-");
    return [day ? +day : "", m ? MONTHS[+m - 1] : "", y].filter(Boolean).join(" ");
  }
  const checked = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const where = (a) => a.journal ? esc(a.journal)
    : a.issn ? `ISSN ${esc(a.issn)}${a.organisation ? ` <span class="muted">(${esc(a.organisation)})</span>` : ""}`
    : esc(a.organisation || "journal not named");
  const KIND = { recent: "verified", historical: "verified", undated: "verified", editorial: "editorial",
                 unclassified: "editorial", none: "none", no_orcid: "none", invalid: "none", not_found: "none", limit: "none",
                 mismatch: "check", rate_limited: "check", unavailable: "check", unreadable: "check" };
  const RETRY = { limit: "Check now", rate_limited: "Try again", unavailable: "Try again" };
  const STEP = {
    retrieval: { ok: "retrieved", no_orcid: "not attempted (no iD)", invalid: "not attempted (invalid iD)", not_found: "no record",
                 rate_limited: "busy, try again", unavailable: "no answer", not_attempted: "not attempted" },
    parsing: { ok: "read", partial: "partly read", failed: "couldn't be read", not_attempted: "not attempted" },
  };
  function steps(p) {
    const r = (p.retrieval || {}).status, pa = p.parsing || {}, j = p.journals || {};
    if (!r || r === "no_orcid" || r === "invalid") return "";
    const bits = [`ORCID record: ${STEP.retrieval[r] || r}`];
    if (pa.status && pa.status !== "not_attempted") bits.push(`review section: ${STEP.parsing[pa.status] || pa.status}${pa.seen != null ? ` (${pa.read} of ${pa.seen} item${pa.seen === 1 ? "" : "s"})` : ""}`);
    if (j.status && j.status !== "not_attempted" && j.status !== "not_needed")
      bits.push(`journal names: ${j.resolved} of ${j.issns} found${j.lookup_ok === false ? " (look-up failed; ISSNs shown)" : ""}`);
    return bits.join(" · ");
  }

  function summaryText(p) {
    const s = p.summary;
    if (!s || !(s.reviews || s.editorial || s.unclassified)) return "";
    const js = s.journals.slice(0, 3).map((j) => `${j.title ? esc(j.title) : j.issn ? `ISSN ${esc(j.issn)}` : esc(j.organisation || "journal not named")} (${j.count})`).join(", ");
    const bits = [];
    if (s.reviews) bits.push(`${s.reviews} public review record${s.reviews === 1 ? "" : "s"}${s.latest_year ? `, latest ${s.latest_year}` : ""}`);
    if (s.editorial) bits.push(`${s.editorial} editorial role${s.editorial === 1 ? "" : "s"}`);
    if (s.unclassified) bits.push(`${s.unclassified} other record${s.unclassified === 1 ? "" : "s"} (role not stated)`);
    return bits.join(" · ") + (js ? ` · ${js}${s.journals.length > 3 ? " …" : ""}` : "");
  }

  function detail(p) {
    const recs = p.records || [];
    const items = recs.map((r) => {
      const a = r.activity, s = r.source;
      const tag = r.evidence_class === "editorial_service" ? `<span class="pulse-tag">editorial: ${esc(a.role)}</span>`
        : r.evidence_class === "unclassified" ? `<span class="pulse-tag">${a.role ? `role: ${esc(a.role)}` : "role not stated"}, not counted as a review</span>` : "";
      return `<li><span class="pulse-when">${esc(when(a.date))}</span>
        <span class="pulse-what">${where(a)} ${tag}
          <span class="muted">· recorded by ${esc(s.asserted_by || "an organisation")} via ORCID${s.copies > 1 ? ` (${s.copies} copies, counted once)` : ""}</span>
          ${a.review_doi ? ` · <a href="https://doi.org/${esc(a.review_doi)}" target="_blank" rel="noopener">review</a>` : ""}</span></li>`;
    }).join("");
    const id = p.identity || {};
    const idText = id.status === "confirmed" ? `Linked by ${esc((id.basis || []).join("; "))}.`
      : id.status === "probable" ? `Linked by ${esc((id.basis || []).join("; ") || "the ORCID iD")} only.` : "";
    return `${items ? `<ol class="pulse-list">${items}</ol>` : ""}
      ${idText ? `<p class="pulse-note">${idText}</p>` : ""}
      ${p.summary && p.summary.window ? `<p class="pulse-note">“Recent” means a dated review in ${p.summary.window[0]}–${p.summary.window[1]} (this calendar year and the two before).</p>` : ""}
      ${(p.limitations || []).map((l) => `<p class="pulse-note">${esc(l)}</p>`).join("")}
      ${steps(p) ? `<p class="pulse-note">${esc(steps(p))}</p>` : ""}
      <p class="pulse-note">${p.sources_checked && p.sources_checked.length ? `Checked: ${esc(p.sources_checked.join(", "))}` : "Nothing was checked"}${p.retrieved_at ? `, ${esc(checked(p.retrieved_at))}` : ""}.
        ${p.orcid ? `<a href="https://orcid.org/${esc(p.orcid)}" target="_blank" rel="noopener">Open the ORCID record</a>` : ""}</p>`;
  }

  // A compact line with the details folded away (Reviewer Finder cards)
  function line(p, opts) {
    if (!p) return "";
    const s = summaryText(p);
    const retry = opts && opts.checkId && RETRY[p.state] && p.orcid
      ? `<button type="button" class="text-button small" data-act="pulse-check" data-id="${esc(opts.checkId)}">${RETRY[p.state]}</button>` : "";
    return `<div class="pulse"><span class="pulse-label">Reviewing record</span>
      <span class="pulse-chip ${KIND[p.state] || "none"}">${esc(p.label)}</span>${retry}
      ${s ? `<span class="pulse-sum">${s}</span>` : ""}
      <details class="pulse-more"><summary>Evidence</summary>${detail(p)}</details></div>`;
  }

  // An open panel (Cygnus person cards)
  function panel(p) {
    if (!p) return "";
    const s = summaryText(p);
    return `<div class="box pulse-box"><h4>Reviewing record (public) <span class="pulse-chip ${KIND[p.state] || "none"}">${esc(p.label)}</span></h4>
      ${s ? `<p class="pulse-sum">${s}</p>` : ""}${detail(p)}
      <p class="pulse-note">Reviewer Pulse shows evidence only: it isn't part of the verdict.</p></div>`;
  }

  window.PulseView = { line, panel, summaryText };
})();
