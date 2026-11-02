// The Grey Swan Editorial: Cygnus, the researcher identity and independence check (website)
// Python (worker.js + idcheck.py) reads the files, looks people up in OpenAlex, ROR and ORCID through the browser,
// and decides each verdict; this page collects who to check and shows the results.

// OpenAlex needs an API key for real use (free, openalex.org/settings/api); visitors can add their own in Settings.
// ROR gives a higher allowance with a free client ID (ror.org/api-client-id). Both are safe to publish.
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
  if (msg.type === "ids-progress") return setStatus(`Looked up ${msg.who} (${msg.done} of ${msg.total})…`, "busy");
  if (msg.type === "ready") {
    isReady = true;
    readyWaiters.splice(0).forEach((r) => r());
    if (!running) setStatus(people.length ? "Ready to check." : "Ready. Add a manuscript, a list or people by hand.", "done");
    updateRun();
    return;
  }
  if (msg.type === "failed") return setStatus(`The checker could not start: ${msg.error}. Try reloading the page.`, "error");
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
function setStatus(text, kind) {
  $("status").className = "status" + (kind === "error" ? " error done" : kind === "done" ? " done" : "");
  $("status-text").textContent = text;
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function keys() {
  let own = "";
  try { own = localStorage.getItem("gs-openalex-key") || ""; } catch (e) { /* storage off */ }
  return JSON.stringify({ openalex: own.trim() || SITE_OPENALEX_KEY, ror: ROR_CLIENT_ID });
}
const VERDICT = { green: "Consistent", amber: "Quick check", red: "Verify before proceeding" };
const STATUS = { ok: "OK", check: "Check", concern: "Concern", info: "Note", unavailable: "Couldn't check" };
let uid = 0;
const newPid = () => `n${Date.now().toString(36)}${uid++}`;

// ---------------------------------------------------------------------------
// Who to check
// ---------------------------------------------------------------------------
let people = [];                 // {id, role, name, email, affiliation, orcid, corresponding, pick}
let running = false, lastOut = null;
const networks = {};             // seed id -> network result

function renderPeople() {
  $("people-wrap").hidden = !people.length;
  $("people").innerHTML = people.map((p, i) => `<tr class="${p.corresponding ? "corr" : ""}">
    <td class="role" data-label="Role"><select data-i="${i}" data-k="role" aria-label="Role">
      <option value="author" ${p.role === "author" ? "selected" : ""}>Author</option>
      <option value="reviewer" ${p.role === "reviewer" ? "selected" : ""}>Suggested reviewer</option></select></td>
    <td class="name"><input data-i="${i}" data-k="name" value="${esc(p.name)}" aria-label="Name" placeholder="Full name"></td>
    <td><input data-i="${i}" data-k="email" value="${esc(p.email)}" aria-label="Email" placeholder="Email"></td>
    <td><input data-i="${i}" data-k="affiliation" value="${esc(p.affiliation)}" aria-label="Affiliation" placeholder="Institution"></td>
    <td><input data-i="${i}" data-k="orcid" value="${esc(p.orcid)}" aria-label="ORCID iD" placeholder="0000-0000-0000-0000"></td>
    <td><button type="button" class="x" data-del="${i}" aria-label="Remove ${esc(p.name)}">×</button></td></tr>`).join("");
  updateRun();
}
function updateRun() {
  const n = people.filter((p) => p.name.trim()).length;
  $("run").disabled = !n || running || !isReady;
  $("run").textContent = running ? "Checking…" : `Check ${n || ""} researcher${n === 1 ? "" : "s"}`.replace("  ", " ");
}
$("people").addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.k) {
    const p = people[+t.dataset.i];
    p[t.dataset.k] = t.value;
    if (t.dataset.k === "name") delete p.pick;     // a different name: search again
    updateRun();
  }
});
$("people").addEventListener("change", (e) => { if (e.target.dataset.k === "role") people[+e.target.dataset.i].role = e.target.value; });
$("people").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del]");
  if (b) { people.splice(+b.dataset.del, 1); renderPeople(); }
});
$("add-row").addEventListener("click", () => {
  people.push({ id: newPid(), role: people.length ? "reviewer" : "author", name: "", email: "", affiliation: "", orcid: "" });
  renderPeople();
  $("people").querySelector("tr:last-child td.name input").focus();
});

function addPeople(list) {
  for (const p of list) {
    const same = people.find((q) => q.role === p.role && q.name.toLowerCase().replace(/\W/g, "") === p.name.toLowerCase().replace(/\W/g, ""));
    if (same) { for (const k of ["email", "affiliation", "orcid"]) if (!same[k] && p[k]) same[k] = p[k]; }
    else people.push({ id: newPid(), role: p.role || "author", name: p.name, email: p.email || "", affiliation: p.affiliation || "",
                       orcid: p.orcid || "", corresponding: !!p.corresponding });
  }
  renderPeople();
}

// Files
const READABLE = [".docx", ".pdf", ".odt", ".rtf", ".tex"];
async function useFiles(list) {
  const files = [...list].filter((f) => READABLE.includes((f.name.toLowerCase().match(/\.[a-z0-9]+$/) || [""])[0]));
  if (!files.length) { setStatus("Add a Word, PDF, OpenDocument, RTF or LaTeX file.", "error"); return; }
  setStatus(isReady ? "Reading the file(s)…" : "Your files will be read as soon as the checker has loaded…", "busy");
  await whenReady();
  try {
    const out = JSON.parse(await rpc("ids_extract", await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })))));
    addPeople(out.people);
    if (!$("ms-title").value && out.title) $("ms-title").value = out.title;
    if (!$("ms-keywords").value && out.keywords.length) $("ms-keywords").value = out.keywords.join(", ");
    $("unplaced").hidden = !out.unplaced.length;
    $("unplaced").textContent = out.unplaced.length ? `Also found, but couldn't tell whose they are: ${out.unplaced.join(", ")}. Add them to the right person above.` : "";
    const a = out.people.filter((p) => p.role === "author").length, r = out.people.length - a;
    setStatus(out.people.length ? `Found ${a} author(s)${r ? ` and ${r} suggested reviewer(s)` : ""}. Check the details, add any suggested reviewers, then run the check.`
      : "No author names were found in that file. Paste them or add them by hand.", out.people.length ? "done" : "error");
  } catch (err) {
    setStatus(`Couldn't read that file: ${err.message.split("\n").pop()}`, "error");
  }
}
const drop = $("dropzone");
$("file-input").addEventListener("change", (e) => { useFiles(e.target.files); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); useFiles(e.dataTransfer.files); });

// Pasted list
$("paste-add").addEventListener("click", async () => {
  const text = $("paste").value.trim();
  if (!text) return;
  await whenReady();
  const found = JSON.parse(await rpc("ids_parse", text, $("paste-role").value));
  if (!found.length) { setStatus("No names found in the pasted text.", "error"); return; }
  addPeople(found);
  $("paste").value = "";
  setStatus(`Added ${found.length} ${found.length === 1 ? "person" : "people"}.`, "done");
});

// The Reviewer Tracker (same browser, or synced through the account)
const TRACKER_KEY = "greyswan-reviewer-tracker-v1";
function trackerData() {
  try { return JSON.parse(localStorage.getItem(TRACKER_KEY) || "{}"); } catch (e) { return {}; }
}
function renderTracker() {
  const reviewers = trackerData().reviewers || [];
  $("tracker-box").hidden = !reviewers.length;
  const q = ($("tracker-search").value || "").toLowerCase();
  const shown = reviewers.filter((r) => !q || [r.name, r.affiliation, (r.keywords || []).join(" ")].join(" ").toLowerCase().includes(q)).slice(0, 80);
  $("tracker-list").innerHTML = shown.map((r) => {
    const added = people.some((p) => p.name === r.name && p.role === "reviewer");
    return `<label><input type="checkbox" data-tr="${esc(r.id)}" ${added ? "checked disabled" : ""}>
      <span>${esc(r.name)} <span class="muted">${esc([r.affiliation, (r.keywords || []).slice(0, 3).join(", ")].filter(Boolean).join(" · "))}</span></span></label>`;
  }).join("") || '<p class="muted small" style="padding:8px 12px">No matching reviewers.</p>';
}
$("tracker-search").addEventListener("input", renderTracker);
$("tracker-list").addEventListener("change", (e) => {
  const id = e.target.dataset.tr;
  const r = (trackerData().reviewers || []).find((x) => x.id === id);
  if (r && e.target.checked) { addPeople([{ role: "reviewer", name: r.name, email: r.email, affiliation: r.affiliation }]); renderTracker(); }
});
renderTracker();
if (ACCOUNT) ACCOUNT.onRemote("tracker", renderTracker);

// Settings
try { $("oa-key").value = localStorage.getItem("gs-openalex-key") || ""; } catch (e) { /* storage off */ }
$("oa-key").addEventListener("change", () => { try { localStorage.setItem("gs-openalex-key", $("oa-key").value.trim()); } catch (e) { /* off */ } });

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------
function session() {
  return {
    lookback_years: +$("lookback").value,
    manuscript: { title: $("ms-title").value.trim(), keywords: $("ms-keywords").value },
    people: people.filter((p) => p.name.trim()).map((p) => ({ id: p.id, role: p.role, name: p.name.trim(), email: p.email.trim(),
      affiliation: p.affiliation.trim(), orcid: p.orcid.trim(), ...(p.pick ? { pick: p.pick } : {}) })),
  };
}

async function run(keepOpen) {
  if (running) return;
  running = true;
  updateRun();
  const open = keepOpen ? new Set([...document.querySelectorAll(".person[open]")].map((d) => d.dataset.id)) : null;
  setStatus("Looking researchers up in OpenAlex, ROR and ORCID…", "busy");
  try {
    lastOut = JSON.parse(await rpc("ids_check", JSON.stringify(session()), keys()));
    for (const k of Object.keys(networks)) delete networks[k];
    renderResults(open);
    const unavailable = lastOut.results.filter((r) => r.findings.some((f) => f.status === "unavailable")).length;
    setStatus(unavailable ? `Done, but ${unavailable} lookup(s) didn't get an answer. If this keeps happening, OpenAlex's daily allowance may be used up: add your own free key in Settings.`
      : `Done: ${lastOut.counts.green} consistent, ${lastOut.counts.amber} quick check, ${lastOut.counts.red} to verify.`, unavailable ? "error" : "done");
    if (!keepOpen) $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(`Something went wrong: ${err.message.split("\n").pop()}`, "error");
  }
  running = false;
  updateRun();
}
$("run").addEventListener("click", () => run(false));

function findingRow(f) {
  const src = [f.source, f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">open</a>` : ""].filter(Boolean).join(" · ");
  return `<tr><td class="chk">${esc(f.check)}</td><td class="res s-${f.status}">${esc(f.label)}</td>
    <td>${esc(f.detail)}${src ? `<span class="src">${src}</span>` : ""}${f.limitation ? `<span class="lim">${esc(f.limitation)}</span>` : ""}</td></tr>`;
}

function personCard(r, isOpen) {
  const meta = [r.email, r.affiliation, r.orcid].filter(Boolean).map(esc).join(" · ");
  const parts = [`<details class="person" data-id="${esc(r.id)}" data-verdict="${r.verdict}" ${isOpen ? "open" : ""}>
    <summary><span class="pill v-${r.verdict}">${VERDICT[r.verdict]}</span><span class="pname">${esc(r.name)}</span>
      <span class="role-tag">${r.role === "reviewer" ? "Suggested reviewer" : "Author"}</span>
      ${r.profile && r.match === "matched" && r.role === "reviewer" ? `<span class="net-hint">Co-author network inside ▸</span>` : ""}
      ${meta ? `<span class="pmeta">${meta}</span>` : ""}</summary><div class="body">`];
  parts.push(`<table class="findings"><tbody>${r.findings.map(findingRow).join("")}</tbody></table>`);
  if (r.queries.length) {
    parts.push(`<div class="box"><h4>Queries for the authors <button type="button" class="text-button copy" data-copy="${esc(r.id)}">Copy</button></h4>
      <ol>${r.queries.map((q) => `<li>${esc(q)}</li>`).join("")}</ol></div>`);
  }
  const others = r.candidates.filter((c) => !r.profile || c.id !== r.profile.id);
  if (r.candidates.length && (r.match !== "matched" || others.length)) {
    parts.push(`<div class="box"><h4>${r.match === "multiple" ? "Which of these is the right person?" : "Not the right person?"}</h4><div class="cands">
      ${r.candidates.map((c) => `<div class="cand ${r.profile && c.id === r.profile.id ? "current" : ""}"><b>${esc(c.name)}</b>
        <span class="muted">${esc(c.institution || "No institution listed")}</span>
        <span class="muted">${c.works_count} works${c.last_year ? `, latest ${c.last_year}` : ""}${c.fields.length ? ` · ${esc(c.fields.join(", "))}` : ""}</span>
        <a href="${esc(c.url)}" target="_blank" rel="noopener" class="small">OpenAlex profile</a>
        ${r.profile && c.id === r.profile.id && r.match === "matched" ? '<span class="added">Used for this check</span>'
          : `<button type="button" class="button ghost small" data-pick="${esc(r.id)}" data-cand="${esc(c.id)}">${r.profile && c.id === r.profile.id ? "Confirm this one" : "Use this profile"}</button>`}</div>`).join("")}
      </div></div>`);
  }
  if (r.evidence.length || r.recent_works.length) {
    parts.push(`<div class="box"><h4>Evidence</h4><ul>${r.evidence.map((e) => `<li><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a></li>`).join("")}
      ${r.recent_works.map((w) => `<li>${esc(w.title)} (${w.year}${w.venue ? `, ${esc(w.venue)}` : ""})${w.doi ? ` <a href="${esc(w.doi)}" target="_blank" rel="noopener">DOI</a>` : ""}</li>`).join("")}</ul></div>`);
  }
  if (r.profile && r.match === "matched" && r.role === "reviewer") {
    parts.push(`<div class="net" data-net="${esc(r.id)}">${networks[r.id] ? networkHtml(r, networks[r.id])
      : `<button type="button" class="button ghost" data-network="${esc(r.id)}">Find reviewers in ${esc(r.name.split(" ")[0])}'s co-author network</button>`}</div>`);
  }
  parts.push("</div></details>");
  return parts.join("");
}

// Cygnus: the co-author network drawn as the swan constellation. The reviewer is Sadr, the swan's heart; the best
// candidates take the swan's named stars in order of fit, the rest are faint field stars, and anyone linked to the
// authors drifts down to the authors' shore. The table below the sky lists everyone.
const CY_SEED = { k: "Sadr", x: 340, y: 175 };
const CY_NAMED = [
  { k: "Deneb", x: 340, y: 55 }, { k: "Gienah", x: 445, y: 212 }, { k: "Delta Cygni", x: 240, y: 165 },
  { k: "Albireo", x: 340, y: 360 }, { k: "Eta Cygni", x: 340, y: 262 }, { k: "Zeta Cygni", x: 525, y: 278 },
  { k: "Kappa Cygni", x: 160, y: 118 }];
const CY_FIELD = [[215, 300], [115, 240], [480, 100], [575, 150], [250, 75], [430, 305], [605, 225], [185, 215],
  [95, 330], [230, 382], [600, 320], [545, 60], [110, 160], [450, 155]];
const CY_SHORE = [[445, 396], [510, 386], [575, 384], [640, 392]];
const CY_DUST = [[60, 40], [130, 300], [610, 60], [470, 40], [90, 200], [560, 150], [250, 400], [420, 110], [30, 380],
  [650, 250], [300, 120], [395, 240], [170, 350], [640, 140], [520, 330], [40, 110], [280, 330], [600, 20]];
let cyShowNames = false;

function cyPlace(net) {
  const fits = (c) => !c.conflicted && c.matches.length > 0;
  const ok = [...net.candidates.filter(fits), ...net.candidates.filter((c) => !c.conflicted && !fits(c))];
  const bad = net.candidates.filter((c) => c.conflicted);
  const nNamed = Math.min(net.candidates.filter(fits).length, CY_NAMED.length);
  const top = Math.max(...net.candidates.map((c) => c.score), 0.01);
  const named = ok.slice(0, nNamed).map((c, i) => ({ c, ...CY_NAMED[i], kind: "named", r: 4.5 + 6 * Math.max(0, c.score) / top }));
  const field = ok.slice(nNamed, nNamed + CY_FIELD.length).map((c, i) =>
    ({ c, x: CY_FIELD[i][0], y: CY_FIELD[i][1], k: "", kind: "field", r: 2.4 + 1.6 * Math.max(0, c.score) / top }));
  const shore = bad.slice(0, CY_SHORE.length).map((c, i) => ({ c, x: CY_SHORE[i][0], y: CY_SHORE[i][1], k: "", kind: "shore", r: 4.5 }));
  return { stars: [...named, ...field, ...shore], empty: CY_NAMED.slice(named.length),
           hidden: ok.length - named.length - field.length + bad.length - shore.length };
}

function cyLabel(s) {
  const short = (t) => (t.length > 20 ? t.slice(0, 19) + "…" : t);
  const text = cyShowNames && s.k ? s.k : short(s.c ? s.c.name : s.name);
  if (s.kind === "shore") return `<text class="lab" x="${s.x}" y="${s.y - 11}" text-anchor="middle">${esc(text)}</text>`;
  const left = s.x > 520;
  return `<text class="lab${s.kind === "field" ? " faint" : ""}" x="${left ? s.x - s.r - 7 : s.x + s.r + 7}" y="${s.y + 4}"
    text-anchor="${left ? "end" : "start"}">${esc(text)}</text>`;
}

function cygnusHtml(r, net) {
  const { stars, empty, hidden } = cyPlace(net);
  const line = (a, b) => `<path class="cy-line" d="M${a.x} ${a.y} L${b.x} ${b.y}"/>`;
  const N = Object.fromEntries([CY_SEED, ...CY_NAMED].map((p) => [p.k, p]));
  const shape = [["Sadr", "Deneb"], ["Sadr", "Eta Cygni"], ["Eta Cygni", "Albireo"], ["Sadr", "Delta Cygni"],
    ["Delta Cygni", "Kappa Cygni"], ["Sadr", "Gienah"], ["Gienah", "Zeta Cygni"]].map(([a, b]) => line(N[a], N[b])).join("");
  const star = (s, i) => {
    const c = s.c, cls = s.kind + (c.flags.some((f) => f.level === "check") ? " checkit" : "");
    const what = [c.name, c.institution, c.conflicted ? "linked to the authors" : `fit ${c.matches.length ? c.matches.join(", ") : "partial"}`].filter(Boolean).join(", ");
    return `<g class="cy-star ${cls}" tabindex="0" role="button" data-cy="${esc(c.id)}" style="animation-delay:${(0.15 + i * 0.1).toFixed(2)}s" aria-label="${esc(what)}">
      <circle class="halo" cx="${s.x}" cy="${s.y}" r="${(s.r * 2.3).toFixed(1)}"/>
      ${cls.includes("checkit") ? `<circle class="ring" cx="${s.x}" cy="${s.y}" r="${(s.r + 4).toFixed(1)}"/>` : ""}
      <circle class="core" cx="${s.x}" cy="${s.y}" r="${s.r.toFixed(1)}"/>${cyLabel(s)}</g>`;
  };
  const seedName = cyShowNames ? "Sadr" : r.name;
  return `<div class="cygnus" data-seed="${esc(r.id)}">
    <svg class="cy-sky" viewBox="0 0 680 430" role="group" aria-label="Cygnus: reviewer candidates around ${esc(r.name)}">
      <rect class="cy-bg" x="0" y="0" width="680" height="430" rx="12"/>
      ${CY_DUST.map(([x, y], i) => `<circle class="cy-dust" cx="${x}" cy="${y}" r="${(0.8 + (i % 3) * 0.2).toFixed(1)}" style="animation-delay:${(i * 0.37 % 2.4).toFixed(2)}s"/>`).join("")}
      <g class="cy-lines">${shape}</g>
      ${empty.map((p) => `<circle class="cy-empty" cx="${p.x}" cy="${p.y}" r="1.6"><title>${p.k}: no candidate here</title></circle>`).join("")}
      ${stars.some((s) => s.kind === "shore") ? `<path class="cy-shore" d="M410 404 Q545 379 668 399"/>
        <text class="cy-shore-lab" x="545" y="422" text-anchor="middle">The authors' shore</text>` : ""}
      <g class="cy-star seed" style="animation-delay:0s" aria-label="${esc(r.name)}, your reviewer">
        <circle class="halo" cx="${CY_SEED.x}" cy="${CY_SEED.y}" r="26"/><circle class="core" cx="${CY_SEED.x}" cy="${CY_SEED.y}" r="11"/>
        <text class="lab seedlab" x="${CY_SEED.x + 19}" y="${CY_SEED.y - 10}">${esc(seedName)}</text></g>
      ${stars.map(star).join("")}
      <text class="cy-word" x="24" y="34">CYGNUS</text>
      <text class="cy-sub" x="24" y="53">around ${esc(r.name)}</text>
    </svg>
    <div class="cy-bar"><label><input type="checkbox" class="cy-names" ${cyShowNames ? "checked" : ""}> Show star names</label>
      <span>Bright star = strong fit · faint = weaker · amber ring = check first · red = linked to the authors${hidden > 0 ? ` · ${hidden} more in the table` : ""}</span></div>
    <div class="cy-card" aria-live="polite"><p class="muted small">Hover over or tap a star to see who it is.</p></div>
  </div>`;
}

function cyCard(box, rid, cid) {
  const net = networks[rid], c = net && net.candidates.find((x) => x.id === cid);
  if (!c) return;
  box.querySelectorAll(".cy-star").forEach((g) => g.classList.toggle("on", g.dataset.cy === cid));
  box.parentElement.querySelectorAll(".net-table tr[data-cand]").forEach((tr) => tr.classList.toggle("lit", tr.dataset.cand === cid));
  const tracked = new Set((trackerData().reviewers || []).map((x) => x.name.toLowerCase()));
  const where = cyPlace(net).stars.find((s) => s.c.id === cid);
  const tag = where && where.k ? `Star: ${where.k}` : where && where.kind === "shore" ? "On the authors' shore" : "Field star";
  box.querySelector(".cy-card").innerHTML = `
    <div class="cy-head"><a href="${esc(c.url)}" target="_blank" rel="noopener"><b>${esc(c.name)}</b></a><span class="muted small">${tag}</span></div>
    <div class="muted small">${esc([c.institution, c.country].filter(Boolean).join(", ") || "Institution not known")}${c.orcid ? ` · <a href="https://orcid.org/${esc(c.orcid)}" target="_blank" rel="noopener">ORCID</a>` : ""}</div>
    <div class="tags">${c.matches.map((m) => `<span class="hit">${esc(m)}</span>`).join("")}${c.fields.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
    <div class="small">${c.works_count} works · ${c.recent_works} in the last 3 years · ${c.shared_with_seed} paper(s) with ${esc(net.seed_name.split(" ")[0])}</div>
    ${c.flags.map((f) => `<span class="flag ${f.level}">${esc(f.text)}</span>`).join("")}
    <div class="cy-act">${tracked.has(c.name.toLowerCase()) ? '<span class="added">In your tracker</span>'
      : `<button type="button" class="button ghost small" data-track="${esc(rid)}|${esc(c.id)}">${c.conflicted ? "Add anyway" : "Add to tracker"}</button>`}</div>`;
}

function networkHtml(r, net) {
  if (!net.candidates.length) return `<div class="box"><h4>Co-author network</h4><p class="muted small">${esc(net.note || "No co-authors found.")}</p></div>`;
  const tracked = new Set((trackerData().reviewers || []).map((x) => x.name.toLowerCase()));
  return `<div class="box"><h4>Reviewer candidates from ${esc(net.seed_name)}'s co-authors since ${net.since}
      <span class="muted small">${net.considered} co-authors considered</span></h4>
    <p class="muted small">Ranked by fit with the manuscript's keywords and recent activity. Anyone who has published with the
      authors or works at their institution is marked, set on the authors' shore and listed last. Check each candidate yourself before inviting.</p>
    ${cygnusHtml(r, net)}
    <div class="table-wrap"><table class="net-table"><thead><tr><th>Candidate</th><th>Field and fit</th><th>Activity</th><th></th></tr></thead><tbody>
    ${net.candidates.map((c) => `<tr data-cand="${esc(c.id)}" class="${c.conflicted ? "conflicted" : ""}">
      <td><a href="${esc(c.url)}" target="_blank" rel="noopener"><b>${esc(c.name)}</b></a><span class="flag muted">${esc([c.institution, c.country].filter(Boolean).join(", "))}</span>
        ${c.orcid ? `<a class="small" href="https://orcid.org/${esc(c.orcid)}" target="_blank" rel="noopener">ORCID</a>` : ""}
        ${c.flags.map((f) => `<span class="flag ${f.level}">${esc(f.text)}</span>`).join("")}</td>
      <td><div class="tags">${c.matches.map((m) => `<span class="hit">${esc(m)}</span>`).join("")}${c.fields.map((f) => `<span>${esc(f)}</span>`).join("")}</div></td>
      <td>${c.works_count} works · ${c.recent_works} in the last 3 years<span class="flag muted">${c.shared_with_seed} paper(s) with ${esc(net.seed_name.split(" ")[0])}</span></td>
      <td>${tracked.has(c.name.toLowerCase()) ? '<span class="added">In your tracker</span>'
        : `<button type="button" class="button ghost small" data-track="${esc(r.id)}|${esc(c.id)}">Add to tracker</button>`}</td></tr>`).join("")}
    </tbody></table></div></div>`;
}

function renderResults(open) {
  if (!lastOut) return;
  const out = lastOut;
  const all = out.results.flatMap((r) => r.queries);
  const html = [`<div class="results-head"><h2>Results</h2><div class="downloads">
      <button type="button" class="button ghost" id="dl-xlsx">Excel report</button>
      <button type="button" class="button ghost" id="dl-docx">Word report</button>
      ${all.length ? '<button type="button" class="button ghost" id="copy-all">Copy all queries</button>' : ""}</div></div>
    <p class="muted small">Checked ${out.retrieved} · co-authorship since ${new Date(out.retrieved).getFullYear() - out.lookback_years}${out.manuscript.title ? ` · ${esc(out.manuscript.title)}` : ""}</p>
    <div class="counts">
      <span class="count v-red"><b>${out.counts.red}</b>verify before proceeding</span>
      <span class="count v-amber"><b>${out.counts.amber}</b>quick check</span>
      <span class="count v-green"><b>${out.counts.green}</b>consistent</span></div>`];
  if (!out.results.some((r) => r.role === "reviewer")) {
    html.push('<p class="muted small">To find more reviewers, add at least one suggested or trusted reviewer (Role: Suggested reviewer) and check again: ' +
      "their co-author network opens from their card. Authors' own co-authors aren't independent, so the network isn't offered for them.</p>");
  }
  const order = { red: 0, amber: 1, green: 2 };
  const sorted = [...out.results].sort((a, b) => (a.role === b.role ? 0 : a.role === "author" ? -1 : 1) || order[a.verdict] - order[b.verdict]);
  for (const r of sorted) html.push(personCard(r, open ? open.has(r.id) : r.verdict !== "green" && out.results.length <= 8));
  $("results").innerHTML = html.join("");
}

// Clicks inside the results
$("results").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.id === "dl-xlsx" || t.id === "dl-docx") {
    const files = await rpc("ids_report", JSON.stringify(lastOut));
    t.id === "dl-xlsx" ? download("cygnus_report.xlsx", files.report, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      : download("cygnus_report.docx", files.word, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return;
  }
  if (t.id === "copy-all" || t.dataset.copy) {
    const list = t.id === "copy-all" ? lastOut.results.flatMap((r) => r.queries) : lastOut.results.find((r) => r.id === t.dataset.copy).queries;
    const text = list.map((q, i) => `${i + 1}. ${q}`).join("\n");
    try { await navigator.clipboard.writeText(text); t.textContent = "Copied"; } catch (err) { t.textContent = "Copy failed"; }
    setTimeout(() => (t.textContent = t.id === "copy-all" ? "Copy all queries" : "Copy"), 1500);
    return;
  }
  if (t.dataset.pick) {
    const p = people.find((x) => x.id === t.dataset.pick);
    if (p) { p.pick = t.dataset.cand; await run(true); }
    return;
  }
  if (t.dataset.network) {
    const id = t.dataset.network;
    t.disabled = true;
    t.textContent = "Looking at their co-authors…";
    try {
      networks[id] = JSON.parse(await rpc("ids_network", JSON.stringify(session()), id, keys()));
      const r = lastOut.results.find((x) => x.id === id);
      document.querySelector(`[data-net="${CSS.escape(id)}"]`).innerHTML = networkHtml(r, networks[id]);
    } catch (err) {
      t.disabled = false;
      t.textContent = "Couldn't load the network; try again";
    }
    return;
  }
  if (t.dataset.track) {
    const [rid, cid] = t.dataset.track.split("|");
    const net = networks[rid];
    const c = net && net.candidates.find((x) => x.id === cid);
    if (!c) return;
    const data = Object.assign({ reviewers: [], invites: [], lastBackup: null }, trackerData());
    if (!data.reviewers.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) {
      data.reviewers.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name: c.name, email: "",
        affiliation: c.institution, keywords: [...new Set([...c.matches, ...c.fields])].slice(0, 6), dead: false,
        source: "network", notes: `Found via Cygnus – co-author network of ${net.seed_name} (${new Date().toISOString().slice(0, 10)}). ` +
          `${c.shared_with_seed} shared paper(s). OpenAlex: ${c.url}${c.orcid ? ` · ORCID: https://orcid.org/${c.orcid}` : ""}. Email not known yet.` });
      try { localStorage.setItem(TRACKER_KEY, JSON.stringify(data)); } catch (err) { t.textContent = "Couldn't save"; return; }
      if (ACCOUNT) ACCOUNT.changed("tracker");
    }
    document.querySelectorAll(`[data-track="${CSS.escape(t.dataset.track)}"]`).forEach((b) => (b.outerHTML = '<span class="added">Added to your tracker</span>'));
    renderTracker();
  }
});

// Cygnus: hover, focus or tap a star to see its card; the table row lights up too
function cyFrom(e) {
  const g = e.target.closest && e.target.closest(".cy-star[data-cy]");
  if (!g) return;
  const box = g.closest(".cygnus");
  cyCard(box, box.dataset.seed, g.dataset.cy);
}
$("results").addEventListener("mouseover", cyFrom);
$("results").addEventListener("focusin", cyFrom);
$("results").addEventListener("click", cyFrom);
$("results").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest(".cy-star[data-cy]")) { e.preventDefault(); cyFrom(e); } });
$("results").addEventListener("mouseover", (e) => {
  const tr = e.target.closest && e.target.closest(".net-table tr[data-cand]");
  if (!tr) return;
  const box = tr.closest(".net").querySelector(".cygnus");
  if (box) cyCard(box, box.dataset.seed, tr.dataset.cand);
});
$("results").addEventListener("change", (e) => {
  if (!e.target.classList.contains("cy-names")) return;
  cyShowNames = e.target.checked;
  document.querySelectorAll(".cygnus").forEach((box) => {
    const rid = box.dataset.seed, r = lastOut.results.find((x) => x.id === rid);
    const card = box.querySelector(".cy-card").innerHTML;
    const lit = box.querySelector(".cy-star.on");
    const tmp = document.createElement("div");
    tmp.innerHTML = cygnusHtml(r, networks[rid]);
    const fresh = tmp.firstElementChild;
    fresh.classList.add("calm");
    fresh.querySelector(".cy-card").innerHTML = card;
    if (lit) { const g = fresh.querySelector(`.cy-star[data-cy="${CSS.escape(lit.dataset.cy)}"]`); if (g) g.classList.add("on"); }
    box.replaceWith(fresh);
  });
});

renderPeople();
