// The Grey Swan Editorial: Smart matching for Find reviewers (optional, off by default).
//
// Standard matching compares words, phrases and shared references. Smart matching adds a small sentence-embedding
// model (all-MiniLM-L6-v2) that reads for meaning, so it can recognise an expert who describes the same work in
// different words. The model runs inside the editor's browser: the manuscript's title and abstract are compared
// with each candidate's paper titles on this computer, and nothing about the manuscript is sent anywhere.
// The model files (about 25 MB) are downloaded once from Hugging Face and the library from jsDelivr; the browser
// keeps them for next time. It never writes text, and it only re-orders candidates the search already found.
(function (root) {
  "use strict";

  const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
  const MODEL = "Xenova/all-MiniLM-L6-v2";
  const WEIGHT = 20;            // how far meaning can move a candidate: up to ±10 points on the 0–100 score

  let loading = null;
  function load(progress) {
    if (!loading) {
      loading = (async () => {
        const lib = await import(LIBRARY);
        lib.env.allowLocalModels = false;
        return lib.pipeline("feature-extraction", MODEL, {
          dtype: "q8",
          progress_callback: (p) => {
            if (progress && p && p.status === "progress" && p.total) progress(Math.round((p.loaded / p.total) * 100));
          },
        });
      })();
      loading.catch(() => { loading = null; });       // a failed download can be tried again
    }
    return loading;
  }

  async function embed(texts, progress) {
    const extractor = await load(progress);
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }

  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

  function candidateText(c) {
    return [(c.papers || []).map((p) => p.title).join(". "), (c.matches || []).join(", "), (c.fields || []).join(", ")]
      .filter(Boolean).join(". ") || c.name;
  }

  // Pure: given similarities, adjust each candidate's score (kept reversible)
  function applyScores(cands, sims) {
    const lo = Math.min(...sims), hi = Math.max(...sims), span = hi - lo || 1;
    cands.forEach((c, i) => {
      const norm = (sims[i] - lo) / span;
      if (c.score_standard === undefined) c.score_standard = c.score;
      c.ai_similarity = Math.round(sims[i] * 1000) / 1000;
      c.ai_label = norm >= 0.66 ? "Close" : norm >= 0.33 ? "Related" : "Distant";
      c.score = Math.round((c.score_standard + WEIGHT * (norm - 0.5)) * 10) / 10;
    });
  }

  async function rerank(out, manuscriptText, progress) {
    const cands = out.candidates || [];
    if (!cands.length || !manuscriptText.trim()) return false;
    const vecs = await embed([manuscriptText, ...cands.map(candidateText)], progress);
    applyScores(cands, vecs.slice(1).map((v) => dot(vecs[0], v)));
    out.smart = true;
    return true;
  }

  function restore(out) {
    for (const c of (out && out.candidates) || []) {
      if (c.score_standard !== undefined) c.score = c.score_standard;
      delete c.score_standard; delete c.ai_similarity; delete c.ai_label;
    }
    if (out) out.smart = false;
  }

  const api = { rerank, restore, applyScores, candidateText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GSSmart = api;
})(typeof window !== "undefined" ? window : globalThis);
