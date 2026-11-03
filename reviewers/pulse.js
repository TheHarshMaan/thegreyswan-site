// The Grey Swan Editorial: Reviewer Pulse view, shared by Cygnus and the Reviewer Finder.
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
  const KIND = { recent: "verified", historical: "verified", undated: "verified", editorial: "editorial", none: "none",
                 no_orcid: "none", invalid: "none", not_found: "none", mismatch: "check", rate_limited: "check",
                 unavailable: "check", unreadable: "check" };

  function summaryText(p) {
    const s = p.summary;
    if (!s || !(s.reviews || s.editorial)) return "";
    const js = s.journals.slice(0, 3).map((j) => `${j.title ? esc(j.title) : j.issn ? `ISSN ${esc(j.issn)}` : esc(j.organisation || "journal not named")} (${j.count})`).join(", ");
    const bits = [];
    if (s.reviews) bits.push(`${s.reviews} public review record${s.reviews === 1 ? "" : "s"}${s.latest_year ? `, latest ${s.latest_year}` : ""}`);
    if (s.editorial) bits.push(`${s.editorial} editorial role${s.editorial === 1 ? "" : "s"}`);
    return bits.join(" · ") + (js ? ` · ${js}${s.journals.length > 3 ? " …" : ""}` : "");
  }

  function detail(p) {
    const recs = p.records || [];
    const items = recs.map((r) => {
      const a = r.activity, s = r.source;
      const tag = r.evidence_class === "editorial_service" ? `<span class="pulse-tag">editorial: ${esc(a.role || "role")}</span>` : "";
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
      ${(p.limitations || []).map((l) => `<p class="pulse-note">${esc(l)}</p>`).join("")}
      <p class="pulse-note">${p.sources_checked && p.sources_checked.length ? `Checked: ${esc(p.sources_checked.join(", "))}` : "Nothing was checked"}${p.retrieved_at ? `, ${esc(checked(p.retrieved_at))}` : ""}.
        ${p.orcid ? `<a href="https://orcid.org/${esc(p.orcid)}" target="_blank" rel="noopener">Open the ORCID record</a>` : ""}</p>`;
  }

  // A compact line with the details folded away (Reviewer Finder cards)
  function line(p) {
    if (!p) return "";
    const s = summaryText(p);
    return `<div class="pulse"><span class="pulse-label">Reviewing record</span>
      <span class="pulse-chip ${KIND[p.state] || "none"}">${esc(p.label)}</span>
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
