// The Grey Swan Studio: write your paper in the browser, the way journals expect it.
// Papers are kept in this browser only (localStorage). Word files are made and read by the same
// Python tools as the checker (python-docx in Pyodide, in a background worker), so nothing is uploaded.
// Reference lookups go to Crossref, which sees only the DOI or title you search for.

(function () {
  "use strict";
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => [...(root || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const track = (name) => { try { window.GS_EVENT && window.GS_EVENT(name); } catch (e) { /* analytics is optional */ } };

  // -------------------------------------------------------------------------
  // Storage: an index of papers, and each paper on its own key
  // -------------------------------------------------------------------------
  // Everything Studio saves is one object, {papers: [...], name}, in localStorage under "gs-studio".
  // When the visitor is signed in, account.js keeps a copy in their own Google Drive and merges papers by id.
  const SKEY = "gs-studio", OLD = "gs-studio:";
  function readAll() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(SKEY) || "null"); } catch (e) { d = null; }
    if (!d) d = migrate();
    d.papers = Array.isArray(d.papers) ? d.papers : [];
    return d;
  }
  function migrate() {                       // papers saved by the first version of Studio, one key each
    const d = { papers: [], name: "" };
    try {
      const index = JSON.parse(localStorage.getItem(OLD + "index") || "[]");
      for (const p of index) { const full = JSON.parse(localStorage.getItem(OLD + "paper:" + p.id) || "null"); if (full) d.papers.push(full); }
      d.name = localStorage.getItem(OLD + "name") || "";
      if (d.papers.length || d.name) { writeAll(d); for (const p of index) localStorage.removeItem(OLD + "paper:" + p.id); localStorage.removeItem(OLD + "index"); localStorage.removeItem(OLD + "name"); }
    } catch (e) { /* nothing to carry over */ }
    return d;
  }
  function writeAll(d) {
    if (window.GSAccount && window.GSAccount.stores && window.GSAccount.stores.studio) { if (!window.GSAccount.set("studio", d)) throw new Error("full"); return; }
    localStorage.setItem(SKEY, JSON.stringify(d));
  }
  const store = {
    index() { return readAll().papers.map((p) => ({ id: p.id, title: (p.meta && p.meta.title) || "Untitled paper", kind: (p.meta && p.meta.kindLabel) || "", updated: p.updated || 0 })).sort((a, b) => b.updated - a.updated); },
    get(id) { return readAll().papers.find((p) => p.id === id) || null; },
    put(paper) { const d = readAll(); const i = d.papers.findIndex((p) => p.id === paper.id); if (i >= 0) d.papers[i] = paper; else d.papers.push(paper); writeAll(d); },
    remove(id) { const d = readAll(); d.papers = d.papers.filter((p) => p.id !== id); writeAll(d); },
    get name() { return readAll().name || ""; },
    set name(v) { const d = readAll(); d.name = v; try { writeAll(d); } catch (e) { /* ignore */ } }
  };
  let paper = null;          // the open paper: {id, meta, html, refs, created, updated}

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------
  function show(view) {
    for (const v of ["home", "setup", "editor"]) $("#" + v).hidden = v !== view;
    document.body.dataset.view = view;
    window.scrollTo(0, 0);
  }
  function greeting() {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const first = (store.name || "").replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, "").split(/\s+/)[0];
    return first ? `${part}, ${first}` : part;
  }
  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    const d = Math.round(s / 86400);
    return d === 1 ? "yesterday" : d + " days ago";
  }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("on"), 3200);
  }

  // -------------------------------------------------------------------------
  // Home: your papers
  // -------------------------------------------------------------------------
  function renderHome() {
    $("#greet").textContent = greeting() + ".";
    const list = store.index();
    const box = $("#papers");
    $("#home-empty").hidden = list.length > 0;
    box.innerHTML = list.map((p) => `
      <li class="paper-card">
        <button type="button" class="paper-open" data-open="${esc(p.id)}">
          <span class="paper-kind">${esc(p.kind || "Manuscript")}</span>
          <span class="paper-title">${esc(p.title)}</span>
          <span class="paper-when">Edited ${esc(ago(p.updated))}</span>
        </button>
        <button type="button" class="link-btn paper-del" data-del="${esc(p.id)}" aria-label="Delete ${esc(p.title)}">Delete</button>
      </li>`).join("");
    show("home");
  }
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) return openPaper(open.dataset.open);
    const del = e.target.closest("[data-del]");
    if (del) {
      if (del.dataset.sure) { store.remove(del.dataset.del); renderHome(); toast("Deleted from this computer."); }
      else { del.dataset.sure = "1"; del.textContent = "Delete for good?"; setTimeout(() => { if (del.isConnected) { delete del.dataset.sure; del.textContent = "Delete"; } }, 4000); }
    }
  });

  // -------------------------------------------------------------------------
  // Setup: a few friendly questions
  // -------------------------------------------------------------------------
  const KINDS = { research: "Original research", review: "Narrative review", sr: "Systematic review", case: "Case report", letter: "Letter to the editor" };
  let setup = { step: 0, a: {} };
  function flow() {
    const a = setup.a, steps = ["start", "type"];
    if (a.type !== "letter") steps.push("field");
    if (a.type === "research") steps.push("design");
    if (a.type === "research" || a.type === "case") steps.push("people");
    if (a.people === "humans") steps.push("consent");
    if (a.type !== "letter") steps.push("funding", "data");
    steps.push("ai");
    return steps;
  }
  const Q = {
    type: { k: "About your paper", t: "What kind of paper is it?", o: [["research", "Original research", "You collected or analysed new data"], ["review", "Narrative review", "You bring together what’s already known"], ["sr", "Systematic review or meta-analysis", "You searched and appraised studies with a set method"], ["case", "Case report", "One patient or a small series"], ["letter", "Letter to the editor", "A short response or observation"]] },
    field: { k: "About your paper", t: "Which field is it in?", h: "Studio adds the statements and checks your field usually needs.", o: [["clinical", "Clinical medicine", "Patients, hospitals, trials"], ["micro", "Microbiology", "Organisms, resistance, lab work"], ["public", "Public health", "Populations, surveys, programmes"], ["bioinfo", "Bioinformatics", "Data, code, models"], ["qual", "Social or qualitative research", "Interviews, focus groups"], ["other", "Something else", ""]] },
    design: { k: "How you did it", t: "Which best describes your study?", h: "This decides which reporting checklist journals will ask for.", o: [["rct", "A randomised trial", "People were randomly assigned to groups"], ["obs", "An observational study", "Cohort, case-control or cross-sectional"], ["lab", "A lab or animal study", ""], ["qual", "A qualitative study", "Interviews, focus groups"], ["other", "Something else", ""]] },
    people: { k: "Ethics", t: "Did people or animals take part?", o: [["humans", "Yes, people", "Patients, volunteers, staff, records"], ["animals", "Yes, animals", ""], ["none", "Neither", "Cell lines, public data, models"]] },
    consent: { k: "Ethics", t: "How did participants agree to take part?", h: "Journals ask for the mode of consent, so it helps to say it plainly.", o: [["written", "They signed a written consent form", ""], ["verbal", "They gave verbal consent", "Usually recorded or witnessed"], ["waived", "The ethics committee waived consent", "Common for records-based studies"]], cheer: "Nice, that’s the ethics part sorted." },
    funding: { k: "The small print", t: "Was this work funded?", o: [["yes", "Yes, it had funding", "Type the funder below, or leave it for later"], ["no", "No specific funding", ""]], funder: true },
    data: { k: "The small print", t: "Where can readers find your data?", o: [["repo", "In a public repository", "Zenodo, Figshare, Dryad, GenBank, GEO"], ["request", "From me, on reasonable request", ""], ["paper", "It’s all in the paper", "Or in the supplementary files"]] },
    ai: { k: "Last one", t: "Did you use AI tools while writing?", h: "Most journals now ask. Saying so is normal.", o: [["language", "Yes, for language and grammar", ""], ["more", "Yes, for more than language", "Drafting, summarising, analysis"], ["no", "No", ""]] }
  };
  function startSetup() { setup = { step: 0, a: {} }; renderSetup(); show("setup"); track("studio-new"); }
  function renderSetup(cheer) {
    const steps = flow(), cur = steps[setup.step];
    $("#setup-progress").style.width = Math.round(setup.step / steps.length * 100) + "%";
    const box = $("#setup-box");
    if (cur === "start") {
      box.innerHTML = `
        <h1 class="setup-h1">Start a new paper</h1>
        <p class="setup-lead">A few easy questions, and Studio sets your paper up the way journals expect, with the statements already drafted. Then you write it right here. It stays on this computer.</p>
        <label class="field">What’s it called? A working title is fine.<input id="q-title" class="input" autocomplete="off" placeholder="Neonatal sepsis in rural Haryana" value="${esc(setup.a.title || "")}"></label>
        <label class="field">Your name, as it should appear on the paper<input id="q-name" class="input" autocomplete="name" placeholder="Dr Asha Verma" value="${esc(setup.a.name || store.name)}"></label>
        <div class="setup-actions"><button type="button" class="btn btn-gold" id="q-go">Start my paper →</button><button type="button" class="link-btn" id="q-cancel">Back to your papers</button></div>`;
      $("#q-title").focus();
      $("#q-go").onclick = () => { setup.a.title = $("#q-title").value.trim(); setup.a.name = $("#q-name").value.trim(); next(setup.a.title ? "Lovely title." : ""); };
      $("#q-title").onkeydown = (e) => { if (e.key === "Enter") $("#q-go").click(); };
      $("#q-cancel").onclick = renderHome;
      return;
    }
    const q = Q[cur], about = setup.a.title ? `${q.k} · ${setup.a.title}` : q.k;
    box.innerHTML = `
      ${cheer ? `<p class="cheer">${esc(cheer)}</p>` : ""}
      <p class="setup-kicker">${esc(about)}</p>
      <h2 class="setup-q">${esc(q.t)}</h2>
      ${q.h ? `<p class="setup-help">${esc(q.h)}</p>` : ""}
      <div class="choices">${q.o.map(([v, label, sub]) => `<button type="button" class="choice${setup.a[cur] === v ? " on" : ""}" data-v="${esc(v)}"><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</button>`).join("")}</div>
      ${q.funder ? `<label class="field">Who funded it? (you can fill this in later)<input id="q-funder" class="input" placeholder="Indian Council of Medical Research" value="${esc(setup.a.funder || "")}"></label>` : ""}
      <div class="setup-actions"><button type="button" class="link-btn" id="q-back">← Back</button><button type="button" class="link-btn" id="q-skip">Skip for now</button></div>`;
    $$(".choice", box).forEach((b) => b.onclick = () => {
      if (q.funder) setup.a.funder = $("#q-funder").value.trim();
      answer(cur, b.dataset.v, q.cheer);
    });
    $(".choice", box).focus();
    $("#q-back").onclick = () => { setup.step = Math.max(0, setup.step - 1); renderSetup(); };
    $("#q-skip").onclick = () => next("No problem, you can come back to that.");
  }
  function answer(key, v, cheer) {
    setup.a[key] = v;
    if (key === "type") { if (v !== "research") delete setup.a.design; if (v !== "research" && v !== "case") { delete setup.a.people; delete setup.a.consent; } }
    if (key === "people" && v !== "humans") delete setup.a.consent;
    next(cheer || "");
  }
  function next(cheer) {
    const steps = flow();
    if (setup.step + 1 >= steps.length) return finishSetup();
    setup.step++;
    renderSetup(cheer);
  }
  function finishSetup() {
    const a = setup.a;
    if (a.name) store.name = a.name;
    const meta = { title: a.title || "Untitled paper", authors: a.name || "", type: a.type || "research", kindLabel: KINDS[a.type || "research"],
      field: a.field || "other", design: a.design || "", people: a.people || "", consent: a.consent || "", funding: a.funding || "",
      funder: a.funder || "", data: a.data || "", ai: a.ai || "", spacing: "double", abstractLimit: 250 };
    const now = Date.now();
    paper = { id: "p" + now.toString(36), meta, html: template(meta), refs: [], created: now, updated: now };
    store.put(paper);
    openPaper(paper.id, "Your paper is set up. Start anywhere.");
  }

  // -------------------------------------------------------------------------
  // The starting template: sections, notes on what journals look for, and drafted statements
  // -------------------------------------------------------------------------
  const blank = (t) => `<span class="blank" data-orig="${esc(t)}">${esc(t)}</span>`;
  const hint = (t) => `<p data-hint="${esc(t)}"><br></p>`;
  const h2 = (t) => `<h2>${esc(t)}</h2>`;
  const h3 = (t) => `<h3>${esc(t)}</h3>`;
  function template(m) {
    const out = [];
    const research = m.type === "research";
    out.push(`<p class="kicker" contenteditable="false">${esc((m.kindLabel || "Manuscript").toUpperCase())}</p>`);
    out.push(`<h1>${esc(m.title)}</h1>`);
    out.push(`<p class="authors">${m.authors ? esc(m.authors) : blank("Author names")}<sup>1</sup> · <sup>1</sup>${blank("Department, institution, city, country")}</p>`);
    out.push(`<p class="authors">Corresponding author: ${blank("name, email")}</p>`);
    if (m.type !== "letter") {
      out.push(h2("Abstract"));
      if (research || m.type === "sr") ["Background", "Methods", "Results", "Conclusions"].forEach((s) => out.push(`<p><b>${s}.</b> </p>`));
      else out.push(hint("One paragraph, usually under 250 words: what this paper covers and why it matters."));
      out.push(`<p><b>Keywords:</b> ${blank("3 to 6 keywords, ideally from MeSH")}</p>`);
      out.push(h2("Introduction"), hint("What is known, what isn’t, and the question you set out to answer."));
    }
    if (research) {
      out.push(h2("Methods"));
      out.push(h3("Study design and setting"), hint("Where and when, with dates."));
      if (m.design !== "lab") out.push(h3("Participants"), hint("Who was included and excluded, and why."));
      if (m.field === "micro") out.push(h3("Isolates and laboratory methods"), hint("Strain sources and identification; susceptibility testing method and breakpoints (CLSI or EUCAST, with version)."));
      if (m.field === "bioinfo") out.push(h3("Data and tools"), hint("Datasets with accession numbers; every tool with its version and key parameters; positive and negative controls."));
      if (m.design === "qual" || m.field === "qual") out.push(h3("Data collection"), hint("How interviews or groups were run, by whom, and how long they lasted. Provide the interview guide as a supplementary file."));
      if (m.design !== "lab" && m.design !== "qual") out.push(h3("Sample size"), hint("How it was decided."));
      out.push(h3("Statistical analysis"), hint("Tests used, and the software with its version."));
      out.push(h2("Results"), hint("Cite every table and figure in the text, in order."));
      out.push(h2("Discussion"), hint("Your main finding first, then how it fits with other work, then limitations."));
      out.push(h2("Conclusions"), hint("What this means, in two or three sentences."));
    } else if (m.type === "sr") {
      out.push(h2("Methods"), `<p>The protocol was registered with PROSPERO (${blank("CRD number")}).</p>`, hint("Search strategy with databases and dates, eligibility criteria, screening, risk-of-bias tool."));
      out.push(h2("Results"), hint("Start with the PRISMA flow diagram."), h2("Discussion"), hint(""), h2("Conclusions"), hint(""));
    } else if (m.type === "case") {
      out.push(h2("Case presentation"), hint("History, findings, investigations, treatment and outcome, in time order."), h2("Discussion"), hint("Why this case matters, and how it compares with others reported."), h2("Conclusion"), hint("The one lesson for readers."));
    } else if (m.type === "review") {
      out.push(h2("Main sections"), hint("Your own headings, one theme each. Change this heading to your first theme."), h2("Conclusions"), hint(""));
    } else {
      out.push(`<p>Dear Editor,</p>`, hint("Usually under 600 words with up to 5 references. Say which article you are responding to."));
    }
    // Declarations
    out.push(h2("Declarations"));
    if (m.people === "humans") {
      let eth = `This study was approved by the ${blank("ethics committee name")} (approval no. ${blank("number")}, dated ${blank("date")})`;
      if (m.field === "clinical" || m.field === "public") eth += ` and was conducted in accordance with the Indian Council of Medical Research (ICMR) National Ethical Guidelines for Biomedical and Health Research Involving Human Participants (2017) and the Declaration of Helsinki`;
      out.push(h3("Ethics approval"), `<p>${eth}.</p>`);
      const consent = { written: "Written informed consent was obtained from all participants" + (m.type === "case" ? "" : ` (or ${blank("their parents or guardians")})`) + ".",
        verbal: `Verbal informed consent was obtained from all participants and recorded by ${blank("how it was recorded")}.`,
        waived: `The requirement for informed consent was waived by the committee because ${blank("reason, e.g. records-based study")}.` }[m.consent];
      out.push(h3("Consent"), consent ? `<p>${consent}</p>` : hint("Written or verbal, and who gave it."));
      if (m.type === "case") out.push(h3("Consent for publication"), `<p>Written consent to publish was obtained from ${blank("the patient or guardian")}.</p>`);
    } else if (m.people === "animals") {
      out.push(h3("Ethics approval"), `<p>All procedures were approved by the ${blank("animal ethics committee")} (no. ${blank("number")}). Animals were euthanised by ${blank("method")}.</p>`);
    }
    if (m.design === "rct") out.push(h3("Trial registration"), `<p>Registered with the ${m.field === "clinical" || m.field === "public" ? "Clinical Trials Registry – India" : blank("trial registry")} (${blank("registration number")}) on ${blank("date")}.</p>`);
    const checklist = m.type === "sr" ? "PRISMA" : m.type === "case" ? "CARE" : { rct: "CONSORT", obs: "STROBE", lab: "ARRIVE", qual: "SRQR or COREQ" }[m.design];
    if (checklist) out.push(h3("Reporting guidelines"), `<p>This report follows the ${checklist} guidelines; the completed checklist is provided as a supplementary file.</p>`);
    if (m.type !== "letter") {
      out.push(h3("Funding"), m.funding === "yes" ? `<p>This work was supported by ${m.funder ? esc(m.funder) : blank("funder name")} (grant no. ${blank("number")}).</p>` : m.funding === "no" ? `<p>This research received no specific grant from any funding agency in the public, commercial or not-for-profit sectors.</p>` : hint("Who funded the work, with grant numbers, or that it had no specific funding."));
    }
    out.push(h3("Competing interests"), `<p>The authors declare ${blank("no competing interests")}.</p>`);
    if (m.type !== "letter") {
      const data = { repo: `<p>The data are available in ${blank("repository")} at ${blank("DOI or link")}.</p>`, request: `<p>The data are available from the corresponding author on reasonable request.</p>`, paper: `<p>All data generated or analysed during this study are included in this article and its supplementary files.</p>` }[m.data];
      out.push(h3("Data availability"), data || hint("Where readers can find the data."));
      if (m.field === "micro") out.push(`<p>Sequences have been deposited in GenBank under accession numbers ${blank("accession numbers")}.</p>`);
      if (m.field === "bioinfo") out.push(h3("Code availability"), `<p>The code is available at ${blank("repository link")} (version ${blank("version")}).</p>`);
    }
    const ai = { language: `<p>The authors used ${blank("tool name")} to improve the language and readability of the manuscript, and take full responsibility for its content.</p>`, more: `<p>The authors used ${blank("tool name")} for ${blank("what it was used for")}, checked all output and take full responsibility for the content.</p>`, no: `<p>No generative AI tools were used in preparing this manuscript.</p>` }[m.ai];
    out.push(h3("Use of AI"), ai || hint("Whether AI tools were used, and for what."));
    out.push(h3("Author contributions"), `<p>${m.authors ? esc(m.authors) : blank("Name")}: ${blank("conceptualisation, methodology, investigation, writing – original draft")}.</p>`);
    out.push(h3("Acknowledgements"), hint("People who helped but aren’t authors."));
    return out.join("\n");
  }

  // -------------------------------------------------------------------------
  // The editor
  // -------------------------------------------------------------------------
  const page = () => $("#page");
  let lastRange = null, saveTimer = null, notesTimer = null;

  function openPaper(id, message) {
    const p = store.get(id);
    if (!p) { toast("That paper couldn’t be opened."); return renderHome(); }
    paper = p;
    paper.refs = paper.refs || [];
    page().innerHTML = sanitize(paper.html);
    if (promoteHeadings(page())) { paper.html = page().innerHTML; store.put(paper); }
    ensureRefs();
    $("#doc-title").textContent = paper.meta.title || "Untitled paper";
    $("#doc-kind").textContent = paper.meta.kindLabel || "Manuscript";
    $("#field-badge").textContent = fieldLabel(paper.meta.field);
    $("#field-badge").hidden = !fieldLabel(paper.meta.field);
    show("editor");
    renumber();
    refresh();
    setSaved();
    if (message) toast(message);
  }
  // Word files made from PDFs often have "Abstract", "Methods" and so on as plain paragraphs.
  // When a paper has no headings at all, turn lines that are exactly a section name into headings.
  const SECTION_NAMES = new Set(["abstract", "summary", "background", "introduction", "methods", "method", "materials and methods", "material and methods",
    "methodology", "patients and methods", "subjects and methods", "study design", "results", "findings", "discussion", "results and discussion",
    "conclusion", "conclusions", "limitations", "strengths and limitations", "acknowledgements", "acknowledgments", "acknowledgement", "acknowledgment",
    "funding", "financial support", "conflict of interest", "conflicts of interest", "competing interests", "declaration of competing interest",
    "disclosures", "author contributions", "authors' contributions", "data availability", "data availability statement", "ethics statement",
    "ethical approval", "ethics approval", "ethics approval and consent to participate", "supplementary material", "supplementary materials",
    "abbreviations", "case report", "case presentation"]);
  function promoteHeadings(pg) {
    if (pg.querySelector("h2:not(.refs-h)")) return false;
    let n = 0;
    for (const el of [...pg.children]) {
      if (el.tagName !== "P" || el.classList.length) continue;
      const t = el.textContent.trim().replace(/^(\d+(\.\d+)*\.?|[IVX]+\.)\s+/, "").replace(/[:.]$/, "").replace(/\s+/g, " ").toLowerCase();
      if (t.length > 45 || !SECTION_NAMES.has(t.replace(/’/g, "'"))) continue;
      const h = document.createElement("h2");
      h.innerHTML = el.innerHTML.trim().replace(/:\s*(<\/[a-z]+>)*$/i, "$1");
      el.replaceWith(h);
      n++;
    }
    return n > 0;
  }
  function fieldLabel(f) { return { clinical: "Field pack: clinical medicine", micro: "Field pack: microbiology", public: "Field pack: public health", bioinfo: "Field pack: bioinformatics", qual: "Field pack: qualitative" }[f] || ""; }

  function ensureRefs() {
    let out = $(".refs-out", page());
    if (!out) {
      page().insertAdjacentHTML("beforeend", `<h2 class="refs-h" contenteditable="false">References</h2><div class="refs-out" contenteditable="false"></div>`);
      out = $(".refs-out", page());
    } else {
      page().appendChild($(".refs-h", page()) || document.createElement("h2"));
      page().appendChild(out);
    }
    return out;
  }

  function save() {
    if (!paper) return;
    const h1 = $("h1", page());
    paper.meta.title = (h1 && h1.textContent.trim()) || "Untitled paper";
    paper.html = page().innerHTML;
    paper.updated = Date.now();
    try { store.put(paper); setSaved(); }
    catch (e) { $("#saved").textContent = "Couldn’t save in this browser (it may be full). Export a Word copy to be safe."; $("#saved").classList.add("bad"); }
    $("#doc-title").textContent = paper.meta.title;
  }
  function setSaved() { $("#saved").classList.remove("bad"); $("#saved").textContent = `${greeting()} · Saved on this computer, ${ago(paper.updated)}`; }
  setInterval(() => { if (paper && document.body.dataset.view === "editor" && !$("#saved").classList.contains("bad")) setSaved(); }, 30000);
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; save(); }, 700); $("#saved").textContent = "Saving…"; }
  function scheduleRefresh() { clearTimeout(notesTimer); notesTimer = setTimeout(refresh, 450); }
  addEventListener("beforeunload", () => { if (saveTimer) { clearTimeout(saveTimer); save(); } });

  // Only the formatting Studio understands survives a paste or a load.
  const KEEP = new Set(["P", "H1", "H2", "H3", "B", "STRONG", "I", "EM", "U", "SUP", "SUB", "UL", "OL", "LI", "BR", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "SPAN", "DIV"]);
  function sanitize(html, pasting) {
    const box = document.createElement("div");
    box.innerHTML = html;
    (function clean(node) {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 8) { child.remove(); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName;
        if (["SCRIPT", "STYLE", "META", "LINK", "TITLE", "XML", "IFRAME", "OBJECT", "IMG", "SVG"].includes(tag)) { child.remove(); continue; }
        if (!KEEP.has(tag)) { clean(child); child.replaceWith(...child.childNodes); continue; }
        const cls = child.getAttribute("class") || "";
        const keepCls = pasting ? "" : cls.split(/\s+/).filter((c) => ["blank", "cite", "ay", "kicker", "authors", "caption", "refs-out", "refs-h", "tnote"].includes(c)).join(" ");
        const attrs = {};
        if (!pasting) for (const a of ["data-hint", "data-orig", "data-refs", "contenteditable"]) if (child.hasAttribute(a)) attrs[a] = child.getAttribute(a);
        for (const a of [...child.attributes]) child.removeAttribute(a.name);
        if (keepCls) child.setAttribute("class", keepCls);
        for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
        if (pasting && (tag === "SPAN" || tag === "DIV")) { clean(child); child.replaceWith(...(tag === "DIV" ? [document.createElement("br"), ...child.childNodes] : child.childNodes)); continue; }
        clean(child);
      }
    })(box);
    return box.innerHTML;
  }

  function wireEditor() {
    const pg = page();
    document.execCommand("defaultParagraphSeparator", false, "p");
    pg.addEventListener("input", () => { releaseBlanks(); clearHints(); scheduleSave(); scheduleRefresh(); });
    pg.addEventListener("click", (e) => {
      const b = e.target.closest(".blank");
      if (b) { const r = document.createRange(); r.selectNodeContents(b); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    });
    pg.addEventListener("paste", (e) => {
      const html = e.clipboardData.getData("text/html"), text = e.clipboardData.getData("text/plain");
      e.preventDefault();
      if (html) document.execCommand("insertHTML", false, sanitize(html, true));
      else document.execCommand("insertText", false, text);
    });
    pg.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); toast("Saved on this computer."); }
    });
    document.addEventListener("selectionchange", () => {
      const s = getSelection();
      if (s.rangeCount && pg.contains(s.anchorNode)) lastRange = s.getRangeAt(0).cloneRange();
    });
    document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && document.body.dataset.view === "editor") { e.preventDefault(); save(); toast("Saved on this computer."); } });
  }
  // A blank that has been typed into becomes ordinary text.
  function releaseBlanks() {
    for (const b of $$(".blank", page())) if (b.textContent !== b.dataset.orig) {
      if (!b.textContent) { b.remove(); continue; }
      b.replaceWith(...b.childNodes);
    }
  }
  // A guidance paragraph that has been written in loses its guidance.
  function clearHints() { for (const p of $$("p[data-hint]", page())) if (p.textContent.trim()) p.removeAttribute("data-hint"); }

  function restoreRange() {
    if (!lastRange || !page().contains(lastRange.startContainer)) return false;
    page().focus();
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(lastRange);
    return true;
  }
  function cmd(name, value) { restoreRange(); document.execCommand(name, false, value || null); page().focus(); scheduleSave(); scheduleRefresh(); }

  function wireToolbar() {
    document.execCommand("styleWithCSS", false, false);
    $$("[data-cmd]").forEach((b) => b.addEventListener("mousedown", (e) => { e.preventDefault(); cmd(b.dataset.cmd); }));
    $("#block").addEventListener("change", (e) => { cmd("formatBlock", e.target.value); e.target.value = ""; });
    $("#add-table").addEventListener("mousedown", (e) => { e.preventDefault(); insertTable(); });
    $("#add-figure").addEventListener("mousedown", (e) => { e.preventDefault(); insertFigure(); });
    $("#add-cite").addEventListener("mousedown", (e) => { e.preventDefault(); openTab("refs"); $("#ref-q").focus(); });
    $("#focus").addEventListener("click", () => { document.body.classList.toggle("focus"); $("#focus").textContent = document.body.classList.contains("focus") ? "Show panels" : "Focus"; });
    $("#to-home").addEventListener("click", () => { save(); renderHome(); });
    $("#export").addEventListener("click", exportWord);
    $("#full-check").addEventListener("click", fullCheck);
    $("#cite-style").addEventListener("change", (e) => { paper.meta.citeStyle = e.target.value; renumber(); scheduleSave(); refresh(); toast("References now in " + STYLE_NAMES[e.target.value] + " style."); });
    $$(".ptab").forEach((t) => t.addEventListener("click", () => openTab(t.dataset.tab)));
  }
  function openTab(name) {
    $$(".ptab").forEach((t) => t.setAttribute("aria-selected", t.dataset.tab === name ? "true" : "false"));
    $$(".pview").forEach((v) => v.hidden = v.id !== "pv-" + name);
    document.dispatchEvent(new CustomEvent("studio-tab", { detail: name }));
  }
  function blockAtCaret() {
    if (!restoreRange()) return null;
    let n = getSelection().anchorNode;
    while (n && n.parentNode !== page()) n = n.parentNode;
    return n;
  }
  function insertAfterBlock(html) {
    const at = blockAtCaret();
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const nodes = [...tmp.childNodes];
    const refsH = $(".refs-h", page());
    if (at && at !== refsH && !(at.classList && at.classList.contains("refs-out"))) at.after(...nodes);
    else refsH.before(...nodes);
    scheduleSave(); scheduleRefresh();
    return nodes;
  }
  function insertTable() {
    const n = $$(".caption", page()).filter((c) => /^Table/i.test(c.textContent.trim())).length + 1;
    const row = (cells, tag) => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
    insertAfterBlock(`<p class="caption"><b>Table ${n}.</b> ${blank("What the table shows")}</p><table>${row(["", "Group A", "Group B"], "th")}${row(["", "", ""], "td")}${row(["", "", ""], "td")}</table><p><br></p>`);
    toast(`Table ${n} added. Mention it in your text, e.g. “(Table ${n})”.`);
  }
  function insertFigure() {
    const n = $$(".caption", page()).filter((c) => /^Fig/i.test(c.textContent.trim())).length + 1;
    insertAfterBlock(`<p class="caption"><b>Figure ${n}.</b> ${blank("What the figure shows; explain every abbreviation and symbol")}</p><p><br></p>`);
    toast(`Figure ${n}'s caption added. Most journals want the image itself as a separate file.`);
  }

  // -------------------------------------------------------------------------
  // Outline and desk notes
  // -------------------------------------------------------------------------
  function refresh() {
    if (!paper) return;
    renumber();
    const pg = page();
    // outline
    const items = [];
    let total = 0;
    for (const sec of GSNotes.sections(pg)) {
      if (sec.head.classList.contains("refs-h")) { items.push({ el: sec.head, label: "References", meta: String(citedRefs().length), state: citedRefs().length ? "s-done" : "s-empty", sub: false }); continue; }
      const text = sec.els.map((e) => e.textContent).join(" ");
      const n = GSNotes.words(text);
      total += n;
      const hasBlank = sec.els.some((e) => e.querySelector && e.querySelector(".blank"));
      items.push({ el: sec.head, label: sec.title, meta: n ? String(n) : "", state: !n ? "s-empty" : hasBlank ? "s-part" : "s-done", sub: false });
      for (const e of sec.els) if (e.tagName === "H3") items.push({ el: e, label: e.textContent.trim(), meta: "", state: "", sub: true });
    }
    total = 0;
    for (const el of pg.children) {
      if (el.matches("h1, .kicker, .refs-h, .refs-out")) continue;
      total += GSNotes.words(el.textContent);
    }
    const box = $("#outline");
    box.innerHTML = items.map((it, i) => `<li><button type="button" class="oi${it.sub ? " sub" : ""}" data-i="${i}"><span class="dot ${it.state}" aria-hidden="true"></span><span class="ol-label">${esc(it.label)}</span><span class="ol-meta">${esc(it.meta)}</span></button></li>`).join("");
    if (!items.some((it) => !it.el.classList.contains("refs-h")))
      box.insertAdjacentHTML("afterbegin", `<li class="ol-hint">No section headings yet. Put the cursor on a line like “Methods” and choose “Section heading” from Style.</li>`);
    $$(".oi", box).forEach((b) => b.onclick = () => jump(items[+b.dataset.i].el));
    $("#words").textContent = `${total.toLocaleString()} words`;
    // notes
    const meta = Object.assign({}, paper.meta, { refs: paper.refs.map((r) => Object.assign({}, r, { cited: !!r.n, short: r.text })) });
    const ignored = new Set(paper.meta.ignored || []);
    meta.ignored = [...ignored];
    const all = GSNotes.analyse(pg, meta), good = all.good;
    renderAbbr(all.abbr);
    const notes = all.notes.filter((n) => !ignored.has(n.id));
    const hidden = all.notes.length - notes.length;
    const nbox = $("#notes");
    $("#notes-count").textContent = notes.length ? String(notes.length) : "";
    nbox.innerHTML = notes.length ? notes.map((n, i) => `<li><div class="note ${n.level}"><button type="button" class="note-go" data-n="${i}"><span class="note-icon" aria-hidden="true">${n.level === "bad" ? "✕" : "◆"}</span><span><b>${esc(n.title)}</b><br>${esc(n.body)}</span></button>${n.fix ? `<button type="button" class="note-fix" data-fix="${i}">Fix</button>` : ""}<button type="button" class="note-ignore" data-ign="${i}" title="Not a problem here: hide this note for this paper" aria-label="Ignore: ${esc(n.title)}">✕</button></div></li>`).join("")
      : `<li class="calm">Nothing for the desk to ask about right now.</li>`;
    $("#good").textContent = good.length ? "Looks good: " + good.join(" · ") : "";
    nbox.insertAdjacentHTML("beforeend", hidden ? `<li class="ignored-row">${hidden} note${hidden > 1 ? "s" : ""} hidden · <button type="button" class="link-btn" id="unignore">show again</button></li>` : "");
    $$(".note-ignore", nbox).forEach((b) => b.onclick = () => {
      paper.meta.ignored = [...new Set([...(paper.meta.ignored || []), notes[+b.dataset.ign].id])];
      scheduleSave(); refresh();
    });
    const un = $("#unignore"); if (un) un.onclick = () => { paper.meta.ignored = []; scheduleSave(); refresh(); };
    $$(".note-go", nbox).forEach((b) => b.onclick = () => { const n = notes[+b.dataset.n]; if (n.tab) openTab(n.tab); jump(n.target, n); });
    $$(".note-fix", nbox).forEach((b) => b.onclick = () => applyFix(notes[+b.dataset.fix]));
  }
  // -------------------------------------------------------------------------
  // Abbreviations tab: every abbreviation in order, colour-coded, with the problem ones marked in the text
  // -------------------------------------------------------------------------
  let abbrList = [];
  const abbrStep = new Map();
  const AB_LABEL = { undefined: "Not spelled out", late: "Spelled out after its first use", defined: "", standard: "Standard, no need to spell out", ignored: "Ignored" };
  function renderAbbr(list) {
    abbrList = list;
    const bad = list.filter((x) => x.status === "undefined").length, late = list.filter((x) => x.status === "late").length;
    const fine = list.filter((x) => x.status === "defined" || x.status === "standard").length;
    $("#abbr-count").textContent = bad + late ? String(bad + late) : "";
    $("#ab-keys").innerHTML = list.length ? [
      bad ? `<span class="ab-key s-undefined"><i></i>${bad} not spelled out</span>` : "",
      late ? `<span class="ab-key s-late"><i></i>${late} spelled out late</span>` : "",
      fine ? `<span class="ab-key s-defined"><i></i>${fine} fine</span>` : ""].join("") : "";
    $("#ab-list").innerHTML = list.length ? list.map((x, i) => {
      const long = x.status === "undefined" ? "Not defined" : esc(x.long || "");
      const note = AB_LABEL[x.status] && x.status !== "undefined" ? `<small>${AB_LABEL[x.status]}</small>` : "";
      return `<li class="ab-row s-${x.status}"><button type="button" class="ab-go" data-i="${i}"><span class="ab-dot" aria-hidden="true"></span><b class="ab-short">${esc(x.abbr)}</b><span class="ab-long">${long}${note}</span><span class="ab-n" title="Used ${x.count} time${x.count > 1 ? "s" : ""}">×${x.count}</span></button>`
        + `<button type="button" class="ab-ign" data-i="${i}" title="${x.status === "ignored" ? "Count it again" : "Not a real abbreviation: ignore it"}" aria-label="${x.status === "ignored" ? "Count again" : "Ignore"} ${esc(x.abbr)}">${x.status === "ignored" ? "↺" : "✕"}</button></li>`;
    }).join("") : `<li class="calm">No abbreviations yet.</li>`;
    $$(".ab-go").forEach((b) => b.onclick = () => {
      const x = abbrList[+b.dataset.i];
      const k = abbrStep.has(x.abbr) ? (abbrStep.get(x.abbr) + 1) % x.uses.length : 0;
      abbrStep.set(x.abbr, k);
      const u = x.uses[k];
      jump(u.node.parentElement, u);
      toast(`${x.abbr}: ${k + 1} of ${x.uses.length}${x.defAt && x.defAt.node === u.node && x.defAt.at === u.at ? " (where it’s spelled out)" : ""}`);
    });
    $$(".ab-ign").forEach((b) => b.onclick = () => {
      const id = "abbr-" + abbrList[+b.dataset.i].abbr, cur = new Set(paper.meta.ignored || []);
      cur.has(id) ? cur.delete(id) : cur.add(id);
      paper.meta.ignored = [...cur];
      scheduleSave(); refresh();
    });
    markAbbr();
  }
  function markAbbr() {
    if (!(window.CSS && CSS.highlights && window.Highlight)) { $(".ab-mark").hidden = true; return; }
    CSS.highlights.delete("gs-ab-bad"); CSS.highlights.delete("gs-ab-late");
    if (!$("#ab-mark").checked) return;
    const bad = new Highlight(), late = new Highlight();
    for (const x of abbrList) {
      if (x.status !== "undefined" && x.status !== "late") continue;
      for (const u of x.uses) {
        if (x.status === "late" && x.def >= 0 && u.pos >= x.def) continue;
        if (!u.node.isConnected || u.at + u.len > u.node.nodeValue.length) continue;
        const r = document.createRange(); r.setStart(u.node, u.at); r.setEnd(u.node, u.at + u.len);
        (x.status === "undefined" ? bad : late).add(r);
      }
    }
    CSS.highlights.set("gs-ab-bad", bad); CSS.highlights.set("gs-ab-late", late);
  }
  function copyAbbr() {
    const rows = abbrList.filter((x) => x.long && (x.status === "defined" || x.status === "late"))
      .sort((a, b) => a.abbr.localeCompare(b.abbr, "en", { sensitivity: "base" })).map((x) => `${x.abbr}: ${x.long}`);
    const missing = abbrList.filter((x) => x.status === "undefined").length;
    if (!rows.length) return toast("Nothing spelled out yet to list.");
    navigator.clipboard.writeText(rows.join("\n")).then(() => toast(`Copied ${rows.length} abbreviations.${missing ? ` ${missing} not spelled out yet are left off.` : ""}`), () => toast("Couldn’t copy. Select the list by hand."));
  }

  // Go to what a note is about. With a position, light up just that sentence and the exact words;
  // otherwise (a heading, a table cell, a caption) flash the whole element.
  const NOT_END = /\b(?:al|Fig|Figs|e\.g|i\.e|vs|approx|Dr|Prof|No|Eq|Ref|Refs|cf|ca|St|Mr|Mrs|Ms|Jr|Sr|[A-Z])$/;
  let hlTimer = 0;
  function blockText(block) {
    const nodes = [], starts = [];
    let text = "";
    const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { starts.push(text.length); nodes.push(w.currentNode); text += w.currentNode.nodeValue; }
    const at = (pos) => {
      for (let i = nodes.length - 1; i >= 0; i--) if (pos >= starts[i]) return [nodes[i], Math.min(pos - starts[i], nodes[i].nodeValue.length)];
      return [nodes[0], 0];
    };
    return { nodes, starts, text, at };
  }
  function sentenceBounds(text, from, to) {
    const END = /[.!?;]["”’')\]]*\s+/g;
    let start = 0, end = text.length, m;
    while ((m = END.exec(text))) {
      const before = text.slice(0, m.index);
      const next = text[m.index + m[0].length] || "A";
      if (NOT_END.test(before) || !/[A-Z0-9(“"\[]/.test(next)) continue;
      const cut = m.index + m[0].length;
      if (cut <= from) start = cut;
      else if (m.index >= to - 1) { end = m.index + 1; break; }
    }
    return [start, end];
  }
  function lineBounds(block, from, to, lo, hi) {
    const top = (i) => { const r = rangeFor(block, i, i + 1).getClientRects()[0]; return r ? r.top : null; };
    const t0 = top(from);
    if (t0 == null) return [Math.max(lo, from - 60), Math.min(hi, to + 60)];
    const same = (i) => { const t = top(i); return t == null || Math.abs(t - t0) < 4; };
    let a = from, b = Math.max(from, to - 1);
    while (a > lo && same(a - 1)) a--;
    const t1 = top(b) == null ? t0 : top(b);
    while (b + 1 < hi) { const t = top(b + 1); if (t != null && Math.abs(t - t1) >= 4) break; b++; }
    return [a, b + 1];
  }
  function rangeFor(block, a, b) {
    const r = document.createRange();
    const [n1, o1] = block.at(a), [n2, o2] = block.at(b);
    r.setStart(n1, o1); r.setEnd(n2, o2);
    return r;
  }
  function locate(el, note) {
    if (note && note.node && note.node.isConnected && note.len) {
      const blockEl = note.node.parentElement.closest("p, li, td, th, h1, h2, h3, .caption") || el;
      const block = blockText(blockEl);
      const i = block.nodes.indexOf(note.node);
      if (i >= 0) { const from = block.starts[i] + note.at; return { block, from, to: from + note.len }; }
    }
    if (note && note.word && el) {
      const block = blockText(el);
      const re = new RegExp("\\b" + note.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      const m = re.exec(block.text);
      if (m) return { block, from: m.index, to: m.index + m[0].length };
    }
    return null;
  }
  function clearHighlights() { if (window.CSS && CSS.highlights) { CSS.highlights.delete("gs-sentence"); CSS.highlights.delete("gs-word"); } }
  function jump(el, note) {
    if (!el || el === page()) return;
    if (typeof note === "string") note = { word: note };
    const spot = el.classList.contains("blank") ? null : locate(el, note);
    if (!spot) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1800);
      if (el.classList.contains("blank")) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      return;
    }
    const word = rangeFor(spot.block, spot.from, spot.to);
    const [a, b] = sentenceBounds(spot.block.text, spot.from, spot.to);
    // A "sentence" that runs on (a table pasted as text, a list with no full stops) is cut down to the line the words sit on.
    let [sa, sb] = [a, b];
    if (b - a > 220) [sa, sb] = lineBounds(spot.block, spot.from, spot.to, a, b);
    const sentence = rangeFor(spot.block, sa, sb);
    const rect = word.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 2, behavior: "smooth" });
    clearTimeout(hlTimer);
    if (window.CSS && CSS.highlights && window.Highlight) {
      clearHighlights();
      CSS.highlights.set("gs-sentence", new Highlight(sentence));
      CSS.highlights.set("gs-word", new Highlight(word));
      hlTimer = setTimeout(clearHighlights, 3500);
    } else {
      const s = getSelection(); s.removeAllRanges(); s.addRange(word);
    }
  }
  function applyFix(note) {
    const el = note.target, f = note.fix;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, i = node.nodeValue.indexOf(f.text);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(node, i); r.setEnd(node, i + f.text.length);
      const it = document.createElement("i");
      it.textContent = f.kind === "species" ? f.to : f.text;
      r.deleteContents(); r.insertNode(it);
      break;
    }
    scheduleSave(); refresh();
    toast("Fixed.");
  }

  // -------------------------------------------------------------------------
  // References: Crossref lookups, numbering by first citation, Vancouver style
  // -------------------------------------------------------------------------
  const CROSSREF = (new URLSearchParams(location.search).get("crossref")) || "https://api.crossref.org";
  // Author-year styles (APA 7, Harvard) and numbered Vancouver
  const STYLE_NAMES = { vancouver: "Vancouver (numbered)", apa: "APA 7 (author–year)", harvard: "Harvard (author–year)" };
  const style = () => (paper && paper.meta.citeStyle) || "vancouver";
  const authorYear = () => style() !== "vancouver";
  function initials(given, dots) { return (given || "").split(/[\s-]+/).filter(Boolean).map((g) => g[0].toUpperCase() + (dots ? "." : "")).join(dots ? " " : ""); }
  function inText(r) {
    if (r.manual) { const m = (r.text || "").match(/^([A-Z][\p{L}'’-]+)/u), y = (r.text || "").match(/\b(19|20)\d{2}\b/); return `${m ? m[1] : "Anon."}, ${y ? y[0] : "n.d."}`; }
    const fam = (r.authors || []).map((a) => a.family || a.name).filter(Boolean);
    const and = style() === "apa" ? "&" : "and";
    const who = !fam.length ? (r.journal || "Anon.") : fam.length === 1 ? fam[0] : fam.length === 2 ? `${fam[0]} ${and} ${fam[1]}` : `${fam[0]} et al.`;
    return `${who}, ${r.year || "n.d."}${r.suffix || ""}`;
  }
  function authorYearRef(r) {
    if (r.manual) return r.text;
    const apa = style() === "apa";
    const names = (r.authors || []).map((a) => a.family ? `${a.family}, ${initials(a.given, true)}` : a.name || "").filter(Boolean);
    let who;
    if (apa) who = names.length > 20 ? names.slice(0, 19).join(", ") + ", … " + names[names.length - 1] : names.length > 1 ? names.slice(0, -1).join(", ") + ", & " + names[names.length - 1] : names[0] || "";
    else who = names.length > 3 ? names[0] + " et al." : names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0] || "";
    const year = `(${r.year || "n.d."}${r.suffix || ""})`;
    const title = (r.title || "").replace(/\s+/g, " ").replace(/[.\s]+$/, "");
    const pages = (r.pages || "").replace(/-/g, "–");
    const vol = r.volume ? (r.volume + (r.issue ? `(${r.issue})` : "")) : "";
    if (apa) return [who, year + ".", title + ".", [r.journal, vol, pages].filter(Boolean).join(", ") + (r.journal ? "." : ""), r.doi ? `https://doi.org/${r.doi}` : ""].filter((x) => x && x !== ".").join(" ");
    return [who, year, `‘${title}’,`, [r.journal, vol, pages && "pp. " + pages].filter(Boolean).join(", ") + ".", r.doi ? `doi:${r.doi}.` : ""].filter(Boolean).join(" ");
  }
  function formatRef(r) { return authorYear() ? authorYearRef(r) : (r.manual ? r.text : vancouver(r)); }
  function vancouver(r) {
    if (r.manual) return r.text;
    const names = (r.authors || []).map((a) => {
      if (!a.family) return a.name || "";
      const initials = (a.given || "").split(/[\s.-]+/).filter(Boolean).map((g) => g[0].toUpperCase()).join("");
      return `${a.family} ${initials}`.trim();
    }).filter(Boolean);
    const who = names.length > 6 ? names.slice(0, 6).join(", ") + ", et al." : names.join(", ");
    const title = (r.title || "").replace(/\s+/g, " ").replace(/[.\s]+$/, "");
    let src = r.journal || "";
    if (r.year) src += (src ? ". " : "") + r.year;
    if (r.volume) src += ";" + r.volume + (r.issue ? `(${r.issue})` : "");
    if (r.pages) src += ":" + r.pages;
    return [who && who + ".", title && title + ".", src && src + ".", r.doi && `doi:${r.doi}`].filter(Boolean).join(" ");
  }
  function fromCrossref(w) {
    const retracted = (w["updated-by"] || []).some((u) => /retract|withdraw|removal/i.test(u.type || "")) || /retract/i.test((w.title || [""])[0]);
    const issued = (w.issued && w.issued["date-parts"] && w.issued["date-parts"][0]) || [];
    return { id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), doi: w.DOI, title: (w.title || [""])[0],
      authors: (w.author || []).map((a) => ({ family: a.family, given: a.given, name: a.name })), journal: (w["short-container-title"] || [])[0] || (w["container-title"] || [])[0] || "",
      year: issued[0] || "", volume: w.volume || "", issue: w.issue || "", pages: w.page || "", retracted };
  }
  async function lookup(q) {
    const doi = (q.match(/10\.\d{4,9}\/\S+/) || [])[0];
    const status = $("#ref-status");
    status.textContent = "Looking it up on Crossref…";
    try {
      if (doi) {
        const r = await fetch(`${CROSSREF}/works/${encodeURIComponent(doi.replace(/[.,;)]+$/, ""))}`);
        if (!r.ok) throw new Error(r.status === 404 ? "Crossref doesn’t know that DOI. Check it, or add the reference by hand." : "Crossref didn’t answer. Try again in a moment.");
        return [fromCrossref((await r.json()).message)];
      }
      const r = await fetch(`${CROSSREF}/works?rows=5&query.bibliographic=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error("Crossref didn’t answer. Try again in a moment.");
      return ((await r.json()).message.items || []).map(fromCrossref);
    } finally { status.textContent = ""; }
  }
  function wireRefs() {
    $("#ref-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#ref-q").value.trim();
      if (!q) return;
      const box = $("#ref-results");
      box.innerHTML = "";
      try {
        const found = await lookup(q);
        if (!found.length) { box.innerHTML = `<li class="calm">Nothing found. Try the DOI, or add it by hand below.</li>`; return; }
        box.innerHTML = found.map((r, i) => `<li><div class="ref-card${r.retracted ? " bad" : ""}"><span>${esc(vancouver(r))}${r.retracted ? `<br><b class="bad-text">Retracted or withdrawn, according to Crossref. Think twice before citing it.</b>` : ""}</span><button type="button" class="btn btn-small" data-pick="${i}">Cite</button></div></li>`).join("");
        $$("[data-pick]", box).forEach((b) => b.onclick = () => { const r = found[+b.dataset.pick]; r.text = vancouver(r); addRef(r, true); box.innerHTML = ""; $("#ref-q").value = ""; });
      } catch (err) { box.innerHTML = `<li class="calm">${esc(err.message)}</li>`; }
    });
    $("#ref-manual").addEventListener("click", () => {
      const q = $("#ref-q").value.trim();
      if (!q) { $("#ref-q").focus(); return toast("Type or paste the full reference first."); }
      addRef({ id: "r" + Date.now().toString(36), manual: true, text: q }, true);
      $("#ref-q").value = "";
    });
  }
  function addRef(r, cite) {
    const same = r.doi && paper.refs.find((x) => x.doi && x.doi.toLowerCase() === r.doi.toLowerCase());
    if (!same) paper.refs.push(r);
    if (cite) insertCite((same || r).id);
    renumber(); scheduleSave(); refresh();
  }
  function insertCite(id) {
    if (!restoreRange()) { toast("Click in your text where the citation goes, then press Cite."); return; }
    const s = getSelection(), range = s.getRangeAt(0);
    range.collapse(false);
    // right after an existing citation: add to it
    const sc = range.startContainer;
    const prev = sc.nodeType === 3 ? (range.startOffset === 0 ? sc.previousSibling : null) : sc.childNodes[range.startOffset - 1] || null;
    if (prev && prev.classList && prev.classList.contains("cite")) {
      const ids = prev.dataset.refs.split(" ");
      if (!ids.includes(id)) ids.push(id);
      prev.dataset.refs = ids.join(" ");
    } else {
      const span = document.createElement("span");
      span.className = "cite"; span.contentEditable = "false"; span.dataset.refs = id; span.textContent = "?";
      range.insertNode(span);
      range.setStartAfter(span); range.collapse(true);
      s.removeAllRanges(); s.addRange(range);
      lastRange = range.cloneRange();
    }
    track("studio-cite");
  }
  function citedRefs() { return paper ? paper.refs.filter((r) => r.n) : []; }
  function citeText(r) { return authorYear() ? "(" + inText(r) + ")" : String(r.n); }
  function compress(ns) {
    ns = [...new Set(ns)].sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < ns.length; i++) {
      let j = i;
      while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
      parts.push(j - i >= 2 ? `${ns[i]}–${ns[j]}` : j > i ? `${ns[i]},${ns[j]}` : String(ns[i]));
      i = j;
    }
    return parts.join(",");
  }
  function renumber() {
    if (!paper) return;
    const order = [];
    const known = new Set(paper.refs.map((r) => r.id));
    for (const c of $$(".cite", page())) {
      const ids = (c.dataset.refs || "").split(" ").filter((x) => known.has(x));
      if (!ids.length) { c.remove(); continue; }
      c.dataset.refs = ids.join(" ");
      for (const id of ids) if (!order.includes(id)) order.push(id);
    }
    let cited = order.map((id) => paper.refs.find((r) => r.id === id));
    if (authorYear()) {
      // alphabetical by first author, then year; a, b for the same author and year
      const key = (r) => ((r.authors && r.authors[0] && (r.authors[0].family || r.authors[0].name)) || r.text || "").toLowerCase() + " " + (r.year || "");
      cited.sort((a, b) => key(a).localeCompare(key(b)));
      const seenKey = new Map();
      for (const r of cited) { const k = inText(Object.assign({}, r, { suffix: "" })); seenKey.set(k, (seenKey.get(k) || []).concat(r)); }
      for (const list of seenKey.values()) list.forEach((r, i) => { r.suffix = list.length > 1 ? String.fromCharCode(97 + i) : ""; });
    } else for (const r of paper.refs) r.suffix = "";
    const num = new Map(cited.map((r, i) => [r.id, i + 1]));
    for (const r of paper.refs) r.n = num.get(r.id) || 0;
    for (const c of $$(".cite", page())) {
      const ids = c.dataset.refs.split(" ");
      c.classList.toggle("ay", authorYear());
      c.textContent = authorYear() ? "(" + ids.map((id) => inText(paper.refs.find((r) => r.id === id))).join("; ") + ")" : compress(ids.map((id) => num.get(id)));
    }
    for (const r of paper.refs) r.text = r.manual ? r.text : formatRef(r);
    const out = ensureRefs();
    out.innerHTML = cited.length ? (authorYear() ? `<div class="ay-list">${cited.map((r) => `<p>${esc(r.text)}</p>`).join("")}</div>` : `<ol>${cited.map((r) => `<li>${esc(r.text)}</li>`).join("")}</ol>`)
      : `<p class="refs-empty">Your references appear here, in ${esc(STYLE_NAMES[style()])} style. Use + Cite.</p>`;
    const sel = $("#cite-style");
    if (sel && sel.value !== style()) sel.value = style();
    // the panel's library
    const lib = $("#ref-lib");
    const uncited = paper.refs.filter((r) => !r.n);
    lib.innerHTML = cited.map((r) => `<li><div class="ref-card${r.retracted ? " bad" : ""}"><span>${authorYear() ? "" : `<b class="gold">${r.n}.</b> `}${esc(r.text || vancouver(r))}${r.retracted ? `<br><b class="bad-text">Retracted or withdrawn, according to Crossref.</b>` : ""}</span><button type="button" class="btn btn-small" data-again="${esc(r.id)}">Cite again</button></div></li>`).join("")
      + uncited.map((r) => `<li><div class="ref-card muted"><span>Not cited yet · ${esc(r.text || vancouver(r))}</span><span class="ref-actions"><button type="button" class="btn btn-small" data-again="${esc(r.id)}">Cite</button><button type="button" class="link-btn" data-drop="${esc(r.id)}">Remove</button></span></div></li>`).join("");
    $$("[data-again]", lib).forEach((b) => b.onclick = () => { insertCite(b.dataset.again); renumber(); scheduleSave(); refresh(); });
    $$("[data-drop]", lib).forEach((b) => b.onclick = () => { paper.refs = paper.refs.filter((r) => r.id !== b.dataset.drop); renumber(); scheduleSave(); });
    $("#ref-count").textContent = cited.length ? String(cited.length) : "";
  }

  // -------------------------------------------------------------------------
  // Word files, through the same background worker as the checker
  // -------------------------------------------------------------------------
  let worker = null, nextId = 1;
  const pending = new Map();
  function getWorker() {
    if (worker) return worker;
    const params = new URLSearchParams(location.search), wp = new URLSearchParams();
    if (params.get("pyodide")) wp.set("pyodide", params.get("pyodide"));
    worker = new Worker(`worker.js${wp.toString() ? "?" + wp : ""}`);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") { $("#word-status").textContent = m.text; return; }
      if (m.type === "ready") { $("#word-status").textContent = ""; return; }
      if (m.type === "failed") { $("#word-status").textContent = "The Word tools couldn’t start. Reload the page and try again."; for (const j of pending.values()) j.reject(new Error(m.error)); pending.clear(); return; }
      const job = pending.get(m.id);
      if (!job) return;
      pending.delete(m.id);
      m.ok ? job.resolve(m.result) : job.reject(new Error(m.error));
    };
    return worker;
  }
  function rpc(fn, ...args) {
    return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); getWorker().postMessage({ id, fn, args }); });
  }

  function runsOf(el) {
    const runs = [];
    (function walk(node, fmt) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { if (n.nodeValue) runs.push(Object.assign({ text: n.nodeValue.replace(/\s+/g, " ") }, fmt)); continue; }
        if (n.nodeType !== 1) continue;
        const t = n.tagName, f = Object.assign({}, fmt);
        if (t === "BR") { runs.push(Object.assign({ text: " " }, fmt)); continue; }
        if (n.classList.contains("cite")) { runs.push(authorYear() ? { text: " " + n.textContent } : { text: n.textContent, cite: true }); continue; }
        if (n.classList.contains("blank")) { runs.push(Object.assign({ text: n.textContent, blank: true }, fmt)); continue; }
        if (t === "B" || t === "STRONG") f.b = true;
        if (t === "I" || t === "EM") f.i = true;
        if (t === "U") f.u = true;
        if (t === "SUP") f.sup = true;
        if (t === "SUB") f.sub = true;
        walk(n, f);
      }
    })(el, {});
    return runs;
  }
  function blocks() {
    const out = [], meta = { title: "" };
    for (const el of page().children) {
      const t = el.tagName;
      if (el.classList.contains("kicker")) continue;
      if (t === "H1") { meta.title = el.textContent.trim(); continue; }
      if (el.classList.contains("authors")) { out.push({ t: "p", runs: runsOf(el) }); continue; }
      if (el.classList.contains("refs-out")) { citedRefs().sort((a, b) => a.n - b.n).forEach((r) => out.push({ t: "p", runs: [{ text: authorYear() ? r.text : `${r.n}. ${r.text || vancouver(r)}` }] })); continue; }
      if (t === "H2" || t === "H3") { out.push({ t: t.toLowerCase(), runs: runsOf(el) }); continue; }
      if (t === "UL" || t === "OL") { for (const li of el.children) out.push({ t: "li", ordered: t === "OL", runs: runsOf(li) }); continue; }
      if (t === "TABLE") { out.push({ t: "table", header: !!el.querySelector("th"), rows: [...el.rows].map((r) => [...r.cells].map(runsOf)) }); continue; }
      if (el.classList.contains("caption")) { out.push({ t: "caption", runs: runsOf(el) }); continue; }
      if (el.hasAttribute("data-hint") && !el.textContent.trim()) continue;
      out.push({ t: "p", runs: runsOf(el) });
    }
    return { title: meta.title, authors: "", kind: paper.meta.kindLabel || "", spacing: paper.meta.spacing || "double", blocks: out };
  }
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  function fileName(title, suffix) { return ((title || "paper").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "").slice(0, 60) || "paper") + (suffix || "") + ".docx"; }
  async function makeWord(paperBlocks) { const { word } = await rpc("studio_export", JSON.stringify(paperBlocks)); return word; }
  function download(word, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([word], { type: DOCX }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function exportWord() {
    save();
    const btn = $("#export");
    btn.disabled = true;
    $("#word-status").textContent = "Making your Word file… (the first time takes a few seconds)";
    try {
      const word = await makeWord(blocks());
      const a = { download: fileName(paper.meta.title) };
      download(word, a.download);
      $("#word-status").textContent = "";
      toast("Word file ready: " + a.download);
      track("studio-export");
    } catch (err) {
      $("#word-status").textContent = "The Word file couldn’t be made: " + err.message;
    } finally { btn.disabled = false; }
  }
  // Hand the paper to Check your manuscript, which checks it as soon as it opens
  function handoff(record) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("gs-handoff", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { const tx = req.result.transaction("files", "readwrite"); tx.objectStore("files").put(record, "studio"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); };
    });
  }
  async function fullCheck() {
    save();
    const btn = $("#full-check");
    btn.disabled = true;
    $("#word-status").textContent = "Getting your paper ready for the full check…";
    try {
      await handoff({ name: fileName(paper.meta.title), data: await makeWord(blocks()), at: Date.now() });
      const params = new URLSearchParams(location.search), next = new URLSearchParams({ from: "studio" });
      if (params.get("pyodide")) next.set("pyodide", params.get("pyodide"));
      track("studio-full-check");
      location.href = "../checker/?" + next;
    } catch (err) { $("#word-status").textContent = "The paper couldn’t be passed to the checker: " + err.message + ". Export a Word copy and add it there instead."; btn.disabled = false; }
  }
  function runsHtml(runs) {
    return (runs || []).map((r) => {
      if (r.blank) return blank(r.text);
      let h = esc(r.text);
      if (r.sup) h = `<sup>${h}</sup>`;
      if (r.sub) h = `<sub>${h}</sub>`;
      if (r.u) h = `<u>${h}</u>`;
      if (r.i) h = `<i>${h}</i>`;
      if (r.b) h = `<b>${h}</b>`;
      return h;
    }).join("");
  }
  function htmlFromWord(p) {
    const out = [`<p class="kicker" contenteditable="false">${esc((p.kind || "Imported from Word").toUpperCase())}</p>`, `<h1>${esc(p.title || "Untitled paper")}</h1>`];
    let list = null;
    for (const b of p.blocks || []) {
      if (b.t === "li") {
        const tag = b.ordered ? "ol" : "ul";
        if (!list || list.tag !== tag) { if (list) out.push(`</${list.tag}>`); list = { tag }; out.push(`<${tag}>`); }
        out.push(`<li>${runsHtml(b.runs)}</li>`);
        continue;
      }
      if (list) { out.push(`</${list.tag}>`); list = null; }
      if (b.t === "h2" || b.t === "h3") out.push(`<${b.t}>${runsHtml(b.runs)}</${b.t}>`);
      else if (b.t === "caption") out.push(`<p class="caption">${runsHtml(b.runs)}</p>`);
      else if (b.t === "table") out.push(`<table>${(b.rows || []).map((row, i) => `<tr>${row.map((c) => i === 0 && b.header ? `<th>${runsHtml(c)}</th>` : `<td>${runsHtml(c)}</td>`).join("")}</tr>`).join("")}</table>`);
      else out.push(`<p>${runsHtml(b.runs)}</p>`);
    }
    if (list) out.push(`</${list.tag}>`);
    return out.join("\n");
  }
  async function importWord(file) {
    if (!/\.docx$/i.test(file.name)) return toast("Studio can open Word files (.docx). Save older .doc files as .docx first.");
    const status = document.body.dataset.view === "editor" ? $("#word-status") : $("#home-status");
    status.textContent = "Opening your Word file… (the first time takes a few seconds)";
    try {
      const p = JSON.parse(await rpc("studio_import", { name: file.name, data: await file.arrayBuffer() }));
      const now = Date.now();
      paper = { id: "p" + now.toString(36), meta: { title: p.title || file.name.replace(/\.docx$/i, ""), kindLabel: p.kind || "Imported", type: "", field: "", spacing: "double", abstractLimit: 250 }, html: htmlFromWord(p), refs: [], created: now, updated: now };
      store.put(paper);
      status.textContent = "";
      openPaper(paper.id, "Opened. Your original file is untouched; this copy lives in Studio.");
      track("studio-import");
    } catch (err) { status.textContent = "That file couldn’t be opened: " + err.message; }
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------
  function start() {
    wireEditor(); wireToolbar(); wireRefs();
    $("#new-paper").addEventListener("click", startSetup);
    $("#ab-mark").addEventListener("change", markAbbr);
    $("#ab-copy").addEventListener("click", copyAbbr);
    document.addEventListener("studio-tab", (e) => { if (e.detail === "abbr" && !$("#ab-mark").dataset.touched) { $("#ab-mark").checked = true; markAbbr(); } });
    $("#ab-mark").addEventListener("click", () => { $("#ab-mark").dataset.touched = "1"; });
    $("#new-paper-2").addEventListener("click", startSetup);
    for (const id of ["#import-home", "#import-editor"]) $(id).addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importWord(f); });
    if (window.GSAccount && window.GSAccount.onRemote) window.GSAccount.onRemote("studio", () => {
      if (document.body.dataset.view === "home") renderHome();
      else if (paper && !saveTimer && document.activeElement !== page()) { const fresh = store.get(paper.id); if (fresh && fresh.updated > paper.updated) openPaper(paper.id, "Updated with changes from your other device."); }
    });
    const open = location.hash.replace(/^#/, "");
    if (open && store.get(open)) openPaper(open); else renderHome();
  }
  window.GSStudio = { template, vancouver, compress, blocks: () => blocks(), state: () => paper,
    api: { $, $$, esc, blank, page, paper: () => paper, save, scheduleSave, refresh, toast, rpc, track, insertAfterBlock, restoreRange,
      addRef, insertCite, renumber, citedRefs, formatRef, makeWord, download, fileName, openTab, jump, KINDS } };
  start();
})();
