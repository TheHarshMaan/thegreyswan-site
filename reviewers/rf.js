// The Grey Swan Editorial: Reviewer Finder (website)
// Python (worker.js + revfind.py) reads the manuscript, searches OpenAlex through the browser, checks independence and
// ranks the candidates; this page collects the manuscript and people, filters and orders the candidates live, and
// keeps the shortlist, invitation notes and the Reviewer Tracker.

// OpenAlex needs an API key for real use (free, openalex.org/settings/api); visitors can add their own in Settings.
const SITE_OPENALEX_KEY = "";
const ROR_CLIENT_ID = "";

const params = new URLSearchParams(location.search);
const workerParams = new URLSearchParams();
if (params.get("pyodide")) workerParams.set("pyodide", params.get("pyodide"));       // for local testing
const worker = new Worker(`worker.js${workerParams.toString() ? "?" + workerParams : ""}`);

// ---------------------------------------------------------------------------
// Talking to the worker
// ---------------------------------------------------------------------------
let nextId = 1, isReady = false;
const pending = new Map();
const readyWaiters = [];
function rpc(fn, ...args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, fn, args });
  });
}
function whenReady() { return isReady ? Promise.resolve() : new Promise((r) => readyWaiters.push(r)); }
worker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "progress") return setStatus(msg.text, "busy");
  if (msg.type === "rf-progress") return setStatus(`${msg.text}… (step ${msg.step} of ${msg.total})`, "busy");
  if (msg.type === "ready") {
    isReady = true;
    readyWaiters.splice(0).forEach((r) => r());
    if (!running) setStatus(hasManuscript() ? "Ready to search." : "Ready. Drop the manuscript or type its title and keywords.", "done");
    updateRun();
    return;
  }
  if (msg.type === "failed") return setStatus(`The finder could not start: ${msg.error}. Try reloading the page.`, "error");
  const job = pending.get(msg.id);
  if (!job) return;
  pending.delete(msg.id);
  msg.ok ? job.resolve(msg.result) : job.reject(new Error(msg.error));
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ACCOUNT = window.GSAccount || null;
const countEvent = (name) => { if (window.GS_EVENT) window.GS_EVENT(name); };
const today = () => new Date().toISOString().slice(0, 10);
function setStatus(text, kind) {
  $("status").className = "status" + (kind === "error" ? " error done" : kind === "done" ? " done" : "");
  $("status-text").textContent = text;
}
function download(name, data, type) {
  countEvent("reviewers-report");
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function store(key, value) { try { value === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (e) { /* off */ } }
function stored(key, fallback = "") { try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; } }
function keys() {
  return JSON.stringify({ openalex: stored("gs-openalex-key").trim() || SITE_OPENALEX_KEY, ror: ROR_CLIENT_ID });
}
const doiUrl = (d) => (d ? (d.startsWith("http") ? d : `https://doi.org/${d}`) : "");
const ROLE_TEXT = { corresponding: "corresponding author", first: "first author", last: "last author", middle: "co-author" };
const SENIORITY = { early: "Early career", mid: "Mid career", senior: "Senior" };
const VERDICT = { green: "Consistent", amber: "Quick check", red: "Verify before proceeding" };
let uid = 0;
const newPid = () => `n${Date.now().toString(36)}${uid++}`;

// ---------------------------------------------------------------------------
// The manuscript and its people
// ---------------------------------------------------------------------------
let people = [];                 // {id, role: author|suggested|excluded, name, email, affiliation, orcid}
let references = [], referenceCount = 0;
let running = false, lastOut = null;
let seeds = [];                  // "more like this" candidates
let shortlist = [];              // {id, role: primary|alternate, logged}

function hasManuscript() { return !!($("ms-title").value.trim() || $("ms-keywords").value.trim() || $("ms-abstract").value.trim()); }
function updateRun() {
  $("run").disabled = !hasManuscript() || running || !isReady;
  $("run").textContent = running ? "Searching…" : lastOut ? "Search again" : "Find reviewers";
}
["ms-title", "ms-keywords", "ms-abstract"].forEach((id) => $(id).addEventListener("input", updateRun));

function renderPeople() {
  $("people-wrap").hidden = !people.length;
  $("people").innerHTML = people.map((p, i) => `<tr class="role-${p.role}">
    <td class="role"><select data-i="${i}" data-k="role" aria-label="Role">
      <option value="author" ${p.role === "author" ? "selected" : ""}>Author</option>
      <option value="suggested" ${p.role === "suggested" ? "selected" : ""}>Suggested by authors</option>
      <option value="excluded" ${p.role === "excluded" ? "selected" : ""}>Exclude</option></select></td>
    <td class="name"><input data-i="${i}" data-k="name" value="${esc(p.name)}" aria-label="Name" placeholder="Full name"></td>
    <td><input data-i="${i}" data-k="email" value="${esc(p.email)}" aria-label="Email" placeholder="Email"></td>
    <td><input data-i="${i}" data-k="affiliation" value="${esc(p.affiliation)}" aria-label="Affiliation" placeholder="Institution"></td>
    <td><input data-i="${i}" data-k="orcid" value="${esc(p.orcid)}" aria-label="ORCID iD" placeholder="0000-0000-0000-0000"></td>
    <td><button type="button" class="x" data-del="${i}" aria-label="Remove ${esc(p.name)}">×</button></td></tr>`).join("");
}
$("people").addEventListener("input", (e) => { const t = e.target; if (t.dataset.k) people[+t.dataset.i][t.dataset.k] = t.value; });
$("people").addEventListener("change", (e) => {
  if (e.target.dataset.k === "role") { people[+e.target.dataset.i].role = e.target.value; renderPeople(); }
});
$("people").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del]");
  if (b) { people.splice(+b.dataset.del, 1); renderPeople(); }
});
$("add-row").addEventListener("click", () => {
  people.push({ id: newPid(), role: people.some((p) => p.role === "author") ? "excluded" : "author", name: "", email: "", affiliation: "", orcid: "" });
  renderPeople();
  $("people").querySelector("tr:last-child td.name input").focus();
});
function addPeople(list, role) {
  for (const p of list) {
    const r = role || p.role;
    const key = (n) => n.toLowerCase().replace(/\W/g, "");
    const same = people.find((q) => q.role === r && key(q.name) === key(p.name));
    if (same) { for (const k of ["email", "affiliation", "orcid"]) if (!same[k] && p[k]) same[k] = p[k]; }
    else people.push({ id: newPid(), role: r, name: p.name, email: p.email || "", affiliation: p.affiliation || "", orcid: p.orcid || "" });
  }
  renderPeople();
}
function setReferences(list, count) {
  const seen = new Set(references.map((r) => r.doi.toLowerCase()));
  for (const r of list) if (!seen.has(r.doi.toLowerCase())) { references.push(r); seen.add(r.doi.toLowerCase()); }
  referenceCount = Math.max(referenceCount, count || 0);
  $("refs-summary").textContent = references.length
    ? `References: ${references.length} with a DOI${referenceCount ? ` (of ${referenceCount})` : ""}. Recent ones lead to more candidates.`
    : referenceCount ? `References: ${referenceCount} found, none with a DOI (optional)` : "References: none yet (optional)";
}

// Files
const READABLE = [".docx", ".pdf", ".odt", ".rtf", ".tex"];
async function useFiles(list) {
  const files = [...list].filter((f) => READABLE.includes((f.name.toLowerCase().match(/\.[a-z0-9]+$/) || [""])[0]));
  if (!files.length) { setStatus("Add a Word, PDF, OpenDocument, RTF or LaTeX file.", "error"); return; }
  setStatus(isReady ? "Reading the file(s)…" : "Your files will be read as soon as the finder has loaded…", "busy");
  await whenReady();
  try {
    const out = JSON.parse(await rpc("rf_extract", await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })))));
    if (!$("ms-title").value && out.title) $("ms-title").value = out.title;
    if (!$("ms-keywords").value && out.keywords.length) $("ms-keywords").value = out.keywords.join(", ");
    if (!$("ms-abstract").value && out.abstract) $("ms-abstract").value = out.abstract;
    addPeople(out.authors, "author");
    addPeople(out.suggested, "suggested");
    setReferences(out.references, out.reference_count);
    const bits = [out.title ? "the title" : "", out.abstract ? "abstract" : "", out.keywords.length ? `${out.keywords.length} keywords` : "",
      out.authors.length ? `${out.authors.length} author(s)` : "", out.suggested.length ? `${out.suggested.length} suggested reviewer(s)` : "",
      out.references.length ? `${out.references.length} reference DOIs` : ""].filter(Boolean);
    setStatus(bits.length ? `Found ${bits.join(", ")}. Check them, then find reviewers.` : "Nothing could be read from that file. Type the title and keywords instead.",
      bits.length ? "done" : "error");
    if (!out.authors.length && bits.length) setStatus(`Found ${bits.join(", ")}, but no authors: add them so anyone linked to them can be set aside.`, "error");
  } catch (err) {
    setStatus(`Couldn't read that file: ${err.message.split("\n").pop()}`, "error");
  }
  updateRun();
}
const drop = $("dropzone");
$("file-input").addEventListener("change", (e) => { useFiles(e.target.files); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); useFiles(e.dataTransfer.files); });

$("paste-add").addEventListener("click", async () => {
  const text = $("paste").value.trim();
  if (!text) return;
  await whenReady();
  const found = JSON.parse(await rpc("ids_parse", text, "author"));
  if (!found.length) { setStatus("No names found in the pasted text.", "error"); return; }
  addPeople(found, $("paste-role").value);
  $("paste").value = "";
  setStatus(`Added ${found.length} ${found.length === 1 ? "person" : "people"}.`, "done");
});
$("refs-add").addEventListener("click", async () => {
  const text = $("refs-text").value.trim();
  if (!text) return;
  await whenReady();
  const out = JSON.parse(await rpc("rf_refs", text));
  setReferences(out.references, out.reference_count);
  $("refs-text").value = "";
  setStatus(out.references.length ? `Read ${out.references.length} reference DOIs.` : "No DOIs found in those references.", out.references.length ? "done" : "error");
});

// Settings
$("oa-key").value = stored("gs-openalex-key");
$("oa-key").addEventListener("change", () => store("gs-openalex-key", $("oa-key").value.trim()));
$("journal-country").value = stored("gs-rf-country");
$("journal-country").addEventListener("change", () => store("gs-rf-country", $("journal-country").value.trim().toUpperCase()));

// The Reviewer Tracker (same browser, or synced through the account)
const TRACKER_KEY = "greyswan-reviewer-tracker-v1";
function trackerData() {
  try { return Object.assign({ reviewers: [], invites: [], lastBackup: null }, JSON.parse(localStorage.getItem(TRACKER_KEY) || "{}")); }
  catch (e) { return { reviewers: [], invites: [], lastBackup: null }; }
}
function saveTracker(data) {
  try { localStorage.setItem(TRACKER_KEY, JSON.stringify(data)); } catch (e) { return false; }
  if (ACCOUNT) ACCOUNT.changed("tracker");
  return true;
}
const newTid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------
function session() {
  const named = (role) => people.filter((p) => p.role === role && p.name.trim())
    .map((p) => ({ name: p.name.trim(), email: p.email.trim(), affiliation: p.affiliation.trim(), orcid: p.orcid.trim() }));
  return {
    lookback_years: +$("lookback").value,
    manuscript: { title: $("ms-title").value.trim(), keywords: $("ms-keywords").value, abstract: $("ms-abstract").value.trim(), references },
    authors: named("author"), suggested: named("suggested"), excluded: named("excluded"),
    tracker: trackerData(),
    options: { recent_years: +$("recent").value, journal_country: $("journal-country").value.trim().toUpperCase(), seeds, limit: 40,
               manuscript_id: stored("gs-rf-ms") },
  };
}

async function run() {
  if (running) return;
  if (!people.some((p) => p.role === "author" && p.name.trim()) &&
      !confirm("No authors have been added, so nobody can be set aside for working with them. Search anyway?")) return;
  countEvent(seeds.length ? "reviewers-more-like-this" : "reviewers-run");
  running = true;
  updateRun();
  setStatus("Searching OpenAlex…", "busy");
  try {
    lastOut = JSON.parse(await rpc("rf_find", JSON.stringify(session()), keys()));
    const ids = new Set(lastOut.candidates.map((c) => c.id));
    shortlist = shortlist.filter((s) => ids.has(s.id));
    for (const s of shortlist) { const c = byId(s.id); if (c && c.tracker && c.tracker.this_manuscript) s.logged = true; }
    renderResults();
    const n = lastOut.candidates.length, m = lastOut.conflicted.length;
    setStatus(n ? `Found ${n} candidates${m ? `; ${m} set aside as not independent` : ""}. Pick your shortlist below.`
      : "No candidates found. Try broader keywords, or papers from the last 8 years in Search settings.", n ? "done" : "error");
    if (!seeds.length) $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(`${err.message.split("\n").pop()}`, "error");
  }
  running = false;
  updateRun();
}
$("run").addEventListener("click", () => { seeds = []; run(); });

// ---------------------------------------------------------------------------
// Filters and order (live, in the page)
// ---------------------------------------------------------------------------
const filters = { sort: "recommended", diversify: true, seniority: new Set(["early", "mid", "senior"]), outlook: "any",
                  hideFlagged: false, contactOnly: false, excludeAuthorCountries: false, excludeCountries: "" };
const OUTLOOK_RANK = { High: 2, Medium: 1, Low: 0 };

function visible() {
  if (!lastOut) return [];
  const bad = new Set(filters.excludeCountries.toUpperCase().split(/[\s,;]+/).filter(Boolean));
  if (filters.excludeAuthorCountries) (lastOut.author_countries || []).forEach((c) => bad.add(c));
  let list = lastOut.candidates.filter((c) => filters.seniority.has(c.seniority)
    && (filters.outlook === "any" || OUTLOOK_RANK[c.outlook] >= OUTLOOK_RANK[filters.outlook])
    && !(filters.hideFlagged && c.flags.length)
    && !(filters.contactOnly && !c.email && !c.contact_paper)
    && !(c.country && bad.has(c.country.toUpperCase())));
  if (filters.sort === "fit") return list.sort((a, b) => b.fit - a.fit);
  if (filters.sort === "outlook") return list.sort((a, b) => b.outlook_points - a.outlook_points || b.score - a.score);
  if (filters.sort === "activity") return list.sort((a, b) => b.recent_works - a.recent_works || b.score - a.score);
  list.sort((a, b) => b.score - a.score);
  return filters.diversify ? diversify(list) : list;
}
function diversify(list) {
  // Best first, but a colleague or co-author of someone already above moves down, and one country can't fill the top
  const left = list.slice(), out = [], inst = new Set(), ids = new Set(), country = {};
  while (left.length) {
    let best = 0, bestV = -Infinity;
    left.forEach((c, i) => {
      let v = c.score;
      if (c.institution_key && inst.has(c.institution_key)) v -= 25;
      if (c.coauthors_in_list.some((x) => ids.has(x))) v -= 15;
      v -= 6 * Math.max(0, (country[c.country || "?"] || 0) - 1);
      if (v > bestV) { bestV = v; best = i; }
    });
    const c = left.splice(best, 1)[0];
    out.push(c);
    ids.add(c.id);
    if (c.institution_key) inst.add(c.institution_key);
    country[c.country || "?"] = (country[c.country || "?"] || 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shortlist and invitations
// ---------------------------------------------------------------------------
const byId = (id) => lastOut && (lastOut.candidates.find((c) => c.id === id) || lastOut.conflicted.find((c) => c.id === id));
const needed = () => +stored("gs-rf-needed", "2");
const alternates = () => +stored("gs-rf-alternates", "2");
window.RF_STATE = () => ({ found: !!lastOut, needed: needed(), primary: shortlist.filter((s) => s.role === "primary").length });
const DEFAULT_NOTE = `Dear {name},

I'm writing to ask whether you would review the manuscript "{manuscript}" for {journal}. Your recent paper, "{paper}" ({year}), is closely related, and your view would be valuable.

If you're able to help, please let me know within a few days. If you can't, I'd be grateful for the name of a colleague who might.

With thanks,
{editor}`;
function noteFor(c) {
  const p = c.papers[0] || {};
  const fill = { name: c.name, manuscript: $("ms-title").value.trim() || "[manuscript title]",
                 journal: stored("gs-rf-journal") || "[journal]", editor: stored("gs-rf-editor") || "[your name]",
                 paper: p.title || "[their paper]", year: p.year || "", topics: c.matches.slice(0, 3).join(", ") || c.fields.join(", "),
                 institution: c.institution || "" };
  return (stored("gs-rf-note") || DEFAULT_NOTE).replace(/\{(\w+)\}/g, (m, k) => (k in fill ? fill[k] : m));
}
function setRole(id, role) {
  const s = shortlist.find((x) => x.id === id);
  if (role === null) shortlist = shortlist.filter((x) => x.id !== id);
  else if (s) s.role = role;
  else { shortlist.push({ id, role, logged: false }); countEvent("reviewers-shortlist"); }
  renderShortlist();
  renderCandidates();
}
function autofill() {
  // Not automatically: anyone with a serious flag, an invitation from you still unanswered, or an email that bounced
  const pick = visible().filter((c) => !c.flags.some((f) => f.level === "concern") && !(c.tracker && (c.tracker.pending_since || c.tracker.dead || c.tracker.this_manuscript))
    && !shortlist.some((s) => s.id === c.id));
  let p = needed() - shortlist.filter((s) => s.role === "primary").length, a = alternates() - shortlist.filter((s) => s.role === "alternate").length;
  // First pass: only people independent of everyone already chosen (no shared institution, no papers together);
  // second pass: anyone left, if the first couldn't fill the places
  const linked = (c) => shortlist.some((s) => {
    const o = byId(s.id);
    return o && ((c.institution_key && c.institution_key === o.institution_key) || c.coauthors_in_list.includes(o.id) || o.coauthors_in_list.includes(c.id));
  });
  for (const strict of [true, false]) {
    for (const c of pick) {
      if (p <= 0 && a <= 0) break;
      if (shortlist.some((s) => s.id === c.id) || (strict && linked(c))) continue;
      if (p > 0) { shortlist.push({ id: c.id, role: "primary", logged: false }); p--; }
      else { shortlist.push({ id: c.id, role: "alternate", logged: false }); a--; }
    }
  }
  countEvent("reviewers-shortlist");
  renderShortlist();
  renderCandidates();
}
function shortlistChecks(list) {
  const out = [];
  const insts = {};
  list.forEach((c) => { if (c.institution_key) (insts[c.institution_key] = insts[c.institution_key] || []).push(c.name); });
  Object.values(insts).filter((n) => n.length > 1).forEach((n) => out.push(`${n.join(" and ")} work at the same institution`));
  list.forEach((c) => c.coauthors_in_list.forEach((x) => {
    const o = list.find((y) => y.id === x);
    if (o && c.name < o.name) out.push(`${c.name} and ${o.name} have published together`);
  }));
  list.filter((c) => c.flags.some((f) => f.level === "concern")).forEach((c) => out.push(`${c.name}: ${c.flags.find((f) => f.level === "concern").text}`));
  list.filter((c) => c.tracker && c.tracker.pending_since).forEach((c) => out.push(`${c.name} hasn't answered your invitation of ${c.tracker.pending_since}`));
  return out;
}
function addToTracker(c, msId, logInvite) {
  const data = trackerData();
  const key = (n) => n.toLowerCase().replace(/\W/g, "");
  let r = (c.tracker && data.reviewers.find((x) => x.id === c.tracker.tracker_id)) || data.reviewers.find((x) => key(x.name) === key(c.name));
  if (!r) {
    r = { id: newTid(), name: c.name, email: c.email || "", affiliation: c.institution, keywords: [...new Set([...c.matches, ...c.fields])].slice(0, 6),
          dead: false, source: "reviewer-finder",
          notes: `Found via Reviewer Finder (${today()})${msId ? ` for ${msId}` : ""}. OpenAlex: ${c.url}` +
                 `${c.orcid ? ` · ORCID: https://orcid.org/${c.orcid}` : ""}${c.contact_paper ? ` · Email in: ${doiUrl(c.contact_paper.doi)}` : ""}.` +
                 `${c.email ? "" : " Email not known yet."}` };
    data.reviewers.push(r);
  }
  if (logInvite) data.invites.push({ id: newTid(), reviewerId: r.id, manuscript: msId || "", invited: today(), outcome: "awaiting", reported: null });
  return saveTracker(data) ? r : null;
}

function renderShortlist() {
  const box = $("shortlist");
  if (!box || !lastOut) return;
  const list = shortlist.map((s) => ({ s, c: byId(s.id) })).filter((x) => x.c);
  const prim = list.filter((x) => x.s.role === "primary"), alt = list.filter((x) => x.s.role === "alternate");
  const checks = shortlistChecks(list.map((x) => x.c));
  const countries = [...new Set(list.map((x) => x.c.country).filter(Boolean))];
  const stages = [...new Set(list.map((x) => SENIORITY[x.c.seniority]))];
  const row = ({ s, c }, i, arr) => `<li class="sl-row" data-id="${esc(c.id)}">
      <span class="sl-name"><b>${esc(c.name)}</b> <span class="muted">${esc([c.institution, c.country].filter(Boolean).join(", "))}</span></span>
      <span class="sl-tags"><span class="chip fit-${c.fit_label.toLowerCase()}">${c.fit_label} fit</span>
        <span class="chip out-${c.outlook.toLowerCase()}">${c.outlook} outlook</span>${s.logged ? '<span class="chip logged">Invitation logged</span>' : ""}</span>
      <span class="sl-btns">
        <button type="button" class="icon" data-act="up" data-id="${esc(c.id)}" aria-label="Move ${esc(c.name)} up" ${i ? "" : "disabled"}>↑</button>
        <button type="button" class="icon" data-act="down" data-id="${esc(c.id)}" aria-label="Move ${esc(c.name)} down" ${i < arr.length - 1 ? "" : "disabled"}>↓</button>
        <button type="button" class="text-button small" data-act="${s.role === "primary" ? "alt" : "short"}" data-id="${esc(c.id)}">${s.role === "primary" ? "Make alternate" : "Make reviewer"}</button>
        <button type="button" class="icon" data-act="remove" data-id="${esc(c.id)}" aria-label="Remove ${esc(c.name)} from the shortlist">×</button></span>
    </li>`;
  box.innerHTML = `<div class="sl-head"><h3>Shortlist</h3>
      <div class="sl-counts">
        <label class="inline">Reviewers needed <select id="sl-needed">${[1, 2, 3, 4, 5].map((n) => `<option ${n === needed() ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="inline">Alternates <select id="sl-alts">${[0, 1, 2, 3, 4, 5].map((n) => `<option ${n === alternates() ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <button type="button" class="button ghost small" data-act="autofill">Fill from the top</button></div></div>
    ${list.length ? "" : `<p class="muted small">Add candidates with <b>Shortlist</b> or <b>Alternate</b>, or fill the shortlist from the top of the list. Alternates are invited, in order, if someone declines.</p>`}
    ${prim.length ? `<p class="sl-label">Reviewers to invite (${prim.length} of ${needed()})</p><ol class="sl-list">${prim.map(row).join("")}</ol>` : ""}
    ${alt.length ? `<p class="sl-label">Alternates, in order</p><ol class="sl-list alt">${alt.map(row).join("")}</ol>` : ""}
    ${list.length ? `<div class="sl-mix"><span>${countries.length} ${countries.length === 1 ? "country" : "countries"}${countries.length ? ` (${esc(countries.join(", "))})` : ""}</span>
        <span>${stages.map(esc).join(", ")}</span>
        <span>${new Set(list.map((x) => x.c.institution_key).filter(Boolean)).size} institutions</span></div>` : ""}
    ${checks.length ? `<ul class="sl-checks">${checks.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : list.length ? '<p class="sl-ok">No shared institutions or co-authorship within the shortlist.</p>' : ""}
    ${list.length ? `<details class="sl-invite" ${prim.length ? "open" : ""}><summary>Invitations</summary>
      <div class="sl-fields">
        <label class="field">Manuscript ID <input id="sl-ms" value="${esc(stored("gs-rf-ms"))}" placeholder="e.g. JOU-26-0142"></label>
        <label class="field">Journal <input id="sl-journal" value="${esc(stored("gs-rf-journal"))}" placeholder="Journal name"></label>
        <label class="field">Your name <input id="sl-editor" value="${esc(stored("gs-rf-editor"))}" placeholder="Signed as"></label></div>
      <details class="paste"><summary>Edit the invitation note</summary>
        <textarea id="sl-note" rows="9">${esc(stored("gs-rf-note") || DEFAULT_NOTE)}</textarea>
        <p class="muted small">{name}, {manuscript}, {journal}, {editor}, {paper}, {year}, {topics} and {institution} are filled in for each
          person. A short personal line about why you chose them helps more people say yes.
          <button type="button" class="text-button small" data-act="reset-note">Reset</button></p></details>
      ${list.map(({ s, c }) => `<div class="note-card" data-id="${esc(c.id)}">
          <div class="note-head"><b>${esc(c.name)}</b>${s.role === "alternate" ? ' <span class="muted">(alternate)</span>' : ""}
            <span class="contact">${contactLinks(c)}</span></div>
          <pre class="note">${esc(noteFor(c))}</pre>
          <div class="row-actions">
            <button type="button" class="button ghost small" data-act="copy-note" data-id="${esc(c.id)}">Copy note</button>
            ${c.email ? `<a class="button ghost small" href="mailto:${esc(c.email)}?subject=${encodeURIComponent(`Invitation to review: ${$("ms-title").value.trim()}`)}&body=${encodeURIComponent(noteFor(c))}" data-act="mail" data-id="${esc(c.id)}">Email</a>` : ""}
            <button type="button" class="button small" data-act="log" data-id="${esc(c.id)}" ${s.logged ? "disabled" : ""}>${s.logged ? "Logged in tracker" : "Log invitation in tracker"}</button>
          </div></div>`).join("")}
    </details>` : ""}`;
}
function contactLinks(c) {
  const bits = [];
  if (c.email) bits.push(`<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`);
  if (c.contact_paper) bits.push(`<a href="${esc(doiUrl(c.contact_paper.doi))}" target="_blank" rel="noopener" title="${esc(c.contact_paper.title)}">email in their ${esc(c.contact_paper.year)} paper</a>`);
  if (c.orcid) bits.push(`<a href="https://orcid.org/${esc(c.orcid)}" target="_blank" rel="noopener">ORCID</a>`);
  bits.push(`<a href="https://www.google.com/search?q=${encodeURIComponent(`"${c.name}" ${c.institution} email`)}" target="_blank" rel="noopener">search the web</a>`);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function candCard(c, n) {
  const s = shortlist.find((x) => x.id === c.id);
  const paper = (p) => `<li>${p.doi ? `<a href="${esc(doiUrl(p.doi))}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}
      <span class="muted">${esc(p.year)}${p.venue ? `, ${esc(p.venue)}` : ""} · ${esc(ROLE_TEXT[p.role] || "author")}</span></li>`;
  return `<article class="cand${s ? " in-list" : ""}" data-id="${esc(c.id)}">
    <div class="c-head">
      <span class="c-rank">${n}</span>
      <div class="c-who">
        <a class="c-name" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>
        <span class="c-inst">${esc([c.institution || "Institution not known", c.country].filter(Boolean).join(" · "))}</span>
        <span class="c-meta">${esc(SENIORITY[c.seniority])} · ${c.recent_works} paper${c.recent_works === 1 ? "" : "s"} in the last 3 years · h-index ${c.h_index}${c.tracker ? " · in your tracker" : ""}${c.tracker && c.tracker.this_manuscript ? ` · <b class="invited">already invited for this manuscript (${esc(c.tracker.this_manuscript === "awaiting" ? "awaiting reply" : c.tracker.this_manuscript)})</b>` : ""}</span>
      </div>
      <div class="c-chips">
        <span class="chip fit-${c.fit_label.toLowerCase()}" title="How closely their recent work matches the manuscript">${c.fit_label} fit</span>
        <span class="chip out-${c.outlook.toLowerCase()}" title="How likely they are to accept">${c.outlook} outlook</span>
      </div>
    </div>
    <div class="c-body">
      <div class="c-why">
        ${c.matches.length ? `<div class="tags">${c.matches.map((m) => `<span class="hit">${esc(m)}</span>`).join("")}${c.fields.map((f) => `<span>${esc(f)}</span>`).join("")}</div>`
          : c.fields.length ? `<div class="tags">${c.fields.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
        ${c.papers.length ? `<ul class="papers">${c.papers.slice(0, 2).map(paper).join("")}</ul>` : ""}
        <p class="src">${esc(c.sources.join(" · "))}${c.notes.length ? ` · ${esc(c.notes.join(" · "))}` : ""}</p>
      </div>
      <ul class="c-outlook">${c.outlook_why.map(([sign, t]) => `<li class="${sign === "+" ? "up" : "down"}"><span aria-hidden="true">${sign === "+" ? "▲" : "▼"}</span> ${esc(t)}</li>`).join("")}</ul>
    </div>
    ${c.flags.length || c.pair_notes.length ? `<div class="c-flags">${c.flags.map((f) => `<span class="flag ${f.level}">${esc(f.text)}</span>`).join("")}${c.pair_notes.map((t) => `<span class="flag pair">${esc(t)}</span>`).join("")}</div>` : ""}
    ${c.pulse && window.PulseView ? `<div class="c-pulse">${PulseView.line(c.pulse)}</div>` : ""}
    <div class="c-foot">
      <span class="contact">${contactLinks(c)}</span>
      <span class="c-actions">
        <button type="button" class="button small ${s && s.role === "primary" ? "on" : ""}" data-act="${s && s.role === "primary" ? "remove" : "short"}" data-id="${esc(c.id)}" aria-pressed="${!!(s && s.role === "primary")}">${s && s.role === "primary" ? "✓ Shortlisted" : "Shortlist"}</button>
        <button type="button" class="button ghost small ${s && s.role === "alternate" ? "on" : ""}" data-act="${s && s.role === "alternate" ? "remove" : "alt"}" data-id="${esc(c.id)}" aria-pressed="${!!(s && s.role === "alternate")}">${s && s.role === "alternate" ? "✓ Alternate" : "Alternate"}</button>
        <button type="button" class="text-button small" data-act="more" data-id="${esc(c.id)}" title="Add this person's co-authors to the search">More like this</button>
        ${c.tracker ? "" : `<button type="button" class="text-button small" data-act="track" data-id="${esc(c.id)}">Add to tracker</button>`}
      </span>
    </div>
  </article>`;
}

function renderCandidates() {
  const box = $("candidates");
  if (!box) return;
  const list = visible();
  const hidden = lastOut.candidates.length - list.length;
  box.innerHTML = list.length ? list.map((c, i) => candCard(c, i + 1)).join("")
    : `<p class="muted">No candidates match these filters.</p>`;
  $("cand-count").textContent = `${list.length} candidate${list.length === 1 ? "" : "s"}${hidden ? ` (${hidden} hidden by filters)` : ""}`;
  if (window.GS_SCROLL_REFRESH) window.GS_SCROLL_REFRESH();
}

function renderResults() {
  const out = lastOut;
  const m = out.method;
  const authorsNote = out.authors.length ? out.authors.map((a) => a.profile
      ? `<a href="${esc(a.profile.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>${a.match === "matched" ? "" : " (not confirmed)"}`
      : `${esc(a.name)} (no profile found)`).join(", ") : "none added";
  const sug = out.suggested || [];
  $("results").innerHTML = `
    <div class="results-head"><h2>Reviewers</h2><div class="downloads">
      <button type="button" class="button ghost" id="dl-xlsx">Excel report</button>
      <button type="button" class="button ghost" id="dl-docx">Word report</button></div></div>
    <p class="muted small">Searched ${esc(out.retrieved)} · papers since ${m.since} · independence checked against the authors' papers since ${m.independence_since}
      · authors: ${authorsNote}</p>
    ${out.warnings.length ? `<div class="warnings">${out.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div>` : ""}
    <div class="counts">
      <span class="count"><b>${out.candidates.length}</b>candidates</span>
      <span class="count v-red"><b>${out.conflicted.length}</b>set aside</span>
      <span class="count"><b>${out.candidates.filter((c) => c.tracker).length}</b>in your tracker</span>
      <span class="count"><b>${out.candidates.filter((c) => c.outlook === "High").length}</b>high outlook</span>
      ${sug.length ? `<span class="count ${sug.some((r) => r.verdict === "red") ? "v-red" : ""}"><b>${sug.length}</b>suggested by authors</span>` : ""}
    </div>
    <section id="shortlist" class="shortlist" aria-label="Shortlist"></section>
    <div class="filters" role="group" aria-label="Filter and order the candidates">
      <label class="inline">Order <select id="f-sort">
        <option value="recommended">Recommended</option><option value="fit">Best fit</option>
        <option value="outlook">Most likely to accept</option><option value="activity">Most active</option></select></label>
      <label class="inline" title="Colleagues and co-authors of people above move down, and one country can't fill the top">
        <input type="checkbox" id="f-div" ${filters.diversify ? "checked" : ""}> Keep the list diverse</label>
      <span class="inline">Career stage ${["early", "mid", "senior"].map((k) => `<label><input type="checkbox" data-sen="${k}" ${filters.seniority.has(k) ? "checked" : ""}> ${SENIORITY[k].replace(" career", "")}</label>`).join("")}</span>
      <label class="inline">Outlook <select id="f-out"><option value="any">Any</option><option value="Medium">Medium or high</option><option value="High">High</option></select></label>
      <label class="inline"><input type="checkbox" id="f-flag" ${filters.hideFlagged ? "checked" : ""}> Hide flagged</label>
      <label class="inline"><input type="checkbox" id="f-contact" ${filters.contactOnly ? "checked" : ""}> Has an email or contact paper</label>
      <label class="inline"><input type="checkbox" id="f-authc" ${filters.excludeAuthorCountries ? "checked" : ""}> Not in the authors' countries${out.author_countries.length ? ` (${esc(out.author_countries.join(", "))})` : ""}</label>
      <label class="inline">Leave out countries <input id="f-countries" value="${esc(filters.excludeCountries)}" placeholder="e.g. US, CN" size="9"></label>
    </div>
    <p class="muted small" id="cand-count"></p>
    <div id="candidates" class="cands"></div>
    ${out.tracker_extra.length ? `<details class="box"><summary><h4>From your tracker, without a research profile (${out.tracker_extra.length})</h4></summary>
      <p class="muted small">Their keywords fit, but OpenAlex has no profile to check them against: confirm independence yourself.</p>
      <ul>${out.tracker_extra.map((t) => `<li><b>${esc(t.name)}</b> <span class="muted">${esc([t.affiliation, t.keywords.slice(0, 4).join(", ")].filter(Boolean).join(" · "))}</span>
        ${t.email ? ` · <a href="mailto:${esc(t.email)}">${esc(t.email)}</a>` : ""}${t.invited ? ` · accepted ${t.accepted} of ${t.invited}` : ""}
        ${t.warnings.map((w) => `<span class="flag check">${esc(w)}</span>`).join("")}</li>`).join("")}</ul></details>` : ""}
    ${sug.length ? `<details class="box" ${sug.some((r) => r.verdict !== "green") ? "open" : ""}><summary><h4>Reviewers suggested by the authors (${sug.length}), checked by Cygnus</h4></summary>
      <ul class="sug">${sug.map((r) => `<li><span class="pill v-${r.verdict}">${VERDICT[r.verdict]}</span> <b>${esc(r.name)}</b>
        <span class="muted">${esc([r.email, r.affiliation].filter(Boolean).join(" · "))}</span>
        ${r.findings.filter((f) => f.status === "concern" || f.status === "check").slice(0, 3).map((f) => `<span class="flag ${f.status}">${esc(f.check)}: ${esc(f.label)}. ${esc(f.detail)}</span>`).join("")}</li>`).join("")}</ul>
      <p class="muted small">Open <a href="../researchers/">Cygnus</a> for the full evidence and the queries for the authors.</p></details>` : ""}
    ${out.conflicted.length ? `<details class="box"><summary><h4>Set aside: not independent of the authors (${out.conflicted.length})</h4></summary>
      <ul class="aside">${out.conflicted.map((c) => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener"><b>${esc(c.name)}</b></a>
        <span class="muted">${esc([c.institution, c.country].filter(Boolean).join(", "))} · ${c.fit_label} fit</span>
        ${c.conflicts.map((r) => `<span class="flag concern">${esc(r.text)}${r.paper ? `: ${r.doi ? `<a href="${esc(doiUrl(r.doi))}" target="_blank" rel="noopener">${esc(r.paper)}</a>` : esc(r.paper)}` : ""}</span>`).join("")}</li>`).join("")}</ul></details>` : ""}
    <details class="box"><summary><h4>How these were found</h4></summary>
      <ul class="method">
        <li>Searches: ${m.queries.map((q) => `<code>${esc(q)}</code>`).join(" ")}</li>
        <li>Research topics: ${esc(m.topics.join(", ") || "none")}</li>
        <li>References with a DOI: ${m.references_with_doi} (${m.references_found} found in OpenAlex)</li>
        <li>${m.considered} researchers considered, ${m.profiles} profiles read${m.low_fit ? `, ${m.low_fit} left out because their work doesn't match` : ""}${m.seeds.length ? `, networks of ${m.seeds.length} reviewer(s) explored` : ""}</li>
        <li>Ranking: fit 60% (how closely their recent work matches the manuscript), outlook 25% (your tracker history first, then career stage, recent activity and open invitations), activity 15% (papers in the last 3 years). Anyone linked to the authors is set aside, not ranked.</li>
        <li>${out.requests} database requests.</li></ul></details>`;
  $("f-sort").value = filters.sort;
  $("f-out").value = filters.outlook;
  renderShortlist();
  renderCandidates();
}

// Filters
$("results").addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "f-sort") filters.sort = t.value;
  else if (t.id === "f-div") filters.diversify = t.checked;
  else if (t.dataset.sen) t.checked ? filters.seniority.add(t.dataset.sen) : filters.seniority.delete(t.dataset.sen);
  else if (t.id === "f-out") filters.outlook = t.value;
  else if (t.id === "f-flag") filters.hideFlagged = t.checked;
  else if (t.id === "f-contact") filters.contactOnly = t.checked;
  else if (t.id === "f-authc") filters.excludeAuthorCountries = t.checked;
  else if (t.id === "f-countries") filters.excludeCountries = t.value;
  else if (t.id === "sl-needed") { store("gs-rf-needed", t.value); return renderShortlist(); }
  else if (t.id === "sl-alts") { store("gs-rf-alternates", t.value); return renderShortlist(); }
  else if (t.id === "sl-ms" || t.id === "sl-journal" || t.id === "sl-editor") {
    store({ "sl-ms": "gs-rf-ms", "sl-journal": "gs-rf-journal", "sl-editor": "gs-rf-editor" }[t.id], t.value.trim());
    return refreshNotes();
  } else if (t.id === "sl-note") { store("gs-rf-note", t.value); return refreshNotes(); }
  else return;
  renderCandidates();
});
$("results").addEventListener("input", (e) => {
  if (e.target.id === "f-countries") { filters.excludeCountries = e.target.value; renderCandidates(); }
});
function refreshNotes() {
  document.querySelectorAll(".note-card").forEach((card) => {
    const c = byId(card.dataset.id);
    if (!c) return;
    card.querySelector(".note").textContent = noteFor(c);
    const mail = card.querySelector('[data-act="mail"]');
    if (mail) mail.href = `mailto:${c.email}?subject=${encodeURIComponent(`Invitation to review: ${$("ms-title").value.trim()}`)}&body=${encodeURIComponent(noteFor(c))}`;
  });
}

// Buttons
$("results").addEventListener("click", async (e) => {
  const t = e.target.closest("button, a[data-act]");
  if (!t) return;
  if (t.id === "dl-xlsx" || t.id === "dl-docx") {
    const files = await rpc("rf_report", JSON.stringify({ ...lastOut, shortlist }));
    t.id === "dl-xlsx" ? download("reviewer_finder.xlsx", files.report, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      : download("reviewer_finder.docx", files.word, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return;
  }
  const act = t.dataset.act, id = t.dataset.id;
  if (!act) return;
  const c = id && byId(id);
  if (act === "short") return setRole(id, "primary");
  if (act === "alt") return setRole(id, "alternate");
  if (act === "remove") return setRole(id, null);
  if (act === "autofill") return autofill();
  if (act === "up" || act === "down") {
    const i = shortlist.findIndex((x) => x.id === id);
    const role = shortlist[i].role;
    const same = shortlist.map((x, j) => [x, j]).filter(([x]) => x.role === role).map(([, j]) => j);
    const k = same.indexOf(i), swap = same[act === "up" ? k - 1 : k + 1];
    if (swap !== undefined) [shortlist[i], shortlist[swap]] = [shortlist[swap], shortlist[i]];
    return renderShortlist();
  }
  if (act === "reset-note") { store("gs-rf-note"); return renderShortlist(); }
  if (act === "copy-note" && c) {
    try { await navigator.clipboard.writeText(noteFor(c)); t.textContent = "Copied"; countEvent("reviewers-note-copied"); }
    catch (err) { t.textContent = "Copy failed"; }
    setTimeout(() => (t.textContent = "Copy note"), 1500);
    return;
  }
  if (act === "log" && c) {
    const r = addToTracker(c, stored("gs-rf-ms"), true);
    if (!r) { t.textContent = "Couldn't save"; return; }
    const s = shortlist.find((x) => x.id === id);
    if (s) s.logged = true;
    c.tracker = Object.assign(c.tracker || { tracker_id: r.id, invited: 0, accepted: 0 }, { this_manuscript: "awaiting" });
    countEvent("reviewers-invite-logged");
    renderShortlist();
    renderCandidates();
    return;
  }
  if (act === "track" && c) {
    const r = addToTracker(c, stored("gs-rf-ms"), false);
    if (!r) { t.textContent = "Couldn't save"; return; }
    c.tracker = { tracker_id: r.id, invited: 0, accepted: 0 };
    countEvent("reviewers-add-to-tracker");
    t.outerHTML = '<span class="added">Added to your tracker</span>';
    return;
  }
  if (act === "more" && c) {
    if (!seeds.includes(id)) seeds.push(id);
    t.disabled = true;
    t.textContent = "Adding their co-authors…";
    await run();
    const n = lastOut ? lastOut.candidates.filter((x) => x.notes.some((note) => note.includes("you picked"))).length : 0;
    setStatus(`Added ${c.name}'s co-authors: ${n} new or strengthened candidate${n === 1 ? "" : "s"}, marked "you picked".`, "done");
  }
});

renderPeople();
setReferences([], 0);
updateRun();
