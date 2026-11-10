// The Grey Swan Editorial: Reference Integrity Checker (website)
// The checking itself is in refcore.js (shared with the manuscript checker); this file wires up the page.

const params = new URLSearchParams(location.search);
const workerParams = new URLSearchParams();
if (params.get("pyodide")) workerParams.set("pyodide", params.get("pyodide"));       // for local testing
const worker = new Worker(`worker.js${workerParams.toString() ? "?" + workerParams : ""}`);

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
  if (msg.type === "ready") { isReady = true; if (!refs.length) setStatus("Ready. Add a manuscript or paste a reference list.", "done"); return; }
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
// ---------------------------------------------------------------------------
// The check itself lives in refcore.js, shared with the manuscript checker's References section
// ---------------------------------------------------------------------------
let running = false;
const checker = GSRefCheck({
  rpc, root: $("results"), note: $("retraction-note"),
  doneWord: "Done",
  status: (text, kind) => { running = kind === "busy"; setStatus(text, kind); },
  onDone: (all, name) => recordCheck(all, name),
});
checker.preload().then(() => { $("retraction-note").textContent = checker.retractionsNote(); });
let refs = [];
function run(files, text, name) {
  if (!isReady) { setStatus("Still loading the checker; try again in a moment.", "busy"); return; }
  if (checker.isRunning()) return;
  refs = [1];
  checker.run(files, text, name);
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
  run([{ name: file.name, data: await file.arrayBuffer() }], "", file.name);
}
const drop = $("dropzone");
$("file-input").addEventListener("change", (e) => { useFile(e.target.files[0]); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); useFile(e.dataTransfer.files[0]); });
$("check-paste").addEventListener("click", () => {
  const text = $("paste").value.trim();
  if (!text) { setStatus("Paste some references first.", "error"); return; }
  run([], text, "");
});

// ---------------------------------------------------------------------------
// Signed in with Google (see /assets/account.js): past checks are kept in the account and can be reopened
// ---------------------------------------------------------------------------
const ACCOUNT = window.GSAccount || null;
const KEEP_FIELDS = ["n", "text", "status", "label", "severity", "details", "fix", "doi"];

function recordCheck(all, sourceName) {
  if (!ACCOUNT || !ACCOUNT.state().signedIn) return;
  const counts = {};
  all.forEach((r) => { counts[r.severity] = (counts[r.severity] || 0) + 1; });
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: new Date().toISOString(),
    source: sourceName || "Pasted references", total: all.length, counts,
    results: all.map((r) => Object.fromEntries(KEEP_FIELDS.filter((k) => r[k] !== undefined && r[k] !== null).map((k) => [k, r[k]]))),
  };
  const d = ACCOUNT.get("references");
  d.history = [entry, ...(d.history || [])].slice(0, 30);
  ACCOUNT.set("references", d);
  history.replaceState(null, "", "#check-" + entry.id);
  renderPast();
}

function openPast(id) {
  const entry = ((ACCOUNT && ACCOUNT.get("references").history) || []).find((h) => h.id === id);
  if (!entry || checker.isRunning()) return false;
  refs = entry.results;
  checker.show(entry.results.map((r) => ({ n: r.n, text: r.text, doi: r.doi })),
               Object.fromEntries(entry.results.map((r) => [r.n, r])), entry.source === "Pasted references" ? "" : entry.source);
  const when = new Date(entry.date).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  setStatus(`A past check from ${when}. Retractions can happen at any time: check the file again for today's results.`, "done");
  return true;
}

function renderPast() {
  const box = $("past");
  const list = ACCOUNT && ACCOUNT.state().signedIn ? (ACCOUNT.get("references").history || []).slice(0, 6) : [];
  box.hidden = !list.length;
  box.innerHTML = list.length ? `<h3>Your recent checks</h3><ul>${list.map((h) => `<li>
      <button type="button" data-past="${escapeHtml(h.id)}">${escapeHtml(h.source)}</button>
      <span class="when">${h.total} refs · ${new Date(h.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></li>`).join("")}</ul>` : "";
}

if (ACCOUNT) {
  $("past").addEventListener("click", (e) => {
    const b = e.target.closest("[data-past]");
    if (b && openPast(b.dataset.past)) history.replaceState(null, "", "#check-" + b.dataset.past);
  });
  const fromLink = () => location.hash.startsWith("#check-") && openPast(location.hash.slice(7));
  ACCOUNT.onChange(renderPast);
  ACCOUNT.onRemote("references", () => { renderPast(); if (!refs.length) fromLink(); });
  window.addEventListener("hashchange", fromLink);
  fromLink();
}
