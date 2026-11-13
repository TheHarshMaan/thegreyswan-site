// The Grey Swan Studio: desk notes.
// Reads the paper as it is written and lists what a journal's screening desk would ask about.
// Pure functions over the page's DOM; nothing leaves the browser. Used by studio.js.

(function (global) {
  "use strict";

  // Abbreviations journals usually accept without spelling out, plus Roman numerals and units.
  const ABBR_OK = new Set(["DNA", "RNA", "USA", "UK", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII",
    "SD", "SE", "CI", "OR", "HR", "RR", "IQR", "BMI", "ID", "PDF", "URL", "DOI", "AM", "PM", "UTC",
    // names of reporting guidelines and registries, which journals use as names
    "CONSORT", "STROBE", "PRISMA", "CARE", "ARRIVE", "SRQR", "COREQ", "PROSPERO", "STARD", "TRIPOD", "SPIRIT", "CHEERS", "SQUIRE", "RECORD", "MOOSE", "CTRI", "CLSI", "EUCAST"]);

  // Degrees and honours that follow authors' names ("Asha Verma, MD,"): not abbreviations to spell out there.
  const DEGREES = new Set(["MD", "MS", "MA", "MPH", "MSC", "MBBS", "BDS", "MDS", "DM", "DNB", "MCH", "BS", "BA", "BSC", "MBA", "RN", "DO", "DDS",
    "FRCP", "MRCP", "FRCS", "MRCS", "FACS", "FACP", "MSPH", "DRPH", "SCD", "MPHIL", "DPHIL", "MBCHB", "PHARMD", "MPT", "BPT", "MDS"]);

  // Common species: abbreviated form -> full name, so a note can offer the fix.
  const SPECIES = {
    "E. coli": "Escherichia coli", "S. aureus": "Staphylococcus aureus", "S. epidermidis": "Staphylococcus epidermidis",
    "K. pneumoniae": "Klebsiella pneumoniae", "P. aeruginosa": "Pseudomonas aeruginosa", "A. baumannii": "Acinetobacter baumannii",
    "E. faecalis": "Enterococcus faecalis", "E. faecium": "Enterococcus faecium", "M. tuberculosis": "Mycobacterium tuberculosis",
    "C. albicans": "Candida albicans", "C. auris": "Candida auris", "S. pneumoniae": "Streptococcus pneumoniae",
    "S. pyogenes": "Streptococcus pyogenes", "S. agalactiae": "Streptococcus agalactiae", "S. typhi": "Salmonella Typhi",
    "H. influenzae": "Haemophilus influenzae", "H. pylori": "Helicobacter pylori", "N. meningitidis": "Neisseria meningitidis",
    "C. difficile": "Clostridioides difficile", "L. monocytogenes": "Listeria monocytogenes", "P. falciparum": "Plasmodium falciparum",
    "P. vivax": "Plasmodium vivax", "V. cholerae": "Vibrio cholerae", "B. subtilis": "Bacillus subtilis", "M. musculus": "Mus musculus",
    "S. cerevisiae": "Saccharomyces cerevisiae", "A. thaliana": "Arabidopsis thaliana", "D. melanogaster": "Drosophila melanogaster",
    "C. elegans": "Caenorhabditis elegans", "E. cloacae": "Enterobacter cloacae", "P. mirabilis": "Proteus mirabilis"
  };
  const GENERA = ["Escherichia", "Staphylococcus", "Klebsiella", "Pseudomonas", "Acinetobacter", "Enterococcus", "Mycobacterium",
    "Candida", "Streptococcus", "Salmonella", "Shigella", "Haemophilus", "Helicobacter", "Neisseria", "Clostridioides", "Clostridium",
    "Listeria", "Plasmodium", "Vibrio", "Bacillus", "Mus", "Rattus", "Saccharomyces", "Arabidopsis", "Drosophila", "Caenorhabditis",
    "Danio", "Enterobacter", "Proteus", "Serratia", "Citrobacter", "Aspergillus", "Cryptococcus", "Leishmania", "Trypanosoma"];
  const GENUS_RE = new RegExp("\\b(" + GENERA.join("|") + ")\\s([a-z]{3,})\\b", "g");

  function words(text) { const m = (text || "").trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu); return m ? m.length : 0; }

  // The paper's sections: each h2 and everything up to the next h2.
  function sections(page) {
    const out = [];
    let cur = null;
    for (const el of page.children) {
      if (el.tagName === "H2") { cur = { head: el, title: el.textContent.trim(), els: [] }; out.push(cur); continue; }
      if (cur) cur.els.push(el);
    }
    return out;
  }

  // Text nodes of the written body (not headings, captions or the generated reference list), with their elements.
  function bodyTextNodes(page) {
    const nodes = [];
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const el = n.parentElement;
        if (!el || el.closest("h1, h2, h3, .kicker, .authors, .refs-out, .cite, .caption, [data-hint-only]")) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function italic(node) { return !!(node.parentElement && node.parentElement.closest("i, em")); }

  function analyse(page, meta) {
    meta = meta || {};
    const notes = [], good = [];
    const secs = sections(page);
    const find = (name) => secs.find((s) => s.title.toLowerCase().startsWith(name));

    // 1. Details still to fill in
    const blanks = [...page.querySelectorAll(".blank")];
    if (blanks.length) notes.push({ id: "blanks", level: "warn", title: blanks.length === 1 ? "1 detail still to fill in" : `${blanks.length} details still to fill in`,
      body: "The underlined bits: committee names, numbers, dates. Click to go to the first one.", target: blanks[0] });

    // 2. Abstract length
    const abs = find("abstract");
    if (abs) {
      const n = words(abs.els.map((e) => e.textContent).join(" "));
      const limit = meta.abstractLimit || 250;
      if (n > limit) notes.push({ id: "abstract", level: "warn", title: `Abstract is ${n} words`, body: `Most journals allow ${limit}. Trim ${n - limit}.`, target: abs.head });
      else if (n > 0) good.push(`abstract ${n} of ${limit} words`);
    }

    const textNodes = bodyTextNodes(page);
    const full = textNodes.map((n) => n.nodeValue).join("\n");

    // 3. Abbreviations: used before (or without) being spelled out.
    // The front matter (author names, degrees, affiliations, state codes) is skipped when the paper has headings.
    const firstHead = page.querySelector("h2");
    const inFront = (node) => firstHead && !!(firstHead.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
    const seen = new Map();
    const ABBR = /\b([A-Z][A-Z0-9]{1,6})(s?)\b/g;
    for (const node of textNodes) {
      let m;
      ABBR.lastIndex = 0;
      while ((m = ABBR.exec(node.nodeValue))) {
        const a = m[1];
        if (ABBR_OK.has(a) || /^\d/.test(a) || /^[A-Z]\d+$/.test(a)) continue;
        if (inFront(node)) continue;
        if (DEGREES.has(a) && /,\s*$/.test(node.nodeValue.slice(Math.max(0, m.index - 3), m.index))) continue;
        if (!seen.has(a)) seen.set(a, { node, index: m.index });
      }
    }
    for (const [a, first] of seen) {
      const def = full.indexOf("(" + a + ")"), def2 = full.indexOf("(" + a + "s)");
      const defined = def >= 0 || def2 >= 0;
      const firstPos = textNodes.indexOf(first.node);
      const defPos = defined ? positionOf(textNodes, def >= 0 ? def : def2) : -1;
      if (!defined) notes.push({ id: "abbr-" + a, level: "warn", title: `${a} isn’t spelled out`, body: `Write it in full the first time, with ${a} in brackets after it.`, target: first.node.parentElement, word: a, node: first.node, at: first.index, len: a.length });
      else if (defPos > firstPos) notes.push({ id: "abbr-" + a, level: "warn", title: `${a} is used before it’s spelled out`, body: "Move the full form to its first use.", target: first.node.parentElement, word: a, node: first.node, at: first.index, len: a.length });
    }

    // 4. Species names: abbreviated before the full name, or not in italics
    const fullSeen = new Set();
    for (const node of textNodes) {
      GENUS_RE.lastIndex = 0;
      let g;
      while ((g = GENUS_RE.exec(node.nodeValue))) {
        fullSeen.add(g[1][0] + ". " + g[2]);
        if (!italic(node)) notes.push({ id: "ital-" + g[0], level: "warn", title: `${g[0]} should be in italics`, body: "Species names are italic.", target: node.parentElement, node, at: g.index, len: g[0].length, fix: { kind: "italic", text: g[0] } });
      }
      const ABBR_SP = /\b([A-Z])\.\s?([a-z]{3,})\b/g;
      let s;
      while ((s = ABBR_SP.exec(node.nodeValue))) {
        const key = s[1] + ". " + s[2];
        if (fullSeen.has(key)) continue;
        const fullName = SPECIES[key];
        notes.push({ id: "sp-" + key, level: "warn", title: `Write ${key} in full the first time`,
          body: fullName ? `${fullName}, in italics. After that, ${key} is fine.` : "The genus in full the first time, in italics.",
          target: node.parentElement, node, at: s.index, len: s[0].length, fix: fullName ? { kind: "species", text: s[0], to: fullName } : null });
        fullSeen.add(key);
      }
    }

    // 5. Figures and tables: captions vs mentions in the text
    const caps = { Figure: new Map(), Table: new Map() };
    for (const c of page.querySelectorAll(".caption")) {
      const m = c.textContent.trim().match(/^(Fig(?:ure)?\.?|Table)\s*(\d+)/i);
      if (m) caps[/^t/i.test(m[1]) ? "Table" : "Figure"].set(+m[2], c);
    }
    const mentions = { Figure: [], Table: [] };
    const MENTION = /\b(Fig(?:ure)?s?\.?|Tables?)\s*(\d+)(?:\s*(?:[–-]|and|,)\s*(\d+))?/gi;
    for (const node of textNodes) {
      let m;
      MENTION.lastIndex = 0;
      while ((m = MENTION.exec(node.nodeValue))) {
        const kind = /^t/i.test(m[1]) ? "Table" : "Figure";
        const a = +m[2], b = m[3] ? +m[3] : a;
        for (let k = a; k <= Math.min(b, a + 20); k++) mentions[kind].push({ n: k, node, at: m.index, len: m[0].length });
      }
    }
    for (const kind of ["Table", "Figure"]) {
      const mentioned = new Set(mentions[kind].map((x) => x.n));
      for (const [n, el] of caps[kind]) if (!mentioned.has(n)) notes.push({ id: `uncited-${kind}${n}`, level: "warn", title: `${kind} ${n} isn’t mentioned in the text`, body: "Journals ask for every table and figure to be cited, in order.", target: el });
      for (const n of mentioned) if (!caps[kind].has(n)) {
        const where = mentions[kind].find((x) => x.n === n);
        notes.push({ id: `missing-${kind}${n}`, level: "warn", title: `${kind} ${n} is mentioned, but there’s no ${kind} ${n}`, body: `Add it with + ${kind === "Table" ? "Table" : "Figure"}, or check the number.`, target: where.node.parentElement, node: where.node, at: where.at, len: where.len });
      }
      const order = [];
      for (const x of mentions[kind]) if (!order.includes(x.n)) order.push(x.n);
      for (let i = 1; i < order.length; i++) if (order[i] < order[i - 1]) {
        const where = mentions[kind].find((x) => x.n === order[i - 1]);
        notes.push({ id: `order-${kind}`, level: "warn", title: `${kind}s are first cited out of order`, body: `${kind} ${order[i - 1]} is mentioned before ${kind} ${order[i]}. Number them in the order they first appear.`, target: where.node.parentElement, node: where.node, at: where.at, len: where.len });
        break;
      }
      if (caps[kind].size && [...caps[kind].keys()].every((n) => mentioned.has(n))) good.push(`${kind.toLowerCase()}s all cited`);
    }

    // 6. Do the numbers add up?
    if (global.GSNumbers) {
      const N = global.GSNumbers;
      for (const r of N.checkReportedTests(full)) {
        const i = positionOf(textNodes, r.at), node = textNodes[i];
        const off = node ? r.at - textNodes.slice(0, i).reduce((t, n) => t + n.nodeValue.length + 1, 0) : 0;
        const fits = node && off >= 0 && off + r.text.length <= node.nodeValue.length;
        notes.push({ id: "p-" + r.at, level: r.crosses ? "bad" : "warn", title: r.title, body: r.body, target: node ? node.parentElement : page,
          node: fits ? node : null, at: off, len: r.text.length });
      }
      const tables = [];
      for (const t of page.querySelectorAll("table")) {
        let cap = t.previousElementSibling;
        const label = cap && cap.classList.contains("caption") ? (cap.textContent.match(/^(Table\s*\d+)/i) || ["A table"])[0] : "A table";
        const rows = [...t.rows].map((r) => [...r.cells].map((c) => c.textContent));
        tables.push({ rows, el: t });
        for (const x of N.checkTable(rows, label)) {
          const cell = t.rows[x.row] && t.rows[x.row].cells[x.col];
          notes.push({ id: `tab-${label}-${x.row}-${x.col}`, level: "warn", title: x.title, body: x.body, target: cell || t });
        }
      }
      if (abs) for (const x of N.checkAbstractVsTables(abs.els.map((e) => e.textContent).join(" "), tables))
        notes.push({ id: "n-" + x.n, level: "warn", title: x.title, body: x.body, target: abs.head });
    }

    // 7. Consent when people took part
    if (meta.people === "humans" && !/consent/i.test(page.textContent)) {
      const d = find("declarations") || find("methods");
      notes.push({ id: "consent", level: "warn", title: "Say how consent was given", body: "Written or verbal, and who gave it (for children: parents or guardians).", target: d ? d.head : page });
    }

    // 8. References flagged by Crossref
    for (const r of (meta.refs || [])) if (r.retracted && r.cited) notes.push({ id: "retracted-" + r.id, level: "bad", title: `Reference ${r.n} has been retracted`, body: r.short || "", target: page.querySelector(`.cite[data-refs~="${r.id}"]`) || page });

    return { notes, good };
  }

  // Which text node holds character position `pos` of the joined text (joined with "\n").
  function positionOf(nodes, pos) {
    let at = 0;
    for (let i = 0; i < nodes.length; i++) { const len = nodes[i].nodeValue.length + 1; if (pos < at + len) return i; at += len; }
    return nodes.length;
  }

  global.GSNotes = { analyse, sections, words, SPECIES };
})(window);
