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
let baseProfile = null;        // the profile as chosen or loaded, before the visitor's adjustments
let uploadedProfile = null;    // a profile file the visitor loaded, if any
let files = [];                // [{name, data: ArrayBuffer}]
let lastRun = null;            // {results, report}
const shown = { must: true, should: true, advisory: true };

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

  const select = $("profile-select");
  select.innerHTML = cat.profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  select.disabled = false;
  buildRuleList();
  await chooseProfile(select.value);

  isReady = true;
  setStatus("Ready. Choose your journal's profile, then add manuscripts.", "done");
  if (files.length) runCheck();
}

function buildRuleList() {
  let area = null;
  const html = [];
  for (const r of RULES) {
    if (r.area !== area) {
      area = r.area;
      html.push(`<div class="rule-area">${escapeHtml(area)}</div>`);
    }
    const options = SEVERITIES.map((s) => `<option value="${s}">${escapeHtml(LABELS[s])}</option>`).join("");
    html.push(`<label class="rule" id="row-${r.id}" title="${escapeHtml(r.what)}">
      <span><span class="name">${escapeHtml(r.label)}</span><span class="what">${escapeHtml(r.what)}</span></span>
      <select data-rule="${r.id}" aria-label="${escapeHtml(r.label)}">${options}</select></label>`);
  }
  $("rules-list").innerHTML = html.join("");
}

function fillForm(profile) {
  const s = profile.settings || {};
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

// The profile the visitor is checking with: the base profile plus whatever they changed
function currentProfile() {
  const p = structuredClone(baseProfile);
  p.settings = Object.assign({}, p.settings, {
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
  const adjusted = isAdjusted();
  $("save-profile").hidden = !adjusted;
  $("reset-profile").hidden = !adjusted;
}

let timer = null;
function settingsChanged() {
  markChanges();
  clearTimeout(timer);
  timer = setTimeout(() => { if (files.length) runCheck(); }, 350);
}

$("profile-select").addEventListener("change", async (e) => {
  if (e.target.value === "__uploaded__") {
    baseProfile = uploadedProfile;
    fillForm(baseProfile);
  } else {
    await chooseProfile(e.target.value);
  }
  if (files.length) runCheck();
});

for (const id of ["abstract-limit", "cutoff", "ignore", "skip-symbols"]) {
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
async function addFiles(list) {
  const docx = [...list].filter((f) => f.name.toLowerCase().endsWith(".docx"));
  const skipped = list.length - docx.length;
  if (!docx.length) {
    setStatus("Only .docx files can be checked. In Word, use File → Save As → .docx.", "error");
    return;
  }
  files = await Promise.all(docx.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
  if (skipped) setStatus(`${skipped} file(s) skipped: only .docx files can be checked.`, "done");
  if (isReady) runCheck();
  else setStatus("Your files are ready; they will be checked as soon as the checker has loaded…", "busy");
}

const drop = $("dropzone");
$("file-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });

let running = false, again = false;
async function runCheck() {
  if (running) { again = true; return; }
  running = true;
  setStatus(`Checking ${files.length} manuscript(s)…`, "busy");
  try {
    const profile = currentProfile();
    lastRun = await rpc("check", files, JSON.stringify(profile));
    lastRun.profileName = profile.name;
    renderResults();
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

function renderResults() {
  const { results, report, profileName } = lastRun;
  const readable = results.filter((r) => !r.error);
  const ready = readable.filter((r) => r.verdict === "Ready").length;
  const openAll = results.length === 1;

  const parts = [`<div class="results-head"><h2>Results</h2>
    ${report ? '<button type="button" class="button ghost" id="download-report">Download Excel report</button>' : ""}</div>
    <p class="muted small">Checked against: ${escapeHtml(profileName)} · ${results.length} file(s):
      ${ready} ready, ${readable.length - ready} need revision${results.length > readable.length ? `, ${results.length - readable.length} could not be read` : ""}.</p>
    <div class="filters" role="group" aria-label="Show severities">
      ${["must", "should", "advisory"].map((s) =>
        `<button type="button" class="chip sev-${s}" data-sev="${s}" aria-pressed="${shown[s]}">${escapeHtml(LABELS[s])}</button>`).join("")}
    </div>`];

  for (const r of results) {
    if (r.error) {
      parts.push(`<details class="manuscript"><summary><span class="fname">${escapeHtml(r.name)}</span>
        <span class="verdict error">${escapeHtml(r.error)}</span></summary>
        <p class="empty">Make sure it is a valid .docx file.</p></details>`);
      continue;
    }
    const isReadyDoc = r.verdict === "Ready";
    const rows = r.issues.filter((i) => shown[i.severity]).map((i) => `<tr>
        <td class="section" data-label="Section">${escapeHtml(i.section)}</td>
        <td class="sev sev-${i.severity}" data-label="Severity">${escapeHtml(LABELS[i.severity])}</td>
        <td data-label="Check">${escapeHtml(i.check)}</td>
        <td data-label="Status">${escapeHtml(i.status)}</td><td data-label="Details">${escapeHtml(i.details)}</td></tr>`).join("");
    const body = !r.issues.length ? '<p class="empty">All checks passed.</p>'
      : rows ? `<div class="table-wrap"><table><thead><tr><th>Section</th><th>Severity</th><th>Check</th>
          <th>Status</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="empty muted">Nothing at the selected severities.</p>';
    parts.push(`<details class="manuscript" ${openAll ? "open" : ""}><summary>
        <span class="fname">${escapeHtml(r.name)}</span>
        <span class="verdict ${isReadyDoc ? "ready" : "revise"}">${isReadyDoc ? "Ready" : "Needs revision"}</span>
        ${r.issues.length ? `<span class="tally">${tally(r.counts)}</span>` : ""}</summary>${body}</details>`);
  }

  // keep open/closed panels as they were when the results refresh
  const wasOpen = new Set([...document.querySelectorAll(".manuscript[open] .fname")].map((e) => e.textContent));
  $("results").innerHTML = parts.join("");
  if (wasOpen.size) {
    for (const d of document.querySelectorAll(".manuscript")) {
      d.open = wasOpen.has(d.querySelector(".fname").textContent);
    }
  }

  const btn = $("download-report");
  if (btn) btn.addEventListener("click", () => download("screening_report.xlsx", report,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => { shown[chip.dataset.sev] = !shown[chip.dataset.sev]; renderResults(); });
  }
}
