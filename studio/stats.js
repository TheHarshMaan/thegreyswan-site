// The Grey Swan Studio: a small statistics engine, in plain JavaScript.
// Used to build Table 1 from a spreadsheet, and to check that the numbers in a paper fit together.
// Every function is checked against SciPy in tests/stats_test.js.

(function (global) {
  "use strict";

  // ---------- special functions ----------
  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
    x -= 1;
    let a = LANCZOS[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  // Regularised lower incomplete gamma P(a, x)
  function gammaP(a, x) {
    if (x <= 0) return 0;
    if (x < a + 1) {
      let sum = 1 / a, del = sum, ap = a;
      for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
      return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
    }
    return 1 - gammaQcf(a, x);
  }
  function gammaQcf(a, x) {
    let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
  }
  const gammaQ = (a, x) => (x <= 0 ? 1 : x < a + 1 ? 1 - gammaP(a, x) : gammaQcf(a, x));
  // Regularised incomplete beta I_x(a, b)
  function betaI(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(x, a, b) / a : 1 - bt * betacf(1 - x, b, a) / b;
  }
  function betacf(x, a, b) {
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    d = 1 / d;
    let h = d;
    for (let m = 1; m < 500; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return h;
  }

  // ---------- distributions (upper-tail / two-sided p) ----------
  const chi2P = (x, df) => gammaQ(df / 2, x / 2);                       // P(X >= x)
  const tP2 = (t, df) => betaI(df / (df + t * t), df / 2, 0.5);          // two-sided
  const fP = (f, d1, d2) => (f <= 0 ? 1 : betaI(d2 / (d2 + d1 * f), d2 / 2, d1 / 2));
  const zP2 = (z) => gammaQ(0.5, z * z / 2);                            // two-sided normal
  const rP2 = (r, n) => tP2(r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r)), n - 2);

  // ---------- descriptive ----------
  const nums = (xs) => xs.filter((v) => typeof v === "number" && isFinite(v));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  function sd(xs) { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)); }
  function quantile(xs, q) {                                             // R type 7
    const s = [...xs].sort((a, b) => a - b), h = (s.length - 1) * q, lo = Math.floor(h);
    return s[lo] + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)]) - s[lo]);
  }
  function skewness(xs) {
    const m = mean(xs), n = xs.length, s2 = xs.reduce((a, b) => a + (b - m) ** 2, 0) / n;
    if (!s2) return 0;
    return xs.reduce((a, b) => a + (b - m) ** 3, 0) / n / Math.pow(s2, 1.5);
  }
  function ranks(values) {                                               // average ranks for ties
    const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(values.length);
    let ties = 0;
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      const t = j - i + 1;
      ties += t * t * t - t;
      i = j + 1;
    }
    return { r, ties };
  }

  // ---------- tests ----------
  // r x c contingency table (rows = categories, cols = groups); no continuity correction
  function chiSquare(table) {
    const R = table.length, C = table[0].length;
    const rs = table.map((row) => row.reduce((a, b) => a + b, 0));
    const cs = table[0].map((_, j) => table.reduce((a, row) => a + row[j], 0));
    const N = rs.reduce((a, b) => a + b, 0);
    let x = 0, minE = Infinity;
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
      const e = rs[i] * cs[j] / N;
      minE = Math.min(minE, e);
      if (e > 0) x += (table[i][j] - e) ** 2 / e;
    }
    const df = (R - 1) * (C - 1);
    return { stat: x, df, p: df > 0 ? chi2P(x, df) : 1, minExpected: minE };
  }
  // Fisher's exact test, 2 x 2, two-sided (the sum of tables no more likely than the one observed)
  function fisher2x2(a, b, c, d) {
    const lf = (n) => lgamma(n + 1);
    const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
    const lp = (x) => lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x);
    const obs = lp(a);
    let p = 0;
    for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) { const v = lp(x); if (v <= obs + 1e-7) p += Math.exp(v); }
    return { p: Math.min(1, p) };
  }
  function welchT(x, y) {
    const m1 = mean(x), m2 = mean(y), v1 = sd(x) ** 2 / x.length, v2 = sd(y) ** 2 / y.length;
    const t = (m1 - m2) / Math.sqrt(v1 + v2);
    const df = (v1 + v2) ** 2 / (v1 * v1 / (x.length - 1) + v2 * v2 / (y.length - 1));
    return { stat: t, df, p: tP2(t, df) };
  }
  // Mann-Whitney U, normal approximation with tie and continuity corrections (as R with exact = FALSE)
  function mannWhitney(x, y) {
    const n1 = x.length, n2 = y.length, { r, ties } = ranks([...x, ...y]);
    const R1 = r.slice(0, n1).reduce((a, b) => a + b, 0);
    const U = R1 - n1 * (n1 + 1) / 2, mu = n1 * n2 / 2, N = n1 + n2;
    const sigma = Math.sqrt(n1 * n2 / 12 * ((N + 1) - ties / (N * (N - 1))));
    const z = (Math.abs(U - mu) - 0.5) / sigma;
    return { stat: U, z, p: sigma > 0 ? Math.min(1, zP2(Math.max(0, z))) : 1 };
  }
  function anova(groups) {
    const all = groups.flat(), gm = mean(all), k = groups.length, N = all.length;
    const ssb = groups.reduce((a, g) => a + g.length * (mean(g) - gm) ** 2, 0);
    const ssw = groups.reduce((a, g) => a + g.reduce((s, v) => s + (v - mean(g)) ** 2, 0), 0);
    const d1 = k - 1, d2 = N - k, F = (ssb / d1) / (ssw / d2);
    return { stat: F, df: [d1, d2], p: fP(F, d1, d2) };
  }
  function kruskal(groups) {
    const all = groups.flat(), N = all.length, { r, ties } = ranks(all);
    let at = 0, H = 0;
    for (const g of groups) { const Rg = r.slice(at, at + g.length).reduce((a, b) => a + b, 0); H += Rg * Rg / g.length; at += g.length; }
    H = 12 / (N * (N + 1)) * H - 3 * (N + 1);
    H /= 1 - ties / (N * N * N - N);
    return { stat: H, df: groups.length - 1, p: chi2P(H, groups.length - 1) };
  }

  // ---------- formatting ----------
  function fmtP(p) {
    if (p == null || !isFinite(p)) return "";
    if (p < 0.001) return "<0.001";
    return p < 0.01 ? p.toFixed(3) : p.toFixed(2);
  }
  function fmt(v, dp) { return Number(v).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp }).replace(/ /g, " "); }
  function fmtInt(v) { return Number(v).toLocaleString("en-GB"); }

  // ---------- checking a reported result ----------
  // Recompute p for a reported statistic, and say whether the reported p fits (allowing for rounding).
  function recompute(kind, value, df1, df2) {
    switch (kind) {
      case "chi2": return chi2P(value, df1);
      case "t": return tP2(Math.abs(value), df1);
      case "F": return fP(value, df1, df2);
      case "z": return zP2(Math.abs(value));
      case "r": return rP2(value, df1 + 2);
      default: return null;
    }
  }
  // reported: {comp: "=", "<", ">", "≤"; p: number; decimals: number of decimals as written}
  function pFits(computed, reported, valueDecimals) {
    const { comp, p } = reported;
    const slack = valueDecimals != null ? 0.5 * Math.pow(10, -valueDecimals) : 0;
    if (comp === "<" || comp === "≤") return computed < p + 1e-12 || slack > 0 && computed < p * 1.3;
    if (comp === ">" || comp === "≥") return computed > p - 1e-12;
    const dp = reported.decimals != null ? reported.decimals : 3;
    const half = 0.5 * Math.pow(10, -dp);
    if (Math.abs(computed - p) <= half + 1e-12) return true;
    // the reported statistic itself is rounded: allow the p that a value within the rounding would give
    return reported.range ? p >= reported.range[0] - half && p <= reported.range[1] + half : false;
  }

  global.GSStats = { lgamma, gammaP, gammaQ, betaI, chi2P, tP2, fP, zP2, rP2, mean, sd, quantile, skewness, ranks,
    chiSquare, fisher2x2, welchT, mannWhitney, anova, kruskal, fmtP, fmt, fmtInt, recompute, pFits, nums };
})(typeof window !== "undefined" ? window : globalThis);
