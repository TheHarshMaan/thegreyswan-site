// The Grey Swan Studio: the panel's Data and Submit tools.
// Table 1 from a spreadsheet, "which test?", sharing data safely, figure pre-checks, papers you may have missed,
// a journal finder and a cover letter. Uses studio.js (GSStudio.api), stats.js and studio-data.js.

(function () {
  "use strict";
  const A = window.GSStudio.api, D = window.GSData;
  const { $, $$, esc, blank } = A;
  const params = new URLSearchParams(location.search);
  const OPENALEX = params.get("openalex") || "https://api.openalex.org";

  // ---------- helpers ----------
  function sectionPara(headingRe) {
    const h = A.$$("h3, h2", A.page()).find((x) => headingRe.test(x.textContent.trim()));
    if (!h) return null;
    let p = h.nextElementSibling;
    if (!p || p.tagName !== "P") { p = document.createElement("p"); h.after(p); }
    return p;
  }
  function putInSection(headingRe, html, replace) {
    let p = sectionPara(headingRe);
    if (!p) { const made = A.insertAfterBlock(`<p>${html}</p>`); p = made[0]; }
    else if (replace || (p.hasAttribute("data-hint") && !p.textContent.trim())) { p.removeAttribute("data-hint"); p.innerHTML = html; }
    else p.insertAdjacentHTML("beforeend", " " + html);
    A.scheduleSave(); A.refresh(); A.jump(p);
    return p;
  }
  function plain(el) { return (el && el.textContent || "").replace(/\s+/g, " ").trim(); }
  function abstractText() {
    const h = A.$$("h2", A.page()).find((x) => /^abstract/i.test(x.textContent.trim()));
    const out = [];
    for (let el = h && h.nextElementSibling; el && el.tagName !== "H2"; el = el.nextElementSibling) out.push(plain(el));
    return out.join(" ");
  }
  function searchText() {
    const title = plain($("h1", A.page()));
    const kw = (abstractText().match(/Keywords?:\s*(.*)$/i) || [])[1] || "";
    const abs = abstractText().replace(/Keywords?:.*$/i, "").replace(/\b(Background|Methods|Results|Conclusions?|Objectives?|Aims?)\.\s*/g, "");
    return [title, kw.replace(/3 to 6 keywords, ideally from MeSH/i, ""), abs.split(/\s+/).slice(0, 45).join(" ")].join(" ").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 600);
  }
  async function getJSON(url) {
    const r = await fetch(url);
    if (r.status === 429) throw new Error("OpenAlex is busy right now. Try again in a minute.");
    if (!r.ok) throw new Error("OpenAlex didn’t answer (" + r.status + "). Try again in a moment.");
    return r.json();
  }
  const nextTableNo = () => A.$$(".caption", A.page()).filter((c) => /^Table/i.test(c.textContent.trim())).length + 1;

  // =====================================================================
  // Table 1 from a spreadsheet
  // =====================================================================
  let data = null;       // {name, header, body}
  async function readFile(file) {
    const status = $("#data-status");
    status.textContent = "Reading " + file.name + "…";
    try {
      let rows;
      if (/\.(xlsx|xlsm)$/i.test(file.name)) {
        status.textContent = "Reading " + file.name + "… (the first time takes a few seconds)";
        rows = JSON.parse(await A.rpc("studio_sheet", { name: file.name, data: await file.arrayBuffer() }, "")).rows.map((r) => r.map((v) => v == null ? "" : v));
      } else if (/\.xls$/i.test(file.name)) { throw new Error("Old .xls files can’t be read. In Excel, save it as .xlsx or CSV first"); }
      else rows = D.parseCSV(await file.text());
      if (rows.length < 3) throw new Error("It needs a row of column names and at least two rows of data");
      data = { name: file.name, header: rows[0].map(String), body: rows.slice(1) };
      status.textContent = "";
      renderTableSetup();
      renderShare();
      A.track("studio-data");
    } catch (err) { status.textContent = "That file couldn’t be read: " + err.message + "."; }
  }
  function renderTableSetup() {
    const box = $("#data-setup");
    const cols = D.describe(data.header, data.body);
    const groups = cols.filter((c) => c.kind === "category" && c.levels.length >= 2 && c.levels.length <= 6);
    const usable = cols.filter((c) => c.kind === "number" || c.kind === "category");
    if (!groups.length) { box.innerHTML = `<p class="panel-lead">${esc(data.name)}: ${data.body.length.toLocaleString()} rows. There’s no column with 2 to 6 groups to compare (for example, sepsis yes/no). Add one, or check the column names are in the first row.</p>`; return; }
    const guess = groups.find((c) => /group|arm|case|outcome|status|positive|sepsis|exposed|treat/i.test(c.name)) || groups[0];
    box.innerHTML = `
      <p class="panel-lead"><b>${esc(data.name)}</b>: ${data.body.length.toLocaleString()} rows · ${cols.length} columns</p>
      <label class="field">Compare groups by
        <select id="t-group" class="input">${groups.map((c) => `<option value="${c.index}"${c === guess ? " selected" : ""}>${esc(c.label)} (${c.levels.map(esc).join(" / ")})</option>`).join("")}</select></label>
      <div id="t-labels"></div>
      <p class="field" style="margin-bottom:0">Rows to include</p>
      <div class="var-list">${usable.map((c) => `<label class="check-row"><input type="checkbox" class="t-var" value="${c.index}" checked> ${esc(c.label)} <small>${c.kind === "number" ? "number" : c.levels.length + " groups"}</small></label>`).join("")}</div>
      ${cols.some((c) => c.kind === "id") ? `<p class="panel-lead" style="margin-top:8px">Left out: ${cols.filter((c) => c.kind === "id").map((c) => esc(c.name)).join(", ")} (they look like names or IDs).</p>` : ""}
      <label class="check-row"><input type="checkbox" id="t-p" checked> Show p-values</label>
      <div class="tool-actions"><button type="button" class="btn btn-small btn-gold" id="t-make">Put Table ${nextTableNo()} in the paper</button></div>
      <div id="t-after"></div>`;
    const labels = () => {
      const c = cols[+$("#t-group").value];
      $("#t-labels").innerHTML = c.levels.map((lv, i) => `<label class="field">Name for “${esc(lv)}”<input class="input t-label" data-i="${i}" value="${esc(niceLevel(c, lv))}"></label>`).join("");
      $$(".t-var").forEach((x) => { x.disabled = +x.value === c.index; if (x.disabled) x.checked = false; });
    };
    $("#t-group").onchange = labels;
    labels();
    $("#t-make").onclick = () => makeTable(cols);
  }
  function niceLevel(c, lv) {
    if (c.binary) return /^(yes|y|true|1|present|positive|pos|\+)$/i.test(lv) ? c.label : "No " + c.label.toLowerCase();
    return lv.charAt(0).toUpperCase() + lv.slice(1);
  }
  function makeTable(cols) {
    if (!A.restoreRange()) { A.toast("Click in your Results where the table should go, then try again."); return; }
    const g = +$("#t-group").value;
    const vars = $$(".t-var").filter((x) => x.checked).map((x) => +x.value);
    if (!vars.length) return A.toast("Tick at least one row to include.");
    const labels = $$(".t-label").map((x) => x.value.trim() || "Group");
    const t = D.buildTable1(data.header, data.body, { group: g, vars, groupLabels: labels, p: $("#t-p").checked });
    if (!t.rows.length) return A.toast("None of those columns could be summarised.");
    const n = nextTableNo();
    const cell = (v, tag) => `<${tag}>${esc(String(v).replace(/^ {2}/, " "))}</${tag}>`;
    const html = `<p class="caption"><b>Table ${n}.</b> Characteristics by ${esc(cols[g].label.toLowerCase())}</p>`
      + `<table><tr>${t.header.map((h) => cell(h, "th")).join("")}</tr>${t.rows.map((r) => `<tr>${r.map((v) => cell(v, "td")).join("")}</tr>`).join("")}</table>`
      + `<p class="tnote">${esc(t.footnote)}</p>`;
    A.insertAfterBlock(html);
    A.toast(`Table ${n} added. Mention it in your text, e.g. “(Table ${n})”.`);
    const sentence = D.methodsSentence(t);
    $("#t-after").innerHTML = sentence ? `<div class="answer">Add the matching sentence to your Statistical analysis?<br><i>${esc(sentence)}</i><div class="tool-actions"><button type="button" class="btn btn-small" id="t-sentence">Add it</button></div></div>` : "";
    if (sentence) $("#t-sentence").onclick = () => { putInSection(/statistical analysis/i, esc(sentence) + ` Analyses were done in ${blank("software, with version")}.`); $("#t-after").innerHTML = ""; };
    $("#t-make").textContent = `Put Table ${nextTableNo()} in the paper`;
    A.track("studio-table1");
  }

  // =====================================================================
  // Which test?
  // =====================================================================
  const TESTS = {
    "two-cat": { name: "Chi-square test", alt: "or Fisher’s exact test if any expected count is below 5", report: "χ²(1) = 4.21, p = 0.040", sentence: "Categorical variables were compared between groups using the chi-square test, or Fisher’s exact test where any expected count was below 5." },
    "two-num-normal": { name: "Welch’s t test", alt: "the t test that doesn’t assume equal variances", report: "t(48.2) = 2.31, p = 0.025; mean difference 4.1 (95% CI 0.5 to 7.7)", sentence: "Continuous variables are presented as mean ± SD and were compared using Welch’s t test." },
    "two-num-skewed": { name: "Mann–Whitney U test", alt: "also called the Wilcoxon rank-sum test", report: "U = 512, p = 0.018; median 6 (IQR 4–9) vs 4 (3–6) days", sentence: "Continuous variables that were skewed are presented as median (IQR) and were compared using the Mann–Whitney U test." },
    "three-cat": { name: "Chi-square test", alt: "for a table with more than two groups", report: "χ²(2) = 7.80, p = 0.020", sentence: "Categorical variables were compared across groups using the chi-square test." },
    "three-num-normal": { name: "One-way ANOVA", alt: "then Tukey’s test to see which groups differ", report: "F(2, 87) = 5.12, p = 0.008", sentence: "Continuous variables were compared across groups using one-way analysis of variance (ANOVA), with Tukey’s post hoc test." },
    "three-num-skewed": { name: "Kruskal–Wallis test", alt: "then Dunn’s test, with a correction for multiple comparisons", report: "H(2) = 9.4, p = 0.009", sentence: "Skewed continuous variables were compared across groups using the Kruskal–Wallis test, with Dunn’s post hoc test and Bonferroni correction." },
    "paired-cat": { name: "McNemar’s test", alt: "for yes/no answers from the same people twice", report: "χ²(1) = 6.0, p = 0.014", sentence: "Paired categorical outcomes were compared using McNemar’s test." },
    "paired-num-normal": { name: "Paired t test", alt: "on the before–after differences", report: "t(29) = 3.4, p = 0.002; mean change −2.1 (95% CI −3.4 to −0.8)", sentence: "Paired measurements were compared using the paired t test." },
    "paired-num-skewed": { name: "Wilcoxon signed-rank test", alt: "the paired version of the Mann–Whitney test", report: "V = 61, p = 0.012", sentence: "Paired measurements were compared using the Wilcoxon signed-rank test." },
    "assoc-normal": { name: "Pearson correlation", alt: "r, with its 95% CI", report: "r(48) = 0.42, p = 0.002", sentence: "The association between continuous variables was assessed using Pearson’s correlation coefficient." },
    "assoc-skewed": { name: "Spearman correlation", alt: "ρ, for skewed or ordinal measurements", report: "ρ = 0.38, p = 0.006", sentence: "The association between variables was assessed using Spearman’s rank correlation coefficient." },
    "predict-cat": { name: "Logistic regression", alt: "report odds ratios with 95% CIs, adjusted for the factors you chose in advance", report: "adjusted OR 2.4 (95% CI 1.3 to 4.5), p = 0.006", sentence: "Factors associated with the outcome were examined using multivariable logistic regression; results are presented as adjusted odds ratios (aOR) with 95% confidence intervals (CI)." },
    "predict-num": { name: "Linear regression", alt: "report coefficients (β) with 95% CIs, and check the residuals", report: "β = −120 g (95% CI −180 to −60), p < 0.001", sentence: "Factors associated with the outcome were examined using multiple linear regression; results are presented as coefficients (β) with 95% confidence intervals (CI)." },
    "predict-time": { name: "Kaplan–Meier, log-rank test and Cox regression", alt: "hazard ratios with 95% CIs; check proportional hazards", report: "HR 1.8 (95% CI 1.1 to 2.9), p = 0.02", sentence: "Time to the outcome was described using Kaplan–Meier curves and compared with the log-rank test; hazard ratios (HR) with 95% confidence intervals (CI) were estimated using Cox proportional hazards regression." }
  };
  let wt = {};
  function renderWhich() {
    const box = $("#which-test");
    const q = (key, text, opts) => `<div class="mini-q"><p>${esc(text)}</p>${opts.map(([v, l]) => `<button type="button" class="mini-choice${wt[key] === v ? " on" : ""}" data-k="${key}" data-v="${v}">${esc(l)}</button>`).join("")}</div>`;
    let html = q("aim", "What are you doing?", [["two", "Comparing two groups"], ["three", "Comparing three or more groups"], ["paired", "The same people, measured twice"], ["assoc", "How two measurements go together"], ["predict", "Finding what predicts an outcome"]]);
    if (wt.aim && wt.aim !== "assoc") html += q("out", "What is the outcome?", wt.aim === "predict" ? [["cat", "Yes or no"], ["num", "A measurement"], ["time", "Time until something happens"]] : [["cat", "Yes/no, or categories"], ["num", "A measurement (weight, days, a score)"]]);
    if ((wt.aim === "assoc" || (wt.out === "num" && wt.aim !== "predict"))) html += q("shape", "What do the measurements look like?", [["normal", "Roughly bell-shaped, groups of 30 or more"], ["skewed", "Skewed, ordinal, or small groups"], ["unsure", "Not sure"]]);
    let key = null;
    if (wt.aim === "assoc" && wt.shape) key = "assoc-" + (wt.shape === "normal" ? "normal" : "skewed");
    else if (wt.aim === "predict" && wt.out) key = "predict-" + wt.out;
    else if (wt.aim && wt.out === "cat") key = wt.aim + "-cat";
    else if (wt.aim && wt.out === "num" && wt.shape) key = `${wt.aim}-num-${wt.shape === "normal" ? "normal" : "skewed"}`;
    if (key && TESTS[key]) {
      const t = TESTS[key];
      html += `<div class="answer"><b>${esc(t.name)}</b>, ${esc(t.alt)}.${wt.shape === "unsure" ? "<br>Not sure about the shape? Look at a histogram. If it leans to one side, or a group has fewer than about 30, use this test." : ""}<br><br>Report it like: <code>${esc(t.report)}</code><div class="tool-actions"><button type="button" class="btn btn-small" id="wt-add">Add to Statistical analysis</button><button type="button" class="link-btn" id="wt-again">Start again</button></div></div>`;
    }
    box.innerHTML = html;
    $$(".mini-choice", box).forEach((b) => b.onclick = () => {
      wt[b.dataset.k] = b.dataset.v;
      if (b.dataset.k === "aim") { delete wt.out; delete wt.shape; }
      if (b.dataset.k === "out") delete wt.shape;
      renderWhich();
    });
    if ($("#wt-add")) $("#wt-add").onclick = () => putInSection(/statistical analysis/i, esc(TESTS[key].sentence) + ` Analyses were done in ${blank("software, with version")}, and p &lt; 0.05 was considered statistically significant.`);
    if ($("#wt-again")) $("#wt-again").onclick = () => { wt = {}; renderWhich(); };
  }

  // =====================================================================
  // Share your data
  // =====================================================================
  const STATEMENTS = {
    general: () => `The data that support the findings of this study are openly available in Zenodo at ${blank("DOI")}.`,
    seq: () => `Sequences have been deposited in GenBank under accession numbers ${blank("accession numbers")}.`,
    reads: () => `Raw sequencing reads have been deposited in the NCBI Sequence Read Archive under BioProject ${blank("BioProject accession")}.`,
    expr: () => `The expression data have been deposited in NCBI’s Gene Expression Omnibus under accession number ${blank("GSE number")}.`,
    protein: () => `Atomic coordinates have been deposited in the Protein Data Bank under accession code ${blank("PDB ID")}.`,
    code: () => `The analysis code is available at ${blank("repository link")} and archived on Zenodo at ${blank("DOI")}.`,
    clinical: () => `Because participants did not consent to public sharing, the de-identified data are available from the corresponding author on reasonable request, with the approval of the ${blank("ethics committee name")}.`,
    images: () => `The original images are available on Figshare at ${blank("DOI")}.`
  };
  function renderShare() {
    const box = $("#share");
    box.innerHTML = `
      <label class="field">What kind of data is it?
        <select id="share-kind" class="input"><option value="">Choose…</option>${D.REPOSITORIES.map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join("")}</select></label>
      <div id="share-repo"></div>
      <p class="field" style="margin-top:16px">Before you share a spreadsheet</p>
      ${data ? `<button type="button" class="btn btn-small" id="share-scan">Check ${esc(data.name)} for personal details</button>` : `<p class="panel-lead">Choose the spreadsheet under “Make a table from your data” first, and Studio will look for names, phone numbers, ID numbers, exact dates and small places.</p>`}
      <div id="share-out"></div>`;
    $("#share-kind").onchange = (e) => {
      const r = D.REPOSITORIES.find((x) => x.id === e.target.value);
      $("#share-repo").innerHTML = r ? `<div class="answer"><b>${esc(r.repo)}</b>. ${esc(r.why)}<br><a href="${esc(r.url)}" target="_blank" rel="noopener">How to deposit</a><div class="tool-actions"><button type="button" class="btn btn-small" id="share-use">Use this in Data availability</button></div></div>` : "";
      if (r) $("#share-use").onclick = () => putInSection(/data availability/i, STATEMENTS[r.id](), true);
    };
    if ($("#share-scan")) $("#share-scan").onclick = () => {
      const found = D.privacyScan(data.header, data.body);
      $("#share-out").innerHTML = found.map((f) => `<div class="finding"><span class="i ${f.level}" aria-hidden="true">${f.level === "ok" ? "✓" : f.level === "bad" ? "✕" : "◆"}</span><span><b>${esc(f.title)}</b><br>${esc(f.body)}</span></div>`).join("");
      A.track("studio-privacy-scan");
    };
  }

  // =====================================================================
  // Check a figure
  // =====================================================================
  function dpiOf(bytes) {
    const b = new Uint8Array(bytes);
    if (b[0] === 0x89 && b[1] === 0x50) {                              // PNG: pHYs chunk, pixels per metre
      for (let i = 8; i < Math.min(b.length - 20, 200000);) {
        const len = (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0, type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
        if (type === "pHYs") { const ppm = (b[i + 8] << 24 | b[i + 9] << 16 | b[i + 10] << 8 | b[i + 11]) >>> 0; return b[i + 16] === 1 ? Math.round(ppm * 0.0254) : null; }
        if (type === "IDAT") break;
        i += 12 + len;
      }
      return null;
    }
    if (b[0] === 0xFF && b[1] === 0xD8) {                              // JPEG: JFIF density
      for (let i = 2; i < Math.min(b.length - 16, 65536);) {
        if (b[i] !== 0xFF) { i++; continue; }
        const marker = b[i + 1], len = b[i + 2] << 8 | b[i + 3];
        if (marker === 0xE0 && String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]) === "JFIF") {
          const unit = b[i + 11], x = b[i + 12] << 8 | b[i + 13];
          return unit === 1 ? x : unit === 2 ? Math.round(x * 2.54) : null;
        }
        if (marker === 0xDA) break;
        i += 2 + len;
      }
    }
    return null;
  }
  // Blocks of the picture that reappear elsewhere at the same offset (a copy-and-move pattern)
  function repeatedRegions(gray, w, h) {
    const B = 12, step = 4, blocks = [];
    for (let y = 0; y + B <= h; y += step) for (let x = 0; x + B <= w; x += step) {
      let s = 0, s2 = 0;
      for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { const v = gray[(y + j) * w + x + i]; s += v; s2 += v * v; }
      const m = s / (B * B), sd = Math.sqrt(Math.max(0, s2 / (B * B) - m * m));
      if (sd < 9) continue;                                              // plain background: nothing to compare
      const sig = [];
      for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) {
        let c = 0;
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) c += gray[(y + cy * 4 + j) * w + x + cx * 4 + i];
        sig.push(Math.round((c / 16 - m) / sd * 2));
      }
      blocks.push({ x, y, m, sd, key: sig.join(",") });
    }
    const byKey = new Map();
    for (const b of blocks) { const l = byKey.get(b.key) || []; l.push(b); byKey.set(b.key, l); }
    const corr = (a, b) => {
      let s = 0;
      for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) s += (gray[(a.y + j) * w + a.x + i] - a.m) * (gray[(b.y + j) * w + b.x + i] - b.m);
      return s / (B * B * a.sd * b.sd);
    };
    const offsets = new Map();
    for (const list of byKey.values()) {
      if (list.length < 2 || list.length > 40) continue;
      for (let i = 0; i < list.length; i++) for (let k = i + 1; k < list.length; k++) {
        const a = list[i], b = list[k], dx = b.x - a.x, dy = b.y - a.y;
        if (Math.abs(dx) + Math.abs(dy) < 3 * B) continue;
        if (corr(a, b) < 0.96) continue;
        const key = `${Math.round(dx / 4)},${Math.round(dy / 4)}`;
        const l = offsets.get(key) || []; l.push([a, b]); offsets.set(key, l);
      }
    }
    const best = [...offsets.values()].sort((a, b) => b.length - a.length)[0] || [];
    return best.length >= 8 ? best : [];
  }
  async function checkFigure(file) {
    const out = $("#fig-out");
    out.innerHTML = `<p class="status">Looking at ${esc(file.name)}…</p>`;
    try {
      const bytes = await file.arrayBuffer();
      const bmp = await createImageBitmap(new Blob([bytes]));
      const W = bmp.width, H = bmp.height, dpi = dpiOf(bytes);
      const findings = [];
      const cm300 = (W / 300 * 2.54).toFixed(1);
      if (dpi && dpi < 300) findings.push(["warn", `Saved at ${dpi} dpi`, "Most journals want 300 dpi for photographs and 600 to 1,000 dpi for graphs and line art. Export it again at a higher resolution."]);
      if (W < 1000) findings.push(["warn", `${W} × ${H} pixels is small`, `At 300 dpi that prints only ${cm300} cm wide; a single journal column is about 8.5 cm. Export it larger, or as a vector file (PDF, EPS or SVG) if it’s a graph.`]);
      else findings.push(["ok", `${W} × ${H} pixels`, `Prints up to ${cm300} cm wide at 300 dpi${dpi ? `; saved at ${dpi} dpi` : ""}.`]);
      // colour: is the meaning carried by red against green?
      const cw = Math.min(600, W), ch = Math.round(H * cw / W);
      const c = document.createElement("canvas"); c.width = cw; c.height = ch;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, cw, ch);
      const px = ctx.getImageData(0, 0, cw, ch).data;
      let red = 0, green = 0, coloured = 0, n = 0;
      for (let i = 0; i < px.length; i += 16) {
        const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255, max = Math.max(r, g, b), min = Math.min(r, g, b);
        n++;
        if (max - min < 0.25 || max < 0.3) continue;
        coloured++;
        let hue = max === r ? ((g - b) / (max - min)) * 60 : max === g ? (2 + (b - r) / (max - min)) * 60 : (4 + (r - g) / (max - min)) * 60;
        if (hue < 0) hue += 360;
        if (hue < 20 || hue > 340) red++; else if (hue > 85 && hue < 160) green++;
      }
      if (red / n > 0.003 && green / n > 0.003) findings.push(["warn", "Red and green together", "About 1 in 12 men can’t tell them apart. Use blue and orange, or magenta and green, or add labels or patterns."]);
      else if (coloured / n < 0.01) findings.push(["ok", "Black and white or greyscale", "Readable for everyone, and fine in print."]);
      else findings.push(["ok", "Colours", "No red–green pairing found."]);
      // repeated regions
      const gw = Math.min(320, W), gh = Math.round(H * gw / W);
      const g2 = document.createElement("canvas"); g2.width = gw; g2.height = gh;
      const gctx = g2.getContext("2d", { willReadFrequently: true });
      gctx.drawImage(bmp, 0, 0, gw, gh);
      const gp = gctx.getImageData(0, 0, gw, gh).data, gray = new Float32Array(gw * gh);
      for (let i = 0; i < gw * gh; i++) gray[i] = 0.299 * gp[i * 4] + 0.587 * gp[i * 4 + 1] + 0.114 * gp[i * 4 + 2];
      const rep = repeatedRegions(gray, gw, gh);
      if (rep.length) findings.push(["bad", "Parts of this image look repeated", "The marked areas look like copies of each other. If panels or bands were reused, say so in the legend; otherwise check you have the right images. Editors screen for this."]);
      else findings.push(["ok", "No repeated areas found", "A quick check for copied regions; it can’t prove an image is untouched."]);
      const caption = A.$$(".caption", A.page()).map((x) => x.textContent).join(" ");
      if ($("#fig-blot").checked || /\b(blot|gel|western|northern|southern|electrophoresis)\b/i.test(caption)) findings.push(["warn", "Keep the original blots and gels", "Journals usually ask for the full, uncropped images with the molecular weight markers. Keep them ready, and don’t adjust parts of a band image separately."]);
      out.innerHTML = findings.map(([lv, t, b]) => `<div class="finding"><span class="i ${lv}" aria-hidden="true">${lv === "ok" ? "✓" : lv === "bad" ? "✕" : "◆"}</span><span><b>${esc(t)}</b><br>${esc(b)}</span></div>`).join("") + `<div class="fig-preview"><canvas id="fig-canvas"></canvas></div>`;
      const pc = $("#fig-canvas"); pc.width = gw; pc.height = gh;
      const pctx = pc.getContext("2d"); pctx.drawImage(bmp, 0, 0, gw, gh);
      pctx.lineWidth = 1.5;
      for (const [a, b] of rep.slice(0, 60)) { pctx.strokeStyle = "rgba(232,144,127,.9)"; pctx.strokeRect(a.x, a.y, 12, 12); pctx.strokeStyle = "rgba(226,184,133,.9)"; pctx.strokeRect(b.x, b.y, 12, 12); }
      A.track("studio-figure-check");
    } catch (err) { out.innerHTML = `<p class="status">That image couldn’t be read (${esc(err.message)}). Use PNG or JPEG; TIFF files can be saved as PNG first.</p>`; }
  }

  // =====================================================================
  // Papers you may have missed (OpenAlex)
  // =====================================================================
  function fromOpenAlex(w) {
    const b = w.biblio || {}, src = (w.primary_location && w.primary_location.source) || {};
    return { id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), doi: (w.doi || "").replace(/^https?:\/\/doi\.org\//i, ""),
      title: w.title || w.display_name || "", journal: src.display_name || "", year: w.publication_year || "",
      volume: b.volume || "", issue: b.issue || "", pages: b.first_page ? b.first_page + (b.last_page && b.last_page !== b.first_page ? "-" + b.last_page : "") : "",
      authors: (w.authorships || []).map((a) => { const n = ((a.author && a.author.display_name) || "").trim().split(/\s+/); return { family: n.pop() || "", given: n.join(" ") }; }) };
  }
  async function findMissed() {
    const q = searchText(), status = $("#missed-status"), list = $("#missed");
    if (q.split(" ").length < 4) { status.textContent = "Write your title and a little of the abstract first, so Studio knows what to search for."; return; }
    list.innerHTML = ""; status.textContent = "Searching OpenAlex for papers like yours…";
    try {
      const similar = (await getJSON(`${OPENALEX}/works?search=${encodeURIComponent(q)}&per-page=25&select=id,doi,title,referenced_works`)).results || [];
      const counts = new Map();
      for (const w of similar) for (const r of new Set(w.referenced_works || [])) counts.set(r, (counts.get(r) || 0) + 1);
      const top = [...counts.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12);
      if (!top.length) { status.textContent = "No papers stood out: the similar studies don’t share many references."; return; }
      const ids = top.map(([id]) => id.replace(/^https?:\/\/openalex\.org\//, ""));
      const works = (await getJSON(`${OPENALEX}/works?filter=openalex_id:${ids.join("|")}&per-page=12&select=id,doi,title,publication_year,authorships,primary_location,biblio`)).results || [];
      const mine = new Set(A.paper().refs.map((r) => (r.doi || "").toLowerCase()).filter(Boolean));
      const shown = top.map(([id, c]) => ({ c, w: works.find((w) => w.id === id) })).filter((x) => x.w && !mine.has((x.w.doi || "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase())).slice(0, 8);
      status.textContent = shown.length ? `Cited by several of the ${similar.length} most similar papers, but not by yours:` : "You already cite the papers that similar studies cite most. Nice.";
      list.innerHTML = shown.map((x, i) => `<li><div class="ref-card"><span><b>${esc(x.w.title || "Untitled")}</b><br>${esc([(x.w.primary_location && x.w.primary_location.source && x.w.primary_location.source.display_name) || "", x.w.publication_year].filter(Boolean).join(", "))} · cited by ${x.c} of ${similar.length}</span><span class="ref-actions"><button type="button" class="btn btn-small" data-add="${i}">Cite</button>${x.w.doi ? `<a href="${esc(x.w.doi)}" target="_blank" rel="noopener" class="link-btn">Open</a>` : ""}</span></div></li>`).join("");
      $$("[data-add]", list).forEach((b) => b.onclick = () => {
        if (!A.restoreRange()) return A.toast("Click in your text where the citation goes, then press Cite.");
        const ref = fromOpenAlex(shown[+b.dataset.add].w);
        A.addRef(ref, true);
        b.textContent = "Cited"; b.disabled = true;
      });
      A.track("studio-missed");
    } catch (err) { status.textContent = err.message; }
  }

  // =====================================================================
  // Find a journal (OpenAlex)
  // =====================================================================
  async function findJournals() {
    const q = searchText(), status = $("#journals-status"), list = $("#journals");
    if (q.split(" ").length < 4) { status.textContent = "Write your title and a little of the abstract first."; return; }
    list.innerHTML = ""; status.textContent = "Looking for journals that publish work like yours…";
    try {
      const groups = ((await getJSON(`${OPENALEX}/works?search=${encodeURIComponent(q)}&group_by=primary_location.source.id`)).group_by || [])
        .filter((g) => g.key && !/unknown/i.test(g.key)).slice(0, 10);
      if (!groups.length) { status.textContent = "No journals found for these words. Add keywords and try again."; return; }
      const ids = groups.map((g) => g.key.replace(/^https?:\/\/openalex\.org\//, ""));
      const sources = (await getJSON(`${OPENALEX}/sources?filter=openalex_id:${ids.join("|")}&per-page=10&select=id,display_name,host_organization_name,issn_l,is_oa,is_in_doaj,apc_usd,homepage_url,type,summary_stats`)).results || [];
      const rows = groups.map((g) => ({ g, s: sources.find((s) => s.id === g.key || s.id.endsWith("/" + g.key.replace(/^.*\//, ""))) })).filter((x) => x.s && x.s.type === "journal");
      status.textContent = rows.length ? "Journals that have published the most papers like yours:" : "No journals found for these words.";
      list.innerHTML = rows.map(({ g, s }, i) => {
        const caution = s.is_oa && !s.is_in_doaj;
        const cites = s.summary_stats && s.summary_stats["2yr_mean_citedness"];
        return `<li><div class="journal${caution ? " caution" : ""}">
          <b>${esc(s.display_name)}</b>
          <span>${esc(s.host_organization_name || "")}${s.host_organization_name ? " · " : ""}${g.count.toLocaleString()} similar papers</span>
          <span>${s.is_oa ? `Open access${s.apc_usd ? ` · fee about US$${Number(s.apc_usd).toLocaleString()}` : " · no fee listed"}` : "Subscription; open access may be an option"}${cites ? ` · about ${cites.toFixed(1)} citations per paper` : ""}</span>
          <span>${s.is_oa ? (s.is_in_doaj ? `<span class="tag-ok">✓ Listed in DOAJ</span>` : `<span class="tag-bad">✕ Open access but not listed in DOAJ: check this journal carefully before you submit.</span>`) : `<span class="tag-ok">Subscription journal</span>`}</span>
          <span class="links">${s.homepage_url ? `<a href="${esc(s.homepage_url)}" target="_blank" rel="noopener">Journal site</a>` : ""}${s.issn_l ? `<a href="https://doaj.org/toc/${esc(s.issn_l)}" target="_blank" rel="noopener">DOAJ</a>` : ""}<a href="https://ugccare.unipune.ac.in/Apps1/User/WebA/SearchList" target="_blank" rel="noopener">Check UGC-CARE</a>${caution ? `<a href="https://thinkchecksubmit.org/journals/" target="_blank" rel="noopener">Think. Check. Submit.</a>` : ""}<button type="button" class="link-btn" data-letter="${i}" style="padding:0">Use in cover letter</button></span>
        </div></li>`;
      }).join("");
      $$("[data-letter]", list).forEach((b) => b.onclick = () => { const s = rows[+b.dataset.letter].s; $("#box-letter").open = true; renderLetter(s.display_name); $("#box-letter").scrollIntoView({ behavior: "smooth", block: "start" }); });
      A.track("studio-journals");
    } catch (err) { status.textContent = err.message; }
  }

  // =====================================================================
  // Cover letter
  // =====================================================================
  function statement(re) { const p = sectionPara(re); return p && !p.querySelector(".blank") && plain(p) && !p.hasAttribute("data-hint") ? plain(p) : ""; }
  function renderLetter(journal) {
    const box = $("#letter"), paper = A.paper();
    const concl = (abstractText().match(/Conclusions?\.\s*([^]*?)(?:Keywords?:|$)/i) || [])[1] || "";
    box.innerHTML = `
      <label class="field">Journal<input id="cl-journal" class="input" value="${esc(journal || "")}" placeholder="The journal’s name"></label>
      <label class="field">Editor’s name (if you know it)<input id="cl-editor" class="input" placeholder="Dr Priya Sharma"></label>
      <label class="field">Why it matters, in a sentence or two<textarea id="cl-why" class="input" rows="3">${esc(concl.trim())}</textarea></label>
      <div class="tool-actions"><button type="button" class="btn btn-small btn-gold" id="cl-make">Write the letter</button></div>
      <div id="cl-out"></div>`;
    $("#cl-make").onclick = () => {
      const j = $("#cl-journal").value.trim() || "[journal name]", ed = $("#cl-editor").value.trim();
      const kind = (paper.meta.kindLabel || "original research").toLowerCase();
      const article = /^[aeiou]/.test(kind) ? "an" : "a";
      const title = plain($("h1", A.page())) || paper.meta.title;
      const name = (paper.meta.authors || "").split(/,|;| and /)[0].trim() || "[your name]";
      const corr = (A.$$(".authors", A.page()).map(plain).find((t) => /corresponding/i.test(t)) || "").replace(/^Corresponding author:\s*/i, "");
      const bits = [statement(/competing interests/i) || "The authors declare no competing interests.", statement(/^funding/i), statement(/ethics approval/i)].filter(Boolean).join(" ");
      const why = $("#cl-why").value.trim();
      const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
      const text = [today, "", `Dear ${ed ? ed : "Editor"},`, "",
        `Please consider our manuscript, “${title}”, for publication as ${article} ${kind} in ${j}.`, "",
        why || "[In two or three sentences: what you found, and why it matters.]", "",
        `We believe it will interest the readers of ${j} because [one sentence on why it fits this journal].`, "",
        `This manuscript is original, has not been published before and is not under consideration by another journal. All authors have read and approved it and agree to its submission. ${bits}`, "",
        "Thank you for considering our work.", "", "Yours sincerely,", "", name, corr || "[affiliation, email]"].join("\n");
      $("#cl-out").innerHTML = `<textarea class="letter-text" id="cl-text" aria-label="Your cover letter">${esc(text)}</textarea>
        <div class="tool-actions"><button type="button" class="btn btn-small" id="cl-copy">Copy</button><button type="button" class="btn btn-small" id="cl-word">Download as Word</button></div>
        <p class="panel-lead" style="margin-top:8px">Fill in the bits in square brackets. Check the journal’s instructions: some want suggested reviewers or a statement about preprints.</p>`;
      $("#cl-copy").onclick = async () => { try { await navigator.clipboard.writeText($("#cl-text").value); A.toast("Copied."); } catch (e) { $("#cl-text").select(); A.toast("Select the text and copy it."); } };
      $("#cl-word").onclick = async () => {
        const paras = $("#cl-text").value.split(/\n/);
        try {
          const word = await A.makeWord({ title: "", authors: "", kind: "", spacing: "single", keepBlank: true, noTitle: true, blocks: paras.map((t) => ({ t: "p", runs: [{ text: t || " " }] })) });
          A.download(word, A.fileName(paper.meta.title, "_cover_letter"));
        } catch (err) { A.toast("The Word file couldn’t be made: " + err.message); }
      };
      A.track("studio-cover-letter");
    };
  }

  // ---------- wiring ----------
  $("#data-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) readFile(f); });
  $("#fig-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) checkFigure(f); });
  $("#find-missed").addEventListener("click", findMissed);
  $("#find-journals").addEventListener("click", findJournals);
  document.addEventListener("studio-tab", (e) => {
    if (e.detail === "data") { if (!$("#which-test").innerHTML) renderWhich(); if (!$("#share").innerHTML) renderShare(); }
    if (e.detail === "submit" && !$("#letter").innerHTML) renderLetter("");
  });
  window.GSStudioTools = { repeatedRegions, dpiOf, fromOpenAlex, searchText };
})();
