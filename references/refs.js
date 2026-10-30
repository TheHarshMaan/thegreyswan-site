// The Grey Swan Editorial: Reference Integrity Checker (website)
// Python (worker.js + refcheck.py) reads the references and decides each verdict; this page asks Crossref.

const params = new URLSearchParams(location.search);
const workerParams = new URLSearchParams();
if (params.get("pyodide")) workerParams.set("pyodide", params.get("pyodide"));       // for local testing
const worker = new Worker(`worker.js${workerParams.toString() ? "?" + workerParams : ""}`);
const RETRACTION_URLS = params.get("retractions") ? [params.get("retractions")] : [
  "https://raw.githubusercontent.com/TheHarshMaan/manuscript-checker/retraction-data/retractions.json.gz",
  "https://cdn.jsdelivr.net/gh/TheHarshMaan/manuscript-checker@retraction-data/retractions.json.gz",
];

// ---------------------------------------------------------------------------
// Talking to the worker
// ---------------------------------------------------------------------------
let nextId = 1, isReady = false;
const pending = new Map();
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
  if (msg.type === "ready") { isReady = true; return setStatus("Ready. Add a manuscript or paste a reference list.", "done"); }
  if (msg.type === "failed") return setStatus(`The checker could not start: ${msg.error}. Try reloading the page.`, "error");
  const job = pending.get(msg.id);
  if (!job) return;
  pending.delete(msg.id);
  msg.ok ? job.resolve(msg.result) : job.reject(new Error(msg.error));
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setStatus(text, kind) {
  $("status").className = "status" + (kind === "error" ? " error done" : kind === "done" ? " done" : "");
  $("status-text").textContent = text;
}
function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function linkify(text) {
  // DOIs can contain brackets, e.g. 10.1016/s0140-6736(10)60175-4: keep balanced ones, drop a closing one that ends a phrase
  return escapeHtml(text).replace(/https:\/\/doi\.org\/\S+/g, (match) => {
    let url = match, tail = "";
    while (/[.,;:]$/.test(url) || (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    return `<a href="${url}" target="_blank" rel="noopener">${url}</a>${tail}`;
  });
}
const withoutNumber = (text) => text.replace(/^\s*\[?\d+[.)\]]?\s+/, "");
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// The Retraction Watch list (rebuilt every day on GitHub)
// ---------------------------------------------------------------------------
let retractions = null;          // {doi: [[code, date, notice DOI], …]}
const retractionsReady = (async () => {
  for (const url of RETRACTION_URLS) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {            // gzip: unpack it here
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
      } else {
        text = new TextDecoder().decode(bytes);                // already unpacked by the server
      }
      const data = JSON.parse(text);
      retractions = data.notices;
      $("retraction-note").textContent = `Retraction Watch list of ${data.count.toLocaleString()} papers with notices, ` +
        `updated ${data.built}. Crossref's own notices are checked too.`;
      return;
    } catch (e) { /* try the next copy */ }
  }
  $("retraction-note").textContent = "The Retraction Watch list couldn't be loaded; retractions are checked with Crossref's notices instead.";
})();

// ---------------------------------------------------------------------------
// Polite Crossref requests: at most ~8 record lookups and ~2.5 searches a second, 3 at a time
// ---------------------------------------------------------------------------
let API = params.get("crossref") || "https://api.crossref.org/works";
let FIELDS = "", CONTACT = "";
const gap = { single: 130, list: 400 };
const nextAt = { single: 0, list: 0 };
async function slot(kind) {
  const now = Date.now();
  const at = Math.max(now, nextAt[kind]);
  nextAt[kind] = at + gap[kind];
  if (at > now) await sleep(at - now);
}
function doiPath(doi) {
  return encodeURIComponent(doi).replace(/%2F/gi, "/").replace(/%28/g, "(").replace(/%29/g, ")");
}
async function getJSON(url, kind) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await slot(kind);
    let response;
    try {
      response = await fetch(url);
    } catch (e) {
      if (attempt === 2) return { status: 0 };
      await sleep(1500);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 2) return { status: response.status };
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!response.ok) return { status: response.status };
    return { status: 200, data: await response.json() };
  }
  return { status: 0 };
}
const withContact = (url) => url + (url.includes("?") ? "&" : "?") + `mailto=${encodeURIComponent(CONTACT)}`;
async function search(ref) {
  const r = await getJSON(withContact(`${API}?query.bibliographic=${encodeURIComponent(ref.query)}&rows=3&select=${FIELDS}`), "list");
  return r.status === 200 ? r.data.message.items : null;
}
async function updates(doi) {
  const r = await getJSON(withContact(`${API}?filter=updates:${doiPath(doi)}&rows=10`), "list");
  return r.status === 200 ? r.data.message.items : null;
}

// One reference: ask Crossref what's needed, then let the Python decide
async function checkOne(ref) {
  let record = null, status = null, items = null;
  if (ref.doi) {
    const r = await getJSON(withContact(`${API}/${doiPath(ref.doi)}`), "single");
    status = r.status;
    record = r.data ? r.data.message : null;
    if (status === 404) items = await search(ref);
  } else {
    items = await search(ref);
    if (items === null) return { n: ref.n, text: ref.text, status: "error", label: "Couldn't check", severity: "info",
                                 details: "Crossref didn't answer the search", fix: "Try again later.", doi: null };
  }
  const assess = async (doi, ups) => JSON.parse(await rpc("refs_assess", JSON.stringify(ref), JSON.stringify(record),
    status === null ? "" : String(status), items === null ? "" : JSON.stringify(items),
    JSON.stringify(retractions && doi ? retractions[doi] || [] : []), ups ? JSON.stringify(ups) : ""));
  let result = await assess(status === 200 ? ref.doi : null, null);
  if (result.doi && result.doi !== ref.doi && retractions) result = await assess(result.doi, null);   // a DOI we found
  if (result.doi && !retractions && !["error", "doi_not_found", "not_found", "not_checked"].includes(result.status)) {
    result = await assess(result.doi, await updates(result.doi));        // no list: ask Crossref for notices
  }
  return result;
}

// ---------------------------------------------------------------------------
// Running a check
// ---------------------------------------------------------------------------
const LABELS = { must: "Must fix", should: "Should fix", advisory: "Advisory", info: "Not checked", ok: "Verified" };
const RANK = { must: 0, should: 1, advisory: 2, info: 3, ok: 4 };
const shown = { must: true, should: true, advisory: true, info: true, ok: true };
let refs = [], results = {}, sourceName = "", running = false, sortBySeverity = false;

async function run(files, text) {
  if (running) return;
  if (!isReady) { setStatus("Still loading the checker; try again in a moment.", "busy"); return; }
  running = true;
  results = {};
  try {
    const out = JSON.parse(await rpc("refs_extract", files, text));
    refs = out.references;
    if (!params.get("crossref")) API = out.api;
    FIELDS = out.fields; CONTACT = out.contact;
  } catch (e) {
    running = false;
    setStatus(`Couldn't read that file: ${e.message.split("\n").pop()}`, "error");
    return;
  }
  if (!refs.length) {
    running = false;
    setStatus("No references found. Is there a 'References' heading? You can also paste the list.", "error");
    $("results").innerHTML = "";
    return;
  }
  await retractionsReady;
  setStatus(`Checking ${refs.length} references against Crossref…`, "busy");
  render();
  const queue = [...refs];
  const lane = async () => {
    while (queue.length) {
      const ref = queue.shift();
      try {
        results[ref.n] = await checkOne(ref);
      } catch (e) {
        results[ref.n] = { n: ref.n, text: ref.text, status: "error", label: "Couldn't check", severity: "info",
                           details: e.message.split("\n").pop(), fix: "Try again later.", doi: ref.doi };
      }
      render();
    }
  };
  await Promise.all([lane(), lane(), lane()]);
  running = false;
  const all = refs.map((r) => results[r.n]);
  const errors = all.filter((r) => r.status === "error").length;
  setStatus(errors === all.length ? "Crossref couldn't be reached. Check your internet connection and try again."
    : errors ? `Done, but ${errors} reference(s) couldn't be checked: try again later for those.` : "Done.",
    errors === all.length ? "error" : "done");
  render();
}

function render() {
  const done = refs.filter((r) => results[r.n]);
  const all = done.map((r) => results[r.n]);
  const count = (sev) => all.filter((r) => r.severity === sev).length;
  const problems = count("must") + count("should");
  const finished = done.length === refs.length && !running;
  let rows = refs.map((r) => results[r.n] || { n: r.n, text: r.text, pending: true });
  if (sortBySeverity && finished) rows = [...rows].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.n - b.n);
  rows = rows.filter((r) => r.pending || shown[r.severity]);

  const html = [`<div class="results-head"><h2>References</h2><div class="downloads">
      ${finished ? '<button type="button" class="button ghost" id="dl-xlsx">Excel report</button>' +
        '<button type="button" class="button ghost" id="dl-docx">Word report</button>' : ""}</div></div>
    <div class="progress" aria-hidden="true"><div style="width:${Math.round(100 * done.length / refs.length)}%"></div></div>
    <p class="muted small">${sourceName ? escapeHtml(sourceName) + " · " : ""}${done.length} of ${refs.length} checked
      ${finished ? ` · <b class="${problems ? "verdict revise" : "verdict ready"}">${problems ? "Needs revision" : "No problems found"}</b>` : ""}</p>
    <div class="counts">
      ${count("must") ? `<span class="count sev-must"><b>${count("must")}</b>retracted</span>` : ""}
      ${count("should") ? `<span class="count sev-should"><b>${count("should")}</b>to fix</span>` : ""}
      ${count("advisory") ? `<span class="count sev-advisory"><b>${count("advisory")}</b>advisory</span>` : ""}
      ${count("ok") ? `<span class="count sev-ok"><b>${count("ok")}</b>verified</span>` : ""}
      ${count("info") ? `<span class="count sev-info"><b>${count("info")}</b>not checked</span>` : ""}
    </div>
    <div class="toolbar">
      <div class="filters" role="group" aria-label="Show results">
        ${["must", "should", "advisory", "ok", "info"].map((s) =>
          `<button type="button" class="chip sev-${s}" data-sev="${s}" aria-pressed="${shown[s]}">${LABELS[s]}</button>`).join("")}
      </div>
      ${finished ? `<button type="button" class="text-button" id="sort">${sortBySeverity ? "In reference order" : "Most serious first"}</button>` : ""}
    </div>
    <div class="table-wrap"><table class="reftable"><thead><tr><th>#</th><th>Reference</th><th>Result</th><th>Details and what to do</th></tr></thead><tbody>`];
  for (const r of rows) {
    html.push(`<tr><td class="num" data-label="#">${r.n}</td>
      <td class="ref" data-label="Reference"><span class="clip" title="Click to show it all">${escapeHtml(withoutNumber(r.text))}</span></td>
      ${r.pending ? '<td class="res pending" data-label="Result">Checking…</td><td class="det" data-label="Details"></td>'
        : `<td class="res sev-${r.severity}" data-label="Result">${escapeHtml(r.label)}</td>
           <td class="det" data-label="Details">${linkify(r.details)}${r.fix ? `<span class="fix">${linkify(r.fix)}</span>` : ""}</td>`}</tr>`);
  }
  html.push("</tbody></table></div>");
  $("results").innerHTML = html.join("");

  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => { shown[chip.dataset.sev] = !shown[chip.dataset.sev]; render(); });
  }
  for (const clip of document.querySelectorAll(".clip")) clip.addEventListener("click", () => clip.classList.toggle("open"));
  const sort = $("sort");
  if (sort) sort.addEventListener("click", () => { sortBySeverity = !sortBySeverity; render(); });
  const report = async (kind) => {
    const out = await rpc("refs_report", JSON.stringify(refs.map((r) => results[r.n])), sourceName || "Pasted references");
    kind === "xlsx" ? download("reference_report.xlsx", out.report, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      : download("reference_report.docx", out.word, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  };
  if ($("dl-xlsx")) $("dl-xlsx").addEventListener("click", () => report("xlsx"));
  if ($("dl-docx")) $("dl-docx").addEventListener("click", () => report("docx"));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const READABLE = [".docx", ".pdf", ".odt", ".rtf", ".tex", ".txt"];
async function useFile(file) {
  if (!file) return;
  const ext = (file.name.toLowerCase().match(/\.[a-z0-9]+$/) || [""])[0];
  if (!READABLE.includes(ext)) {
    setStatus(ext === ".doc" ? "Old Word .doc files can't be read. In Word, use File → Save As → .docx."
      : "Add a Word, PDF, OpenDocument, RTF, LaTeX or .txt file.", "error");
    return;
  }
  sourceName = file.name;
  run([{ name: file.name, data: await file.arrayBuffer() }], "");
}
const drop = $("dropzone");
$("file-input").addEventListener("change", (e) => { useFile(e.target.files[0]); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); useFile(e.dataTransfer.files[0]); });
$("check-paste").addEventListener("click", () => {
  const text = $("paste").value.trim();
  if (!text) { setStatus("Paste some references first.", "error"); return; }
  sourceName = "";
  run([], text);
});
