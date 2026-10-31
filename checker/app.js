// The Grey Swan Editorial: Manuscript Pre-Submission Checker (website)
// The checking itself happens in worker.js, which runs the Python checker in this browser.

// ---------------------------------------------------------------------------
// Talking to the worker
// ---------------------------------------------------------------------------
const pageParams = new URLSearchParams(location.search);
const workerParams = new URLSearchParams();
if (pageParams.get("pyodide")) workerParams.set("pyodide", pageParams.get("pyodide"));   // for local testing
const worker = new Worker(`worker.js${workerParams.toString() ? "?" + workerParams : ""}`);

let nextId = 1;
const pending = new Map();
let isReady = false;

function rpc(fn, ...args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, fn, args });
  });
}

worker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "progress") return setStatus(msg.text, "busy");
  if (msg.type === "ready") return onReady();
  if (msg.type === "failed") return setStatus(`The checker could not start: ${msg.error}. Try reloading the page.`, "error");
  const job = pending.get(msg.id);
  if (!job) return;
  pending.delete(msg.id);
  msg.ok ? job.resolve(msg.result) : job.reject(new Error(msg.error));
};

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const SEVERITIES = ["must", "should", "advisory", "off"];
let LABELS = { must: "Must fix", should: "Should fix", advisory: "Advisory", off: "Off" };
let RULES = [];
let REVIEW_MODELS = { single_blind: "Single-blind", double_blind: "Double-blind", open: "Open" };
let CITATION_STYLES = { auto: "Any (detect from the manuscript)" };
let baseProfile = null;        // the profile as chosen or loaded, before the visitor's adjustments
let uploadedProfile = null;    // a profile file the visitor loaded, if any
let files = [];                // [{name, data: ArrayBuffer}]
let lastRun = null;            // {results, report}
const shown = { must: true, should: true, advisory: true };

// Signed in with Google (see /assets/account.js): saved profiles, preferences and check history follow the user
const ACCOUNT = window.GSAccount || null;
const accountData = () => (ACCOUNT ? ACCOUNT.get("checker") : {});
const signedIn = () => !!(ACCOUNT && ACCOUNT.state().signedIn);
function saveAccountData(change) {
  if (!ACCOUNT) return;
  const d = ACCOUNT.get("checker");
  change(d);
  ACCOUNT.set("checker", d);
}

function setStatus(text, kind) {
  const box = $("status");
  box.className = "status" + (kind === "error" ? " error done" : kind === "done" ? " done" : "");
  $("status-text").textContent = text;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Profile panel
// ---------------------------------------------------------------------------
async function onReady() {
  const cat = JSON.parse(await rpc("catalogue"));
  RULES = cat.rules;
  LABELS = cat.severity_labels;
  REVIEW_MODELS = cat.review_models || REVIEW_MODELS;
  $("review-model").innerHTML = Object.entries(REVIEW_MODELS)
    .map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join("");
  CITATION_STYLES = cat.citation_styles || CITATION_STYLES;
  $("citation-style").innerHTML = Object.entries(CITATION_STYLES)
    .map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join("");

  const select = $("profile-select");
  select.innerHTML = cat.profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  select.disabled = false;
  buildRuleList();
  addMyProfiles();
  const wanted = accountData().lastProfile || (ACCOUNT && ACCOUNT.get("profile").defaultProfile) || select.value;
  select.value = [...select.options].some((o) => o.value === wanted) ? wanted : select.options[0].value;
  await useProfile(select.value);

  isReady = true;
  setStatus("Ready. Choose your journal's profile, then add manuscripts.", "done");
  if (files.length) runCheck();
}

function buildRuleList() {
  let area = null;
  const html = [];
  for (const r of RULES) {
    if (r.area !== area) {
      if (area) html.push("</div>");
      area = r.area;
      const note = area === "Anonymisation" ? '<span class="what">Checked only when peer review is double-blind</span>' : "";
      html.push(`<div class="rule-group" data-area="${escapeHtml(area)}"><div class="rule-area">${escapeHtml(area)}${note}</div>`);
    }
    const options = SEVERITIES.map((s) => `<option value="${s}">${escapeHtml(LABELS[s])}</option>`).join("");
    html.push(`<label class="rule" id="row-${r.id}" title="${escapeHtml(r.what)}">
      <span><span class="name">${escapeHtml(r.label)}</span><span class="what">${escapeHtml(r.what)}</span></span>
      <select data-rule="${r.id}" aria-label="${escapeHtml(r.label)}">${options}</select></label>`);
  }
  html.push("</div>");
  $("rules-list").innerHTML = html.join("");
}

function fillForm(profile) {
  const s = profile.settings || {};
  $("review-model").value = s.review_model || "single_blind";
  $("citation-style").value = s.citation_style || "auto";
  $("abstract-limit").value = s.abstract_word_limit ?? 250;
  $("cutoff").value = s.data_cutoff_year ?? 2020;
  $("ignore").value = (s.extra_ignore_abbreviations || []).join(", ");
  $("skip-symbols").checked = s.skip_gene_and_chemical_symbols ?? true;
  for (const sel of document.querySelectorAll("#rules-list select")) {
    sel.value = (profile.rules || {})[sel.dataset.rule] || "should";
  }
  $("profile-desc").textContent = profile.description || "";
  markChanges();
}

async function chooseProfile(id) {
  baseProfile = JSON.parse(await rpc("profile", id));
  fillForm(baseProfile);
}

// "my:<id>" is a profile the user saved to their account; anything else is a built-in profile
async function useProfile(value) {
  if (value === "__uploaded__") { baseProfile = uploadedProfile; fillForm(baseProfile); }
  else if (value.startsWith("my:")) {
    const mine = (accountData().profiles || []).find((p) => "my:" + p.id === value);
    if (!mine) return chooseProfile("generic");
    baseProfile = structuredClone(mine.profile);
    fillForm(baseProfile);
  } else await chooseProfile(value);
  markChanges();
}

// The user's saved profiles, at the end of the profile list
function addMyProfiles() {
  const select = $("profile-select");
  const keep = select.value;
  select.querySelectorAll("optgroup[data-mine]").forEach((g) => g.remove());
  const mine = accountData().profiles || [];
  if (mine.length) {
    const group = document.createElement("optgroup");
    group.label = "My profiles";
    group.dataset.mine = "1";
    for (const p of mine) {
      const o = document.createElement("option");
      o.value = "my:" + p.id;
      o.textContent = p.name;
      group.appendChild(o);
    }
    select.appendChild(group);
  }
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
}

// The profile the visitor is checking with: the base profile plus whatever they changed
function currentProfile() {
  const p = structuredClone(baseProfile);
  p.settings = Object.assign({}, p.settings, {
    review_model: $("review-model").value,
    citation_style: $("citation-style").value,
    abstract_word_limit: parseInt($("abstract-limit").value, 10) || 250,
    data_cutoff_year: parseInt($("cutoff").value, 10) || 2020,
    extra_ignore_abbreviations: $("ignore").value.split(",").map((a) => a.trim()).filter(Boolean),
    skip_gene_and_chemical_symbols: $("skip-symbols").checked,
  });
  p.rules = Object.assign({}, p.rules);
  for (const sel of document.querySelectorAll("#rules-list select")) p.rules[sel.dataset.rule] = sel.value;
  if (isAdjusted()) p.name = `${baseProfile.name} (adjusted)`;
  return p;
}

function isAdjusted() {
  const s = baseProfile.settings || {};
  if ($("review-model").value !== (s.review_model || "single_blind")) return true;
  if ($("citation-style").value !== (s.citation_style || "auto")) return true;
  if ((parseInt($("abstract-limit").value, 10) || 250) !== (s.abstract_word_limit ?? 250)) return true;
  if ((parseInt($("cutoff").value, 10) || 2020) !== (s.data_cutoff_year ?? 2020)) return true;
  const ignore = $("ignore").value.split(",").map((a) => a.trim()).filter(Boolean).join(",");
  if (ignore !== (s.extra_ignore_abbreviations || []).join(",")) return true;
  if ($("skip-symbols").checked !== (s.skip_gene_and_chemical_symbols ?? true)) return true;
  return [...document.querySelectorAll("#rules-list select")]
    .some((sel) => sel.value !== ((baseProfile.rules || {})[sel.dataset.rule] || "should"));
}

function markChanges() {
  for (const sel of document.querySelectorAll("#rules-list select")) {
    sel.className = `sev-${sel.value}`;
    const original = (baseProfile.rules || {})[sel.dataset.rule] || "should";
    $(`row-${sel.dataset.rule}`).classList.toggle("changed", sel.value !== original);
  }
  const anon = document.querySelector('.rule-group[data-area="Anonymisation"]');
  if (anon) anon.classList.toggle("inactive", $("review-model").value !== "double_blind");
  const adjusted = isAdjusted();
  $("save-profile").hidden = !adjusted;
  $("reset-profile").hidden = !adjusted;
  // Signed in: settings can be kept in the account, to use on any device
  const keepable = adjusted || $("profile-select").value === "__uploaded__";
  $("keep-box").hidden = !(ACCOUNT && keepable);
  if (!keepable) { $("keep-form").hidden = true; $("keep-profile").hidden = false; }
}

let timer = null;
function settingsChanged() {
  markChanges();
  clearTimeout(timer);
  timer = setTimeout(() => { if (files.length) runCheck(); }, 350);
}

$("profile-select").addEventListener("change", async (e) => {
  await useProfile(e.target.value);
  if (e.target.value !== "__uploaded__") saveAccountData((d) => { d.lastProfile = e.target.value; });
  if (files.length) runCheck();
});

$("keep-profile").addEventListener("click", async () => {
  if (!signedIn()) {
    $("keep-note").innerHTML = "Sign in (top right) to save profiles to your account and use them on any device.";
    return;
  }
  $("keep-profile").hidden = true;
  $("keep-form").hidden = false;
  $("keep-name").value = (baseProfile.name || "My profile").replace(/^Your profile: /, "");
  $("keep-name").select();
});

$("keep-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("keep-name").value.trim() || "My profile";
  const profile = currentProfile();
  profile.name = name;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  saveAccountData((d) => {
    d.profiles = [...(d.profiles || []), { id, name, profile, saved: new Date().toISOString() }];
    d.lastProfile = "my:" + id;
  });
  addMyProfiles();
  $("profile-select").value = "my:" + id;
  baseProfile = structuredClone(profile);
  fillForm(baseProfile);
  markChanges();
  $("keep-form").hidden = true;
  $("keep-profile").hidden = false;
  $("keep-note").innerHTML = `<span class="saved-note">Saved to your account as “${escapeHtml(name)}”.</span>`;
  setTimeout(() => ($("keep-note").textContent = ""), 4000);
});

for (const id of ["review-model", "citation-style", "abstract-limit", "cutoff", "ignore", "skip-symbols"]) {
  $(id).addEventListener("input", settingsChanged);
  $(id).addEventListener("change", settingsChanged);
}
$("rules-list").addEventListener("change", settingsChanged);

$("reset-profile").addEventListener("click", () => {
  fillForm(baseProfile);
  if (files.length) runCheck();
});

$("save-profile").addEventListener("click", async () => {
  const text = await rpc("save_profile", JSON.stringify(currentProfile()), JSON.stringify(baseProfile));
  download("my_profile.yaml", text, "text/yaml");
});

$("profile-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const note = $("profile-note");
  note.hidden = false;
  if (!isReady) { note.textContent = "Please wait until the checker is ready."; return; }
  try {
    uploadedProfile = JSON.parse(await rpc("read_profile", await file.text(), file.name));
    const select = $("profile-select");
    let opt = select.querySelector('option[value="__uploaded__"]');
    if (!opt) {
      opt = document.createElement("option");
      opt.value = "__uploaded__";
      select.appendChild(opt);
    }
    opt.textContent = `Your profile: ${uploadedProfile.name}`;
    select.value = "__uploaded__";
    baseProfile = uploadedProfile;
    fillForm(baseProfile);
    note.textContent = `Loaded “${uploadedProfile.name}”.`;
    if (files.length) runCheck();
  } catch (err) {
    note.textContent = `Could not use that profile: ${err.message.split("\n").pop()}`;
  }
});

// ---------------------------------------------------------------------------
// Manuscripts
// ---------------------------------------------------------------------------
const READABLE = [".docx", ".pdf", ".odt", ".rtf", ".tex"];
const dismissed = new Set();          // "file name|Section|Check" marked as false alarms
let showDismissed = false;
let view = "author";                  // "author": what to fix and how; "editor": a terse screening log
try { view = localStorage.getItem("gs-view") || "author"; } catch (e) { /* storage unavailable */ }
if (ACCOUNT) {
  const prof = ACCOUNT.get("profile");
  const byRole = { editor: "editor", office: "editor", service: "editor", reviewer: "editor", author: "author" }[prof.role];
  view = accountData().view || prof.view || byRole || view;
}

function extension(name) {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

async function addFiles(list) {
  const all = [...list];
  const readable = all.filter((f) => READABLE.includes(extension(f.name)));
  const old = all.filter((f) => extension(f.name) === ".doc");
  if (!readable.length) {
    setStatus(old.length ? "Old Word .doc files can't be read. In Word, use File → Save As → .docx."
      : "Add Word (.docx), PDF, OpenDocument (.odt), RTF or LaTeX (.tex) files.", "error");
    return;
  }
  files = await Promise.all(readable.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
  runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  dismissed.clear();
  const skipped = all.length - readable.length;
  if (skipped) setStatus(`${skipped} file(s) skipped: ${old.length ? "old .doc files must be saved as .docx; " : ""}`
    + "only .docx, .pdf, .odt, .rtf and .tex files can be checked.", "done");
  if (isReady) runCheck();
  else setStatus("Your files are ready; they will be checked as soon as the checker has loaded…", "busy");
}

const drop = $("dropzone");
$("file-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });

let running = false, again = false;
let runId = null;            // one history entry per set of files, updated as the settings change

// Signed in: keep a short summary of each check (file names and results, never the files) in the account
function recordHistory(profileName) {
  if (!signedIn() || !runId || !lastRun) return;
  const entry = {
    id: runId, date: new Date().toISOString(), profile: profileName,
    files: lastRun.results.map((r) => r.error ? { name: r.name, verdict: "Unreadable" }
      : { name: r.name, verdict: verdictOf(liveIssues(r)), counts: countsOf(liveIssues(r)), role: (r.info || {}).role || "manuscript" }),
  };
  saveAccountData((d) => { d.history = [entry, ...(d.history || []).filter((h) => h.id !== runId)].slice(0, 50); });
}
async function runCheck() {
  if (running) { again = true; return; }
  running = true;
  setStatus(`Checking ${files.length} file(s)…`, "busy");
  try {
    const profile = currentProfile();
    const gone = [...dismissed].map((d) => { const i = d.indexOf("|"); return { name: d.slice(0, i), key: d.slice(i + 1) }; });
    lastRun = await rpc("check", files, JSON.stringify(profile), JSON.stringify(gone));
    lastRun.profileName = profile.name;
    renderResults();
    recordHistory(profile.name);
    setStatus("Done. Change the profile or settings and the results update by themselves.", "done");
  } catch (err) {
    setStatus(`Something went wrong while checking: ${err.message.split("\n").pop()}`, "error");
  }
  running = false;
  if (again) { again = false; runCheck(); }
}

function tally(c) {
  return `${c.must} must fix · ${c.should} should fix · ${c.advisory} advisory`;
}

function liveIssues(r) {
  return r.issues.filter((i) => !dismissed.has(`${r.name}|${i.key}`));
}

function verdictOf(issues) {
  return issues.some((i) => i.severity === "must" || i.severity === "should") ? "Needs revision" : "Ready";
}

function countsOf(issues) {
  const c = { must: 0, should: 0, advisory: 0 };
  issues.forEach((i) => { c[i.severity] += 1; });
  return c;
}

function tagFor(info) {
  if (!info) return "";
  const parts = [];
  if (info.role && info.role !== "manuscript") parts.push(info.role);
  if (info.format && info.format !== "Word") parts.push(info.format);
  return parts.length ? `<span class="tag">${escapeHtml(parts.join(" · "))}</span>` : "";
}

function issueRow(r, i) {
  const id = `${r.name}|${i.key}`;
  const isGone = dismissed.has(id);
  const button = `<button type="button" class="dismiss" data-id="${escapeHtml(id)}"
      title="${isGone ? "Restore" : "Dismiss as a false alarm"}" aria-label="${isGone ? "Restore" : "Dismiss"} ${escapeHtml(i.check)}">${isGone ? "↺" : "×"}</button>`;
  const sev = `<td class="sev sev-${i.severity}" data-label="Severity">${escapeHtml(LABELS[i.severity])}</td>`;
  if (view === "editor") {
    return `<tr class="${isGone ? "gone" : ""}"><td class="section" data-label="Section">${escapeHtml(i.section)}</td>${sev}
      <td data-label="Check">${escapeHtml(i.check)}</td><td data-label="Status">${escapeHtml(i.status)}</td>
      <td data-label="Details">${escapeHtml(i.details)}</td><td class="act">${button}</td></tr>`;
  }
  return `<tr class="${isGone ? "gone" : ""}">${sev}
    <td data-label="Check"><span class="section-small">${escapeHtml(i.section)}</span>${escapeHtml(i.check)}</td>
    <td data-label="Details">${escapeHtml(i.details)}</td>
    <td data-label="How to fix" class="fix">${escapeHtml(i.fix || "")}${i.source && i.source !== "—"
      ? `<span class="source">${escapeHtml(i.source)}</span>` : ""}</td><td class="act">${button}</td></tr>`;
}

function renderResults() {
  const { results, report, word, profileName } = lastRun;
  const readable = results.filter((r) => !r.error);
  const ready = readable.filter((r) => verdictOf(liveIssues(r)) === "Ready").length;
  const openAll = results.length === 1;
  const goneCount = [...dismissed].length;
  const head = view === "editor"
    ? "<th>Section</th><th>Severity</th><th>Check</th><th>Status</th><th>Details</th><th></th>"
    : "<th>Severity</th><th>Check</th><th>What was found</th><th>How to fix</th><th></th>";

  const parts = [`<div class="results-head"><h2>Results</h2><div class="downloads">
      ${report ? '<button type="button" class="button ghost" id="download-report">Excel report</button>' : ""}
      ${word ? '<button type="button" class="button ghost" id="download-word">Word report</button>' : ""}</div></div>
    <p class="muted small">Checked against: ${escapeHtml(profileName)} · ${results.length} file(s):
      ${ready} ready, ${readable.length - ready} need revision${results.length > readable.length
        ? `, ${results.length - readable.length} could not be read` : ""}.</p>
    <div class="toolbar">
      <div class="view-toggle" role="group" aria-label="Report view">
        <button type="button" data-view="author" aria-pressed="${view === "author"}">Author view</button>
        <button type="button" data-view="editor" aria-pressed="${view === "editor"}">Editor view</button>
      </div>
      <div class="filters" role="group" aria-label="Show severities">
        ${["must", "should", "advisory"].map((s) =>
          `<button type="button" class="chip sev-${s}" data-sev="${s}" aria-pressed="${shown[s]}">${escapeHtml(LABELS[s])}</button>`).join("")}
      </div>
      ${goneCount ? `<button type="button" class="text-button" id="toggle-dismissed">${goneCount} dismissed · ${showDismissed ? "hide" : "show"}</button>` : ""}
    </div>`];

  for (const r of results) {
    if (r.error) {
      parts.push(`<details class="manuscript"><summary><span class="fname">${escapeHtml(r.name)}</span>
        <span class="verdict error">${escapeHtml(r.error)}</span></summary>
        <p class="empty">Check that it is a valid .docx, .pdf, .odt, .rtf or .tex file.</p></details>`);
      continue;
    }
    const live = liveIssues(r);
    const isReadyDoc = verdictOf(live) === "Ready";
    const rank = { must: 0, should: 1, advisory: 2 };
    let visible = r.issues.filter((i) => shown[i.severity] && (showDismissed || !dismissed.has(`${r.name}|${i.key}`)));
    if (view === "author") {      // authors: most serious first; editors: section by section, as a screening log
      visible = visible.map((i, n) => [i, n]).sort((a, b) => rank[a[0].severity] - rank[b[0].severity] || a[1] - b[1])
        .map(([i]) => i);
    }
    const rows = visible.map((i) => issueRow(r, i)).join("");
    const body = !r.issues.length ? '<p class="empty">All checks passed.</p>'
      : rows ? `<div class="table-wrap"><table class="${view}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="empty muted">Nothing to show at the selected severities.</p>';
    parts.push(`<details class="manuscript" ${openAll ? "open" : ""} data-name="${escapeHtml(r.name)}"><summary>
        <span class="fname">${escapeHtml(r.name)}</span>${tagFor(r.info)}
        <span class="verdict ${isReadyDoc ? "ready" : "revise"}">${isReadyDoc ? "Ready" : "Needs revision"}</span>
        ${live.length ? `<span class="tally">${tally(countsOf(live))}</span>` : ""}</summary>${body}</details>`);
  }

  // keep open/closed panels as they were when the results refresh
  const wasOpen = new Set([...document.querySelectorAll(".manuscript[open]")].map((e) => e.dataset.name));
  const hadPanels = document.querySelectorAll(".manuscript").length > 0;
  $("results").innerHTML = parts.join("");
  if (hadPanels) {
    for (const d of document.querySelectorAll(".manuscript")) d.open = wasOpen.has(d.dataset.name) || openAll;
  }

  const xl = $("download-report");
  if (xl) xl.addEventListener("click", () => download("screening_report.xlsx", report,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  const wd = $("download-word");
  if (wd) wd.addEventListener("click", () => download("screening_report.docx", word,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => { shown[chip.dataset.sev] = !shown[chip.dataset.sev]; renderResults(); });
  }
  for (const b of document.querySelectorAll(".view-toggle button")) {
    b.addEventListener("click", () => {
      view = b.dataset.view;
      try { localStorage.setItem("gs-view", view); } catch (e) { /* storage unavailable */ }
      saveAccountData((d) => { d.view = view; });
      renderResults();
    });
  }
  const toggle = $("toggle-dismissed");
  if (toggle) toggle.addEventListener("click", () => { showDismissed = !showDismissed; renderResults(); });
  for (const b of document.querySelectorAll(".dismiss")) {
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const id = b.dataset.id;
      dismissed.has(id) ? dismissed.delete(id) : dismissed.add(id);
      renderResults();
      clearTimeout(timer);
      timer = setTimeout(runCheck, 400);        // rebuild the downloads without the dismissed items
    });
  }
}

// Saved profiles or preferences changed on another device
if (ACCOUNT) {
  ACCOUNT.onRemote("checker", () => { if (isReady) addMyProfiles(); });
  ACCOUNT.onChange(() => { if (isReady) { addMyProfiles(); markChanges(); } });
}
