// The Grey Swan Studio: your data, into tables (and a check before you share it).
// Reads a spreadsheet the author chooses (CSV here; Excel is read by the worker), works out what each column
// holds, and builds a journal-ready Table 1 with the right summary and test for each row. All in the browser.

(function (global) {
  "use strict";
  const S = global.GSStats;

  // ---------- reading CSV ----------
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const first = text.split(/\r?\n/, 1)[0] || "";
    const delim = [",", ";", "\t", "|"].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
        continue;
      }
      if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  }

  // ---------- understanding the columns ----------
  const ID_COL = /(^|[\s_])(name|first.?name|last.?name|surname|father|mother|husband|guardian|patient.?name|phone|mobile|contact|email|e-mail|address|street|house|aadhaar|aadhar|pan|passport|voter|uhid|mrn|ip.?no|op.?no|registration.?no|abha)([\s_]|$)/i;

  const MISSING = new Set(["", "na", "n/a", "nan", "null", "none", "missing", ".", "-", "–", "?", "nr", "not recorded"]);
  const isMissing = (v) => v == null || MISSING.has(String(v).trim().toLowerCase());
  function toNumber(v) {
    if (typeof v === "number") return v;
    const s = String(v).trim().replace(/,(?=\d{3}\b)/g, "");
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? parseFloat(s) : NaN;
  }
  function pretty(name) {
    let s = String(name || "").trim().replace(/[_.]+/g, " ").replace(/\s+/g, " ");
    const unit = s.match(/\s(g|kg|cm|mm|m|wk|wks|weeks|days|d|yrs|years|y|h|hrs|min|mmhg|mg\/dl|mmol\/l|%)$/i);
    if (unit) s = s.slice(0, unit.index) + ", " + unit[1].replace(/^wks?$/i, "weeks").replace(/^yrs?$/i, "years").replace(/^mmhg$/i, "mmHg");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const YES = /^(yes|y|true|1|present|positive|pos|\+)$/i, NO = /^(no|n|false|0|absent|negative|neg|-)$/i;
  function describe(header, rows) {
    return header.map((h, j) => {
      const raw = rows.map((r) => r[j]);
      const present = raw.filter((v) => !isMissing(v));
      const numbers = present.map(toNumber).filter((v) => !isNaN(v));
      const distinct = [...new Set(present.map((v) => String(v).trim()))];
      const numeric = present.length > 0 && numbers.length / present.length >= 0.95;
      let kind;
      const looksLikeIds = numbers.length > 20 && numbers.every((v) => Number.isInteger(v) && Math.abs(v) >= 1e7) && distinct.length > 0.9 * present.length;
      if (!present.length) kind = "empty";
      else if (ID_COL.test(String(h)) || looksLikeIds) kind = "id";
      else if (distinct.length === present.length && present.length > 20 && !numeric) kind = "id";
      else if (/^(id|s\.?no|sr\.?no|serial|record|patient.?id|subject.?id|uhid|mrn|name)$/i.test(String(h).trim())) kind = "id";
      else if (numeric && distinct.length > 8) kind = "number";
      else if (distinct.length <= 12) kind = "category";
      else kind = numeric ? "number" : "text";
      const binary = kind === "category" && distinct.length === 2 && distinct.every((v) => YES.test(v) || NO.test(v));
      return { index: j, name: String(h).trim() || `Column ${j + 1}`, label: pretty(h) || `Column ${j + 1}`, kind, binary,
        levels: kind === "category" ? sortLevels(distinct) : [], missing: raw.length - present.length, n: present.length };
    });
  }
  function sortLevels(levels) {
    const allNum = levels.every((l) => !isNaN(toNumber(l)));
    return [...levels].sort((a, b) => allNum ? toNumber(a) - toNumber(b) : a.localeCompare(b, undefined, { numeric: true }));
  }

  // ---------- Table 1 ----------
  // As many decimals as the data have (at least 1, at most 2), and none for large numbers like weights in grams
  function decimals(xs, raw) {
    const m = Math.abs(S.mean(xs));
    if (m >= 100) return 0;
    const dp = Math.max(0, ...raw.slice(0, 500).map((v) => { const t = String(v).match(/\.(\d+)/); return t ? t[1].length : 0; }));
    return Math.max(1, Math.min(2, dp));
  }
  function buildTable1(header, rows, opts) {
    const cols = describe(header, rows);
    const g = cols[opts.group];
    const groups = g.levels;
    const byGroup = (j) => groups.map((lv) => rows.filter((r) => String(r[g.index]).trim() === lv).map((r) => r[j]));
    const gsize = groups.map((lv) => rows.filter((r) => String(r[g.index]).trim() === lv).length);
    const used = new Set();
    let anyMissing = false, smallExpected = false;
    const out = [];
    const showP = opts.p !== false;
    for (const j of opts.vars) {
      const c = cols[j];
      if (!c || j === opts.group || !["number", "category"].includes(c.kind)) continue;
      const parts = byGroup(j);
      if (parts.some((p) => p.some(isMissing))) anyMissing = true;
      if (c.kind === "number") {
        const xs = parts.map((p) => p.filter((v) => !isMissing(v)).map(toNumber).filter((v) => !isNaN(v)));
        const all = xs.flat();
        if (all.length < 3 || xs.some((x) => x.length < 2)) continue;
        const skewed = Math.abs(S.skewness(all)) > 1;
        const dp = decimals(all, parts.flat().filter((v) => !isMissing(v)));
        const cells = xs.map((x) => skewed
          ? `${S.fmt(S.quantile(x, 0.5), dp)} (${S.fmt(S.quantile(x, 0.25), dp)}–${S.fmt(S.quantile(x, 0.75), dp)})`
          : `${S.fmt(S.mean(x), dp)} ± ${S.fmt(S.sd(x), dp)}`);
        let p = null;
        if (showP) {
          if (skewed) { p = (xs.length === 2 ? S.mannWhitney(xs[0], xs[1]) : S.kruskal(xs)).p; used.add(xs.length === 2 ? "mw" : "kw"); }
          else { p = (xs.length === 2 ? S.welchT(xs[0], xs[1]) : S.anova(xs)).p; used.add(xs.length === 2 ? "t" : "anova"); }
        }
        out.push({ label: `${c.label}, ${skewed ? "median (IQR)" : "mean ± SD"}`, cells, p: S.fmtP(p) });
      } else {
        const counts = c.levels.map((lv) => parts.map((p) => p.filter((v) => String(v).trim() === lv).length));
        const totals = parts.map((p) => p.filter((v) => !isMissing(v)).length);
        let p = null;
        if (showP && c.levels.length > 1) {
          const tab = counts.filter((row) => row.some((v) => v > 0));
          if (tab.length > 1) {
            const chi = S.chiSquare(tab);
            if (tab.length === 2 && groups.length === 2 && chi.minExpected < 5) { p = S.fisher2x2(tab[0][0], tab[0][1], tab[1][0], tab[1][1]).p; used.add("fisher"); }
            else { p = chi.p; used.add("chi"); if (chi.minExpected < 5) smallExpected = true; }
          }
        }
        const cell = (k, gi) => totals[gi] ? `${S.fmtInt(counts[k][gi])} (${S.fmt(100 * counts[k][gi] / totals[gi], 1)})` : "–";
        if (c.binary) {
          const k = c.levels.findIndex((lv) => YES.test(lv));
          out.push({ label: `${c.label}, n (%)`, cells: groups.map((_, gi) => cell(k, gi)), p: S.fmtP(p) });
        } else {
          out.push({ label: `${c.label}, n (%)`, cells: groups.map(() => ""), p: S.fmtP(p), head: true });
          c.levels.forEach((lv, k) => out.push({ label: lv, cells: groups.map((_, gi) => cell(k, gi)), p: "", level: true }));
        }
      }
    }
    const tests = [];
    if (used.has("t")) tests.push("Welch’s t test");
    if (used.has("anova")) tests.push("one-way ANOVA");
    if (used.has("mw")) tests.push("the Mann–Whitney U test");
    if (used.has("kw")) tests.push("the Kruskal–Wallis test");
    const cat = [];
    if (used.has("chi")) cat.push("the chi-square test");
    if (used.has("fisher")) cat.push("Fisher’s exact test");
    let foot = "Values are n (%), mean ± SD or median (IQR).";
    if (showP && (tests.length || cat.length)) {
      foot += " p-values from " + [tests.length ? tests.join(" or ") + " for continuous variables" : "", cat.length ? cat.join(" or ") + " for categorical variables" : ""].filter(Boolean).join(", and ") + ".";
    }
    if (smallExpected) foot += " Some expected counts were below 5, so chi-square p-values for those rows should be read with care.";
    if (anyMissing) foot += " Missing values were excluded, so numbers may not add up to the group totals.";
    const headerRow = ["Characteristic", ...groups.map((lv, i) => `${opts.groupLabels && opts.groupLabels[i] || lv} (n = ${S.fmtInt(gsize[i])})`)];
    if (showP) headerRow.push("p");
    return { header: headerRow, rows: out.map((r) => [r.level ? "  " + r.label : r.label, ...r.cells, ...(showP ? [r.p] : [])]), meta: out, footnote: foot,
      group: g, tests: { continuous: tests, categorical: cat }, n: rows.length };
  }

  // A sentence for the Statistical analysis section that matches the table.
  function methodsSentence(t) {
    const bits = [];
    if (t.tests.continuous.length) bits.push(`Continuous variables are summarised as mean ± SD or, when skewed, median (IQR), and were compared with ${t.tests.continuous.join(" or ")}`);
    if (t.tests.categorical.length) bits.push(`categorical variables as n (%) and compared with ${t.tests.categorical.join(" or ")}`);
    if (!bits.length) return "";
    return bits.join("; ") + ". A two-sided p-value below 0.05 was considered statistically significant.";
  }

  // ---------- before you share: a privacy scan of the data ----------
  const DATE_COL = /(dob|date.?of.?birth|birth.?date|admission.?date|discharge.?date|date)/i;
  const PLACE_COL = /(village|block|tehsil|taluk|mohalla|ward|pin|pincode|postcode|zip|address|locality|sub.?centre|phc)/i;
  function privacyScan(header, rows) {
    const cols = describe(header, rows), found = [];
    const sample = rows.slice(0, 3000);
    for (const c of cols) {
      const vals = sample.map((r) => String(r[c.index] == null ? "" : r[c.index]).trim()).filter((v) => !isMissing(v));
      if (!vals.length) continue;
      const share = (re) => vals.filter((v) => re.test(v)).length / vals.length;
      if (ID_COL.test(c.name)) found.push({ level: "bad", col: c.name, title: `“${c.name}” looks like it identifies people`, body: "Remove it, or replace it with a study code, before sharing." });
      else if (share(/^[\w.+-]+@[\w-]+\.[\w.-]+$/) > 0.3) found.push({ level: "bad", col: c.name, title: `“${c.name}” holds email addresses`, body: "Remove the column before sharing." });
      else if (share(/^(\+?91[\s-]?)?[6-9]\d{9}$/) > 0.3) found.push({ level: "bad", col: c.name, title: `“${c.name}” holds phone numbers`, body: "Remove the column before sharing." });
      else if (share(/^\d{4}\s?\d{4}\s?\d{4}$/) > 0.3) found.push({ level: "bad", col: c.name, title: `“${c.name}” looks like 12-digit ID numbers`, body: "These may be Aadhaar numbers. Remove the column before sharing." });
      else if (DATE_COL.test(c.name) && share(/\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}/) > 0.5) found.push({ level: "warn", col: c.name, title: `“${c.name}” holds exact dates`, body: "Exact dates (especially of birth) can identify people. Share an age, or the month and year, instead." });
      else if (PLACE_COL.test(c.name) || share(/^\d{6}$/) > 0.5 && /pin|code|post/i.test(c.name)) {
        const counts = new Map();
        for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
        const small = [...counts.values()].filter((n) => n < 5).length;
        found.push({ level: small ? "warn" : "ok", col: c.name, title: `“${c.name}” names places`, body: small ? `${small} of its ${counts.size} places have fewer than 5 people, who could be recognised. Group small places together, or leave the column out.` : "Every place has at least 5 people. Check it couldn’t identify anyone with the other columns." });
      } else if (c.kind === "text" && vals.some((v) => v.split(/\s+/).length > 6)) found.push({ level: "warn", col: c.name, title: `“${c.name}” has free text`, body: "Notes written by hand often contain names or places. Read them, or leave the column out." });
    }
    if (!found.some((f) => f.level === "bad")) found.push({ level: "ok", col: "", title: "No obvious names, phone numbers, emails or ID numbers", body: "This is a quick check of the columns, not a guarantee. Look over the file yourself too." });
    return found;
  }

  // ---------- where to share it ----------
  const REPOSITORIES = [
    { id: "general", label: "Tables, spreadsheets, any general data", repo: "Zenodo", url: "https://zenodo.org", why: "Free, run by CERN, gives a DOI, accepts any file type." },
    { id: "seq", label: "DNA or RNA sequences", repo: "GenBank (NCBI)", url: "https://www.ncbi.nlm.nih.gov/genbank/submit/", why: "Journals expect sequences here; you get accession numbers to cite." },
    { id: "reads", label: "Raw sequencing reads", repo: "Sequence Read Archive (NCBI SRA)", url: "https://www.ncbi.nlm.nih.gov/sra/docs/submit/", why: "The standard home for raw reads, linked to a BioProject." },
    { id: "expr", label: "Gene expression (microarray, RNA-seq counts)", repo: "GEO (NCBI)", url: "https://www.ncbi.nlm.nih.gov/geo/info/submission.html", why: "What journals and reviewers look for; MIAME-friendly." },
    { id: "protein", label: "Protein structures", repo: "Protein Data Bank (wwPDB)", url: "https://deposit-pdbj.wwpdb.org/", why: "Required by journals for new structures." },
    { id: "code", label: "Code and analysis scripts", repo: "GitHub, archived to Zenodo", url: "https://docs.github.com/en/repositories/archiving-a-github-repository/referencing-and-citing-content", why: "Archiving a release on Zenodo gives the code a citable DOI." },
    { id: "clinical", label: "Patient-level clinical data", repo: "Controlled access, or on request", url: "https://www.ebi.ac.uk/ega/", why: "If participants didn’t consent to open sharing, say the data are available on request with ethics approval, or use a controlled-access archive such as EGA." },
    { id: "images", label: "Images and microscopy", repo: "Figshare, or the BioImage Archive", url: "https://www.ebi.ac.uk/bioimage-archive/", why: "Keeps the original files, gives a DOI." }
  ];

  global.GSData = { parseCSV, describe, buildTable1, methodsSentence, privacyScan, REPOSITORIES, pretty, toNumber, isMissing };
})(typeof window !== "undefined" ? window : globalThis);
