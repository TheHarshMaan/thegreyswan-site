// Runs the Python checker in the background, so the page stays responsive.
// Python itself comes from Pyodide; the checker comes from checker_bundle.zip (built by build_web.py).

const PYODIDE_VERSION = "0.27.7";
const params = new URL(self.location.href).searchParams;
const PYODIDE_BASE = params.get("pyodide") || `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const BUNDLE_VERSION = params.get("v") || "";

importScripts(PYODIDE_BASE + "pyodide.js");

let py = null;

async function start() {
  const pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });
  postMessage({ type: "progress", text: "Loading document tools…" });
  await pyodide.loadPackage(["lxml", "pyyaml", "typing-extensions"]);

  postMessage({ type: "progress", text: "Loading the checker…" });
  const response = await fetch(`checker_bundle.zip${BUNDLE_VERSION ? "?v=" + BUNDLE_VERSION : ""}`);
  if (!response.ok) throw new Error(`checker_bundle.zip could not be loaded (${response.status})`);
  pyodide.unpackArchive(await response.arrayBuffer(), "zip", { extractDir: "/checker" });
  pyodide.runPython(`
import sys, os
sys.path.insert(0, "/checker")
os.makedirs("/tmp/uploads", exist_ok=True)
import web_entry
`);
  py = pyodide;
}

const ready = start();

function call(fn, ...args) {
  return py.globals.get("web_entry")[fn](...args);
}

self.onmessage = async (event) => {
  const { id, fn, args } = event.data;
  try {
    await ready;
    let result;
    if (fn === "check") {
      // args: [files: [{name, data: ArrayBuffer}], profileJson]
      const [files, profileJson] = args;
      py.runPython(`
import shutil, os
shutil.rmtree("/tmp/uploads", ignore_errors=True)
os.makedirs("/tmp/uploads")
`);
      const list = files.map((f, i) => {
        const path = `${i + 1}.docx`;      // stored under a simple name; the report uses the real one
        py.FS.writeFile(`/tmp/uploads/${path}`, new Uint8Array(f.data));
        return { path, name: f.name };
      });
      const out = JSON.parse(call("check", JSON.stringify(list), profileJson));
      let report = null;
      if (out.report) report = py.FS.readFile(out.report).buffer;
      result = { results: out.results, report };
      postMessage({ id, ok: true, result }, report ? [report] : []);
      return;
    }
    result = call(fn, ...args);
    postMessage({ id, ok: true, result });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};

ready.then(
  () => postMessage({ type: "ready" }),
  (err) => postMessage({ type: "failed", error: String(err && err.message || err) }),
);
