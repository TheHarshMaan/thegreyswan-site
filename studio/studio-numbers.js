// The Grey Swan Studio: do the numbers add up?
// Pure functions over the paper's text and tables (plain strings and arrays), so they can be tested on their own.
// Finds p-values that don't fit the reported test, n (%) that don't match their n, categories that add up to more
// than the group, and sample sizes that differ between the abstract and the tables.

(function (global) {
  "use strict";
  const S = global.GSStats;
  const num = (s) => parseFloat(String(s).replace(/,/g, "").replace(/^\./, "0."));
  const dps = (s) => { const m = String(s).match(/\.(\d+)/); return m ? m[1].length : 0; };

  // ---------- reported tests in the text ----------
  const P = String.raw`p\s*([<=>≤≥])\s*(0?\.\d+|1(?:\.0+)?|0)`;
  const PATTERNS = [
    { kind: "chi2", re: new RegExp(String.raw`(?:χ\s?2|χ²|chi[\s-]?squared?)\s*(?:\(\s*(\d+)(?:\s*,\s*[Nn]\s*=\s*[\d,]+)?\s*\))?\s*=\s*([\d.]+)(?:\s*,\s*df\s*=\s*(\d+))?[^.;]{0,30}?` + P, "gi"),
      read: (m) => ({ df1: +(m[1] || m[3]), value: m[2], comp: m[4], p: m[5] }) },
    { kind: "t", re: new RegExp(String.raw`\bt\s*\(\s*([\d.]+)\s*\)\s*=\s*([-−–]?[\d.]+)[^.;]{0,30}?` + P, "g"),
      read: (m) => ({ df1: +m[1], value: m[2].replace(/[−–]/, "-"), comp: m[3], p: m[4] }) },
    { kind: "t", re: new RegExp(String.raw`\bt\s*=\s*([-−–]?[\d.]+)\s*,\s*df\s*=\s*([\d.]+)[^.;]{0,30}?` + P, "g"),
      read: (m) => ({ df1: +m[2], value: m[1].replace(/[−–]/, "-"), comp: m[3], p: m[4] }) },
    { kind: "F", re: new RegExp(String.raw`\bF\s*\(\s*(\d+)\s*,\s*([\d.]+)\s*\)\s*=\s*([\d.]+)[^.;]{0,30}?` + P, "g"),
      read: (m) => ({ df1: +m[1], df2: +m[2], value: m[3], comp: m[4], p: m[5] }) },
    { kind: "r", re: new RegExp(String.raw`\br\s*\(\s*(\d+)\s*\)\s*=\s*([-−–]?0?\.\d+)[^.;]{0,30}?` + P, "g"),
      read: (m) => ({ df1: +m[1], value: m[2].replace(/[−–]/, "-"), comp: m[3], p: m[4] }) },
    { kind: "z", re: new RegExp(String.raw`\b[zZ]\s*=\s*([-−–]?[\d.]+)[^.;]{0,30}?` + P, "g"),
      read: (m) => ({ value: m[1].replace(/[−–]/, "-"), comp: m[2], p: m[3] }) }
  ];
  const NAME = { chi2: "χ²", t: "t", F: "F", r: "r", z: "z" };
  function checkReportedTests(text) {
    const out = [], seen = new Set();
    for (const pat of PATTERNS) {
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(text))) {
        if (seen.has(m.index)) continue;
        seen.add(m.index);
        const r = pat.read(m);
        if (pat.kind !== "z" && !(r.df1 > 0)) continue;
        const value = num(r.value), p = num(r.p), vdp = dps(r.value);
        const exact = S.recompute(pat.kind, value, r.df1, r.df2);
        if (exact == null || !isFinite(exact)) continue;
        // the statistic is rounded too: the p could be anywhere between the values it rounds from
        const h = 0.5 * Math.pow(10, -vdp);
        const ends = [S.recompute(pat.kind, value - h, r.df1, r.df2), S.recompute(pat.kind, value + h, r.df1, r.df2)].sort((a, b) => a - b);
        const fits = S.pFits(exact, { comp: r.comp === "≤" ? "<" : r.comp === "≥" ? ">" : r.comp, p, decimals: dps(r.p), range: ends });
        if (fits) continue;
        const crosses = (exact < 0.05) !== (r.comp === "<" ? p <= 0.05 : r.comp === ">" ? p < 0.05 : p < 0.05);
        const df = pat.kind === "F" ? `(${r.df1}, ${r.df2})` : pat.kind === "z" ? "" : `(${r.df1})`;
        out.push({ kind: pat.kind, at: m.index, text: m[0], computed: exact, crosses,
          title: "This p-value doesn’t fit the test",
          body: `${NAME[pat.kind]}${df} = ${r.value} gives p ${S.fmtP(exact).startsWith("<") ? S.fmtP(exact) : "= " + S.fmtP(exact)}, not p ${r.comp} ${r.p}.${crosses ? " That changes whether it is below 0.05." : ""} Check the value, the degrees of freedom or the p.` });
      }
    }
    return out;
  }

  // ---------- tables: n (%) against the column's n ----------
  const CELL = /^\s*(\d[\d,]*)\s*\(\s*(\d+(?:\.\d+)?)\s*%?\s*\)\s*$/;
  function columnNs(header) {
    return header.map((h) => { const m = String(h).match(/\b[nN]\s*=\s*(\d[\d,]*)/); return m ? num(m[1]) : null; });
  }
  function checkTable(rows, label) {
    const out = [];
    if (!rows || rows.length < 2) return out;
    const ns = columnNs(rows[0]);
    if (!ns.some((n) => n)) return out;
    const pCol = rows[0].findIndex((h, j) => j > 0 && /^\s*p(-?value)?\s*$/i.test(String(h)));
    let group = null;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const first = String(row[0] || "");
      const isLevel = /^[\s ]/.test(first) || (group && row.slice(1).some((c) => CELL.test(c)) && !/,\s*n\s*\(%\)/i.test(first) && group.open);
      const allEmpty = row.slice(1).every((c, k) => k + 1 === pCol || !String(c).trim());
      if (/n\s*\(%\)/i.test(first) && allEmpty) { group = { label: first.replace(/,\s*n\s*\(%\)/i, ""), sums: ns.map(() => 0), open: true, at: i }; continue; }
      if (!isLevel && group) { finishGroup(group, ns, out, label); group = null; }
      row.forEach((c, j) => {
        const m = String(c).match(CELL);
        if (!m || !ns[j]) return;
        const k = num(m[1]), pct = num(m[2]), d = dps(m[2]);
        const want = 100 * k / ns[j];
        if (group && isLevel) group.sums[j] += k;
        if (k > ns[j]) out.push({ row: i, col: j, title: `${label}: ${m[1]} is more than the group’s n`, body: `The column has n = ${S.fmtInt(ns[j])}.` });
        else if (Math.abs(want - pct) > 0.5 * Math.pow(10, -d) + 0.051) out.push({ row: i, col: j, title: `${label}: ${String(c).trim()} doesn’t match n = ${S.fmtInt(ns[j])}`, body: `${m[1]} of ${S.fmtInt(ns[j])} is ${want.toFixed(Math.max(1, d))}%, not ${m[2]}%.` });
      });
    }
    if (group) finishGroup(group, ns, out, label);
    return out;
  }
  function finishGroup(group, ns, out, label) {
    group.sums.forEach((s, j) => {
      if (ns[j] && s > ns[j]) out.push({ row: group.at, col: j, title: `${label}: the ${group.label.toLowerCase()} categories add up to ${S.fmtInt(s)}`, body: `That is more than the column’s n = ${S.fmtInt(ns[j])}. Check the counts, or whether people can be in more than one category (then say so).` });
    });
  }

  // ---------- the abstract against the tables ----------
  const PEOPLE = "(?:patients|participants|neonates|newborns|infants|children|adults|women|men|mothers|cases|controls|subjects|respondents|individuals|students|admissions|babies|samples|isolates|eyes|households)";
  function sampleSizesIn(text) {
    const out = [];
    const re1 = new RegExp(String.raw`\b(\d[\d,]{0,8})\s+(?:\w+\s+){0,3}?${PEOPLE}\b`, "gi");
    const re2 = /\b[nN]\s*=\s*(\d[\d,]*)/g;
    for (const re of [re1, re2]) { let m; while ((m = re.exec(text))) { const v = num(m[1]); if (v >= 10) out.push({ n: v, text: m[0] }); } }
    return out;
  }
  function checkAbstractVsTables(abstract, tables) {
    const out = [];
    const tableNs = new Set();
    for (const t of tables) { const ns = columnNs(t.rows[0] || []).filter(Boolean); ns.forEach((n) => tableNs.add(n)); if (ns.length > 1) tableNs.add(ns.reduce((a, b) => a + b, 0)); }
    if (!tableNs.size) return out;
    for (const s of sampleSizesIn(abstract)) {
      if (tableNs.has(s.n)) continue;
      const near = [...tableNs].find((n) => n !== s.n && Math.abs(n - s.n) <= Math.max(2, 0.03 * n));
      if (near) out.push({ n: s.n, other: near, title: `${S.fmtInt(s.n)} or ${S.fmtInt(near)}?`, body: `The abstract says ${s.text.trim()}; a table has n = ${S.fmtInt(near)}. Use the same number in both, or explain the difference.` });
    }
    return out;
  }

  global.GSNumbers = { checkReportedTests, checkTable, checkAbstractVsTables, sampleSizesIn };
})(typeof window !== "undefined" ? window : globalThis);
