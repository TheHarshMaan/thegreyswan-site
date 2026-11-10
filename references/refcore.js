// The Grey Swan Editorial: reference verification, shared by the manuscript checker (its References section) and
// the standalone reference page. Python (worker.js + refcheck.py) reads the references and decides each verdict;
// this file asks Crossref and draws the results.
//
//   const refs = GSRefCheck({ rpc, root, status, note, onDone });
//   refs.run(files, text, sourceName)   files: [{name, data: ArrayBuffer}], text: a pasted list ("" for none)
//   refs.show(refList, resultsByNumber, sourceName)   redraw a past check
//
// rpc(fn, ...args) talks to the page's worker; root is the element the results are drawn into; status(text, kind)
// shows progress ("busy" | "done" | "error"); note is an element for the Retraction Watch line (optional);
// onDone(results, sourceName) is called after a check that reached Crossref.

(function () {
  const params = new URLSearchParams(location.search);
  const RETRACTION_URLS = params.get("retractions") ? [params.get("retractions")] : [
    "https://raw.githubusercontent.com/TheHarshMaan/manuscript-checker/retraction-data/retractions.json.gz",
    "https://cdn.jsdelivr.net/gh/TheHarshMaan/manuscript-checker@retraction-data/retractions.json.gz",
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    if (window.GS_EVENT) window.GS_EVENT("references-report");
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // The Retraction Watch list (rebuilt every day on GitHub), loaded once per page, when first needed
  let retractions = null, retractionsInfo = null, retractionsLoad = null;
  function loadRetractions() {
    if (!retractionsLoad) retractionsLoad = (async () => {
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
          retractionsInfo = `Retraction Watch list of ${data.count.toLocaleString()} papers with notices, ` +
            `updated ${data.built}. Crossref's own notices are checked too.`;
          return;
        } catch (e) { /* try the next copy */ }
      }
      retractionsInfo = "The Retraction Watch list couldn't be loaded; retractions are checked with Crossref's notices instead.";
    })();
    return retractionsLoad;
  }

  // Polite Crossref requests, shared by every check on the page: at most ~8 record lookups and ~2.5 searches a second
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

  const LABELS = { must: "Must fix", should: "Should fix", advisory: "Advisory", info: "Not checked", ok: "Verified" };
  const RANK = { must: 0, should: 1, advisory: 2, info: 3, ok: 4 };

  window.GSRefCheck = function (opts) {
    const { rpc, root } = opts;
    const status = opts.status || (() => {});
    const doneWord = opts.doneWord || "References checked";
    const shown = { must: true, should: true, advisory: true, info: true, ok: true };
    let refs = [], results = {}, sourceName = "", running = false, sortBySeverity = false;

    // One reference: ask Crossref what's needed, then let the Python decide
    async function checkOne(ref) {
      let record = null, code = null, items = null;
      if (ref.doi) {
        const r = await getJSON(withContact(`${API}/${doiPath(ref.doi)}`), "single");
        code = r.status;
        record = r.data ? r.data.message : null;
        if (code === 404) items = await search(ref);
      } else {
        items = await search(ref);
        if (items === null) return { n: ref.n, text: ref.text, status: "error", label: "Couldn't check", severity: "info",
                                     details: "Crossref didn't answer the search", fix: "Try again later.", doi: null };
      }
      const assess = async (doi, ups) => JSON.parse(await rpc("refs_assess", JSON.stringify(ref), JSON.stringify(record),
        code === null ? "" : String(code), items === null ? "" : JSON.stringify(items),
        JSON.stringify(retractions && doi ? retractions[doi] || [] : []), ups ? JSON.stringify(ups) : ""));
      let result = await assess(code === 200 ? ref.doi : null, null);
      if (result.doi && result.doi !== ref.doi && retractions) result = await assess(result.doi, null);   // a DOI we found
      if (result.doi && !retractions && !["error", "doi_not_found", "not_found", "not_checked"].includes(result.status)) {
        result = await assess(result.doi, await updates(result.doi));        // no list: ask Crossref for notices
      }
      return result;
    }

    async function run(files, text, name) {
      if (window.GS_EVENT) window.GS_EVENT("references-run");
      if (running) return;
      running = true;
      results = {};
      sourceName = name || "";
      const noteLoad = loadRetractions().then(() => { if (opts.note) opts.note.textContent = retractionsInfo; });
      try {
        const out = JSON.parse(await rpc("refs_extract", files, text));
        refs = out.references;
        if (!params.get("crossref")) API = out.api;
        FIELDS = out.fields; CONTACT = out.contact;
      } catch (e) {
        running = false;
        status(`Couldn't read the references: ${e.message.split("\n").pop()}`, "error");
        return;
      }
      if (!refs.length) {
        running = false;
        status("No references found. Is there a 'References' heading?", "error");
        root.innerHTML = "";
        return;
      }
      await noteLoad;
      status(`Checking ${refs.length} references against Crossref…`, "busy");
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
      if (errors < all.length && opts.onDone) opts.onDone(all, sourceName);
      status(errors === all.length ? "Crossref couldn't be reached. Check your internet connection and try again."
        : errors ? `${doneWord}, but ${errors} reference(s) couldn't be checked: try again later for those.` : `${doneWord}.`,
        errors === all.length ? "error" : "done");
      render();
    }

    function show(list, byNumber, name) {
      if (running) return false;
      refs = list; results = byNumber; sourceName = name || "";
      render();
      return true;
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
          ${finished ? '<button type="button" class="button ghost" data-dl="xlsx">Excel report</button>' +
            '<button type="button" class="button ghost" data-dl="docx">Word report</button>' : ""}</div></div>
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
          <div class="filters" role="group" aria-label="Show reference results">
            ${["must", "should", "advisory", "ok", "info"].map((s) =>
              `<button type="button" class="chip sev-${s}" data-sev="${s}" aria-pressed="${shown[s]}">${LABELS[s]}</button>`).join("")}
          </div>
          ${finished ? `<button type="button" class="text-button" data-sort>${sortBySeverity ? "In reference order" : "Most serious first"}</button>` : ""}
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
      root.innerHTML = html.join("");

      for (const chip of root.querySelectorAll(".chip")) {
        chip.addEventListener("click", () => { shown[chip.dataset.sev] = !shown[chip.dataset.sev]; render(); });
      }
      for (const clip of root.querySelectorAll(".clip")) clip.addEventListener("click", () => clip.classList.toggle("open"));
      const sort = root.querySelector("[data-sort]");
      if (sort) sort.addEventListener("click", () => { sortBySeverity = !sortBySeverity; render(); });
      for (const b of root.querySelectorAll("[data-dl]")) {
        b.addEventListener("click", async () => {
          const out = await rpc("refs_report", JSON.stringify(refs.map((r) => results[r.n])), sourceName || "Pasted references");
          b.dataset.dl === "xlsx"
            ? download("reference_report.xlsx", out.report, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            : download("reference_report.docx", out.word, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        });
      }
    }

    return { run, show, isRunning: () => running, hasResults: () => refs.length > 0, preload: loadRetractions,
             retractionsNote: () => retractionsInfo };
  };
})();
