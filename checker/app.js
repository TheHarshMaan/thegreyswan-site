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
const collapsed = new Set();   // result groups the reader has hidden
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
  if (window.GS_EVENT) window.GS_EVENT("checker-report");
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

let nextIsVersion = false;      // the next chosen file came from "Drop the new version"
async function addFiles(list, newVersion) {
  const all = [...list];
  const readable = all.filter((f) => READABLE.includes(extension(f.name)));
  const old = all.filter((f) => extension(f.name) === ".doc");
  if (!readable.length) {
    setStatus(old.length ? "Old Word .doc files can't be read. In Word, use File → Save As → .docx."
      : "Add Word (.docx), PDF, OpenDocument (.odt), RTF or LaTeX (.tex) files.", "error");
    return;
  }
  // A new version of a file already checked (same name, or dropped on "Drop the new version") keeps its ticks and
  // dismissals, and the report says what has changed since.
  const before = lastRun ? lastRun.results.filter((r) => !r.error) : [];
  const names = new Set(readable.map((f) => f.name));
  const renamed = !!newVersion && before.length === 1 && readable.length === 1 && !names.has(before[0].name);
  compareWith = null;
  if (before.some((r) => names.has(r.name)) || renamed) {
    compareWith = Object.fromEntries(before.map((r) => [r.name, r.issues.map((i) => i.key)]));
    if (renamed) Object.defineProperty(compareWith, "__renamed", { value: true });
  }
  const kept = [...dismissed];
  dismissed.clear();
  for (const id of kept) {
    const [name, key] = splitId(id);
    if (names.has(name)) dismissed.add(id);
    else if (renamed) dismissed.add(`${readable[0].name}|${key}`);
  }
  if (renamed && ticks[before[0].name]) { ticks[readable[0].name] = [...ticks[before[0].name]]; saveTicks(); }
  files = await Promise.all(readable.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
  runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const skipped = all.length - readable.length;
  if (skipped) setStatus(`${skipped} file(s) skipped: ${old.length ? "old .doc files must be saved as .docx; " : ""}`
    + "only .docx, .pdf, .odt, .rtf and .tex files can be checked.", "done");
  if (isReady) runCheck();
  else setStatus("Your files are ready; they will be checked as soon as the checker has loaded…", "busy");
}

const drop = $("dropzone");
$("more-btn").addEventListener("click", () => {
  const b = $("more-btn"), open = b.getAttribute("aria-expanded") !== "true";
  b.setAttribute("aria-expanded", String(open));
  $("more-settings").hidden = !open;
});

$("file-input").addEventListener("change", (e) => { addFiles(e.target.files, nextIsVersion); nextIsVersion = false; e.target.value = ""; });
drop.addEventListener("click", () => { nextIsVersion = false; });
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
  if (window.GS_EVENT) window.GS_EVENT("checker-run");
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
    checkReferences();
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
  if (issues.some((i) => i.rule === "extraction_failed")) return "Unable to screen";   // nothing was checked
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

// "Renumber the references…" becomes "Please renumber the references…", ready to paste into a decision letter
function asComment(fix) {
  const t = String(fix || "").trim();
  if (!t) return "";
  return /^please\b/i.test(t) ? t : "Please " + t.charAt(0).toLowerCase() + t.slice(1);
}

// Ticks: findings the author has marked as fixed. Kept in this browser only, per file name.
const TICKS_KEY = "gs-checker-ticks";
let ticks = {};
try { ticks = JSON.parse(localStorage.getItem(TICKS_KEY) || "{}") || {}; } catch (e) { ticks = {}; }
const isTicked = (name, key) => (ticks[name] || []).includes(key);
function saveTicks() {
  const names = Object.keys(ticks);
  for (const n of names.slice(0, Math.max(0, names.length - 40))) delete ticks[n];     // keep the 40 latest files
  try { localStorage.setItem(TICKS_KEY, JSON.stringify(ticks)); } catch (e) { /* storage unavailable */ }
}
function setTick(name, key, on) {
  const s = new Set(ticks[name] || []);
  on ? s.add(key) : s.delete(key);
  delete ticks[name];
  if (s.size) ticks[name] = [...s];
  saveTicks();
}
const splitId = (id) => { const cut = id.indexOf("|"); return [id.slice(0, cut), id.slice(cut + 1)]; };
const openItems = new Map();     // finding id -> details open?  (default: Must fix open)
const openGroups = new Map();    // "file|severity" -> open?      (default: Advisory folded away)
let uid = 0;

// Must fix and Should fix are what stand between the paper and Ready
function progressHtml(r) {
  const need = liveIssues(r).filter((i) => i.severity !== "advisory");
  if (!need.length) return "";
  const done = need.filter((i) => isTicked(r.name, i.key)).length, left = need.length - done;
  return `<div class="bar" role="img" aria-label="${done} of ${need.length} fixed"><span style="width: ${Math.round(100 * done / need.length)}%"></span></div>
    <span class="bar-text">${left ? `<b>${done} of ${need.length} fixed</b> · ${left} to go before it’s ready to submit`
      : `<b>All ${need.length} ticked off.</b> Drop the edited file to confirm it’s ready.`}</span>`;
}

function checklistItem(r, i) {
  const id = `${r.name}|${i.key}`, n = ++uid;
  const isGone = dismissed.has(id), done = isTicked(r.name, i.key);
  const open = openItems.has(id) ? openItems.get(id) : i.severity === "must" && !done && !isGone;
  const comment = asComment(i.fix);
  return `<li class="cl-item${done ? " done" : ""}${isGone ? " gone" : ""}${open ? " open" : ""}" data-id="${escapeHtml(id)}">
    <div class="cl-top">
      <input type="checkbox" class="tick" id="tick-${n}" aria-label="Fixed: ${escapeHtml(i.check)}" ${done ? "checked" : ""} ${isGone ? "disabled" : ""}>
      <label for="tick-${n}" class="cl-label"><span class="cl-title">${escapeHtml(i.check)}</span>
        <span class="cl-sub">${escapeHtml(i.section)}</span><span class="cl-preview">${escapeHtml(i.details)}</span></label>
      <button type="button" class="text-button cl-toggle" aria-expanded="${open}" aria-controls="body-${n}">${open ? "Hide" : "Details"}</button>
    </div>
    <div class="cl-body" id="body-${n}" ${open ? "" : "hidden"}>
      <p class="cl-found">${escapeHtml(i.details)}</p>
      ${i.fix ? `<div class="howfix"><span class="howfix-label">How to fix</span><span>${escapeHtml(i.fix)}</span></div>` : ""}
      <div class="cl-foot">${i.source && i.source !== "—" ? `<span class="source">Source: ${escapeHtml(i.source)}</span>` : ""}
        <span class="cl-actions">${comment && !isGone
          ? `<button type="button" class="text-button copy-comment" data-comment="${escapeHtml(comment)}">Copy as a comment</button>` : ""}
        <button type="button" class="text-button dismiss" data-id="${escapeHtml(id)}">${isGone ? "Restore" : "Not a problem here"}</button></span></div>
    </div></li>`;
}

// Author view: a to-do list, most serious first, with the optional suggestions folded away
function checklist(r, visible) {
  return ["must", "should", "advisory"].map((sev) => {
    const items = visible.filter((i) => i.severity === sev);
    if (!items.length) return "";
    const n = items.length, gid = `${r.name}|${sev}`;
    const list = (hide) => `<ul class="checklist" ${hide ? "hidden" : ""}>${items.map((i) => checklistItem(r, i)).join("")}</ul>`;
    const pill = `<span class="pill">${escapeHtml(LABELS[sev])}</span>`;
    if (sev === "advisory") {
      const open = openGroups.get(gid) === true;
      return `<section class="cl-group sev-advisory optional"><div class="cl-head">${pill}
          <span class="cl-note">${n} optional suggestion${n > 1 ? "s" : ""}. ${n > 1 ? "They don’t" : "It doesn’t"} stop the paper being ready.</span>
          <button type="button" class="button ghost cl-group-toggle" data-gid="${escapeHtml(gid)}" aria-expanded="${open}">${open ? "Hide suggestions" : "Show suggestions"}</button></div>
        ${list(!open)}</section>`;
    }
    return `<section class="cl-group sev-${sev}"><div class="cl-head">${pill}<span class="gcount" data-n="${n}"></span></div>${list(false)}</section>`;
  }).join("");
}

function refreshProgress(panel) {
  const r = lastRun.results.find((x) => x.name === panel.dataset.name);
  const box = panel.querySelector(".cl-progress");
  if (r && box) box.innerHTML = progressHtml(r);
  for (const g of panel.querySelectorAll(".cl-head .gcount")) {
    const n = +g.dataset.n, fixed = g.closest(".cl-group").querySelectorAll(".cl-item.done").length;
    g.textContent = `${n} finding${n > 1 ? "s" : ""}${fixed ? ` · ${fixed} fixed` : ""}`;
  }
}

function issueRow(r, i) {          // editor view: one line of the screening log
  const id = `${r.name}|${i.key}`;
  const isGone = dismissed.has(id);
  return `<tr class="${isGone ? "gone" : ""}"><td data-label="Finding"><span class="finding-name">${escapeHtml(i.check)}</span></td>
    <td class="sev sev-${i.severity}" data-label="Severity">${escapeHtml(LABELS[i.severity])}</td>
    <td data-label="Status">${escapeHtml(i.status)}</td>
    <td data-label="Details">${escapeHtml(i.details)}</td>
    <td class="act"><button type="button" class="dismiss" data-id="${escapeHtml(id)}" title="${isGone ? "Restore" : "Dismiss as a false alarm"}"
      aria-label="${isGone ? "Restore" : "Dismiss"} ${escapeHtml(i.check)}">${isGone ? "↺" : "×"}</button></td></tr>`;
}

// Editor view: one table per file, section by section
function findingsTable(r, visible) {
  const groups = [];
  for (const i of visible) {
    let g = groups.find((x) => x.key === i.section);
    if (!g) groups.push(g = { key: i.section, items: [] });
    g.items.push(i);
  }
  const body = groups.map((g) => {
    const gid = `${r.name}|editor|${g.key}`, shut = collapsed.has(gid), n = g.items.length;
    return `<tbody><tr class="group section"><th colspan="5" scope="colgroup">
        <span class="pill">${escapeHtml(g.key)}</span><span class="gcount">${n} finding${n > 1 ? "s" : ""}</span>
        <button type="button" class="text-button group-toggle" data-gid="${escapeHtml(gid)}" aria-expanded="${!shut}">${shut ? "Show" : "Hide"}</button></th></tr>
      ${shut ? "" : g.items.map((i) => issueRow(r, i)).join("")}</tbody>`;
  }).join("");
  return `<div class="table-wrap"><table class="findings editor"><thead><tr><th class="col-finding">Check</th><th>Severity</th><th>Status</th>
    <th>Details</th><th><span class="sr-only">Dismiss</span></th></tr></thead>${body}</table></div>`;
}

// After a new version of a file is dropped in: what has gone and what is new
let compareWith = null;        // {file name: [finding keys]} from the run before
function versionNote(readable) {
  if (!compareWith) return "";
  const prevNames = Object.keys(compareWith);
  let fixed = 0, fresh = 0, matched = 0;
  for (const r of readable) {
    const prev = compareWith[r.name] || (compareWith.__renamed && readable.length === 1 ? compareWith[prevNames[0]] : null);
    if (!prev) continue;
    matched += 1;
    const now = new Set(r.issues.map((i) => i.key));
    fixed += prev.filter((k) => !now.has(k)).length;
    fresh += [...now].filter((k) => !prev.includes(k)).length;
  }
  if (!matched) return "";
  const text = !fixed && !fresh ? "the findings are the same as before."
    : `<b>${fixed} finding${fixed === 1 ? "" : "s"} fixed</b>${fresh ? `, ${fresh} new` : ""}.`;
  return `<p class="version-note" role="status">Since the last version: ${text}</p>`;
}

function renderResults() {
  const { results, report, word, profileName } = lastRun;
  const readable = results.filter((r) => !r.error);
  const ready = readable.filter((r) => verdictOf(liveIssues(r)) === "Ready").length;
  const openAll = results.length === 1;
  const goneCount = [...dismissed].length;
  const author = view === "author";
  const all = { must: 0, should: 0, advisory: 0 };
  readable.forEach((r) => { const c = countsOf(liveIssues(r)); for (const k in all) all[k] += c[k]; });
  const downloads = `${report ? '<button type="button" class="button ghost" id="download-report">Excel report</button>' : ""}
      ${word ? '<button type="button" class="button ghost" id="download-word">Word report</button>' : ""}`;
  uid = 0;

  const parts = [`<div class="results-head"><h2>Results</h2>${author ? "" : `<div class="downloads">${downloads}</div>`}</div>
    <p class="muted small">Checked against: ${escapeHtml(profileName)} · ${results.length} file(s):
      ${ready} ready, ${readable.length - ready} need revision${results.length > readable.length
        ? `, ${results.length - readable.length} could not be read` : ""}.</p>
    ${versionNote(readable)}
    <div class="toolbar">
      <div class="view-toggle" role="group" aria-label="Report view">
        <button type="button" data-view="author" aria-pressed="${author}">Author view</button>
        <button type="button" data-view="editor" aria-pressed="${!author}">Editor view</button>
      </div>
      ${author ? "" : `<div class="filters" role="group" aria-label="Show severities">
        ${["must", "should", "advisory"].map((s) =>
          `<button type="button" class="chip sev-${s}" data-sev="${s}" aria-pressed="${shown[s]}"><span class="dot" aria-hidden="true"></span>${escapeHtml(LABELS[s])} · ${all[s]}</button>`).join("")}
      </div>`}
      ${goneCount ? `<button type="button" class="text-button" id="toggle-dismissed">${goneCount} dismissed · ${showDismissed ? "hide" : "show"}</button>` : ""}
    </div>
    <div class="results-grid${author ? " with-aside" : ""}"><div class="results-main">`];

  for (const r of results) {
    if (r.error) {
      parts.push(`<details class="manuscript"><summary><span class="fname">${escapeHtml(r.name)}</span>
        <span class="verdict error">${escapeHtml(r.error)}</span></summary>
        <p class="empty">Check that it is a valid .docx, .pdf, .odt, .rtf or .tex file.</p></details>`);
      continue;
    }
    const live = liveIssues(r);
    const v = verdictOf(live), isReadyDoc = v === "Ready";
    const visible = r.issues.filter((i) => (author || shown[i.severity]) && (showDismissed || !dismissed.has(`${r.name}|${i.key}`)));
    const body = !r.issues.length ? '<p class="empty">All checks passed.</p>'
      : !visible.length ? '<p class="empty muted">Nothing to show at the selected severities.</p>'
      : author ? `<div class="cl-progress">${progressHtml(r)}</div>${checklist(r, visible)}`
      : findingsTable(r, visible);
    parts.push(`<details class="manuscript" ${openAll ? "open" : ""} data-name="${escapeHtml(r.name)}"><summary>
        <span class="fname">${escapeHtml(r.name)}</span>${tagFor(r.info)}
        <span class="verdict ${isReadyDoc ? "ready" : v === "Unable to screen" ? "error" : "revise"}">${v}</span>
        ${live.length ? `<span class="tally">${tally(countsOf(live))}</span>` : ""}</summary>${body}</details>`);
  }
  parts.push("</div>");
  if (author) {
    parts.push(`<aside class="next" aria-label="Next steps">
      <div class="next-card"><h3 class="step-label">Fixed it in Word?</h3>
        <label class="redrop" id="redrop" for="file-input"><strong>Drop the new version</strong>
          <span>The list updates by itself and shows what’s now fixed.</span></label></div>
      <div class="next-card"><h3 class="step-label">Take it with you</h3>${downloads}
        <button type="button" class="button ghost" id="copy-all">Copy all comments</button>
        <p class="muted small" id="copy-all-note">Every Must fix and Should fix, as “Please…” lines.</p></div>
    </aside>`);
  }
  parts.push("</div>");

  // keep open/closed panels as they were when the results refresh
  const wasOpen = new Set([...document.querySelectorAll(".manuscript[open]")].map((e) => e.dataset.name));
  const hadPanels = document.querySelectorAll(".manuscript").length > 0;
  $("results").innerHTML = parts.join("");
  if (hadPanels) {
    for (const d of document.querySelectorAll(".manuscript")) d.open = wasOpen.has(d.dataset.name) || openAll;
  }
  for (const d of document.querySelectorAll(".manuscript[data-name]")) refreshProgress(d);
  $("report-step").hidden = true;
  drop.classList.add("compact");

  const xl = $("download-report");
  if (xl) xl.addEventListener("click", () => download("screening_report.xlsx", report,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  const wd = $("download-word");
  if (wd) wd.addEventListener("click", () => download("screening_report.docx", word,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  const copyText = (text, done) => (navigator.clipboard ? navigator.clipboard.writeText(text).then(() => done(true), () => done(false)) : done(false));
  for (const chip of $("results").querySelectorAll(".chip")) {
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
  for (const b of document.querySelectorAll(".group-toggle")) {
    b.addEventListener("click", () => { const g = b.dataset.gid; collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); renderResults(); });
  }
  for (const t of document.querySelectorAll(".tick")) {
    t.addEventListener("change", () => {
      const li = t.closest(".cl-item"), [name, key] = splitId(li.dataset.id);
      setTick(name, key, t.checked);
      li.classList.toggle("done", t.checked);
      refreshProgress(li.closest(".manuscript"));
    });
  }
  for (const b of document.querySelectorAll(".cl-toggle")) {
    b.addEventListener("click", () => {
      const li = b.closest(".cl-item"), body = li.querySelector(".cl-body"), open = body.hidden;
      body.hidden = !open;
      li.classList.toggle("open", open);
      b.setAttribute("aria-expanded", String(open));
      b.textContent = open ? "Hide" : "Details";
      openItems.set(li.dataset.id, open);
    });
  }
  for (const b of document.querySelectorAll(".cl-group-toggle")) {
    b.addEventListener("click", () => {
      const list = b.closest(".cl-group").querySelector(".checklist"), open = list.hidden;
      list.hidden = !open;
      b.setAttribute("aria-expanded", String(open));
      b.textContent = open ? "Hide suggestions" : "Show suggestions";
      openGroups.set(b.dataset.gid, open);
    });
  }
  for (const b of document.querySelectorAll(".copy-comment")) {
    b.addEventListener("click", () => copyText(b.dataset.comment, (ok) => {
      b.textContent = ok ? "Copied" : "Couldn’t copy"; setTimeout(() => { b.textContent = "Copy as a comment"; }, 1600);
    }));
  }
  const copyAll = $("copy-all");
  if (copyAll) copyAll.addEventListener("click", () => {
    const blocks = readable.map((r) => {
      const lines = liveIssues(r).filter((i) => i.severity !== "advisory" && i.fix).map((i) => "- " + asComment(i.fix));
      return lines.length ? (readable.length > 1 ? r.name + "\n" : "") + lines.join("\n") : "";
    }).filter(Boolean);
    if (!blocks.length) { $("copy-all-note").textContent = "Nothing to copy: no Must fix or Should fix findings."; return; }
    copyText(blocks.join("\n\n"), (ok) => { $("copy-all-note").textContent = ok ? "Copied." : "Couldn’t copy from this browser."; });
  });
  const redrop = $("redrop");
  if (redrop) {
    redrop.addEventListener("click", () => { nextIsVersion = true; });
    redrop.addEventListener("dragover", (e) => { e.preventDefault(); redrop.classList.add("over"); });
    redrop.addEventListener("dragleave", () => redrop.classList.remove("over"));
    redrop.addEventListener("drop", (e) => { e.preventDefault(); redrop.classList.remove("over"); addFiles(e.dataTransfer.files, true); });
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

// ---------------------------------------------------------------------------
// References: verified against Crossref and Retraction Watch in the same report (refcore.js)
// ---------------------------------------------------------------------------
let refRunId = null;
const refChecker = window.GSRefCheck ? GSRefCheck({
  rpc, root: $("refs-results"), note: $("retraction-note"),
  status: (text, kind) => {
    const line = $("refs-status");
    line.textContent = text;
    line.className = "refs-status" + (kind === "error" ? " error" : "");
  },
}) : null;

// The manuscript among the files checked: the first one read as a manuscript (not a cover letter or title page)
function manuscriptFile() {
  if (!lastRun) return null;
  const readable = lastRun.results.filter((r) => !r.error);
  const main = readable.find((r) => !r.info || !r.info.role || r.info.role === "manuscript") || readable[0];
  return main ? files.find((f) => f.name === main.name) || null : null;
}

// Once per set of files (changing the profile re-screens, but the references stay the same)
function checkReferences() {
  if (!refChecker) return;
  const box = $("refs-section");
  if (!$("verify-refs").checked) { box.hidden = true; return; }
  box.hidden = false;
  if (refRunId === runId || refChecker.isRunning()) return;
  const file = manuscriptFile();
  if (!file) { box.hidden = true; return; }
  refRunId = runId;
  refChecker.run([file], "", file.name);
}
if ($("verify-refs")) $("verify-refs").addEventListener("change", () => { if (lastRun) checkReferences(); else $("refs-section").hidden = true; });


// ---------------------------------------------------------------------------
// A paper sent from Studio ("Full check"): check it straight away
// ---------------------------------------------------------------------------
(function fromStudio() {
  const params = new URLSearchParams(location.search);
  if (params.get("from") !== "studio" || !window.indexedDB) return;
  const req = indexedDB.open("gs-handoff", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("files");
  req.onsuccess = () => {
    const tx = req.result.transaction("files", "readwrite"), st = tx.objectStore("files"), get = st.get("studio");
    get.onsuccess = () => {
      const rec = get.result;
      st.delete("studio");
      if (!rec || Date.now() - (rec.at || 0) > 10 * 60 * 1000) return;
      addFiles([new File([rec.data], rec.name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]);
      params.delete("from");
      history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : ""));
    };
  };
})();
