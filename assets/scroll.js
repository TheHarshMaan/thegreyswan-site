/* The Grey Swan: still side rails with the page scrolling between them.
   Each page describes its own look before loading this file:

     window.GS_SCROLL = {
       width: 1180,                         // width of the page's content column, in px
       title: "Screening · Pre-submission", // vertical text on the left rail
       motif: "lines" | "cites" | "dates",  // what drifts past on the left rail
       nav: [{ label, target: "#css-selector" } or { label, tab: "tab-name", target }],
       reveal: ".card, .note",              // things that fade up as they come into view
       readout(el) { ... },                 // optional: fill the live readout on the right rail
       watch: "#results",                   // optional: refresh the readout when this part of the page changes
     };

   The rails only appear when the screen is wide enough to have empty space at the sides; phones and small
   laptops see the page as before. Visitors who ask for reduced motion get no animation. */
(function () {
  "use strict";
  const C = window.GS_SCROLL || {};
  const WIDTH = C.width || 1180;
  const MIN_SIDE = 90;                                   // px of empty space needed on each side
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;
  root.classList.add("gs-js");
  root.style.setProperty("--gs-width", WIDTH + "px");

  const STAR = '<path d="M10 0C10.8 6.5 13.5 9.2 20 10C13.5 10.8 10.8 13.5 10 20C9.2 13.5 6.5 10.8 0 10C6.5 9.2 9.2 6.5 10 0Z"/>';
  const mark = (where) => `<svg class="gs-mark ${where}" viewBox="0 0 20 20" aria-hidden="true">${STAR}</svg>`;
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- The drifting motif on the left rail ----------
  const STEP = 46;                                       // px between motif items
  function motifItems(kind, count) {
    const out = [];
    if (kind === "lines") {                              // manuscript line numbers, every fifth line
      for (let i = 1; i <= count; i++) out.push(String(i * 5));
    } else if (kind === "cites") {                       // citation markers, as they appear in a manuscript
      for (let i = 1; i <= count; i++) out.push(i % 4 === 0 ? `[${i}–${i + 2}]` : i % 7 === 0 ? `[${i}, ${i + 5}]` : `[${i}]`);
    } else if (kind === "dates") {                       // an invitation timeline, a week apart, around today
      const day = 86400000, now = Date.now();
      for (let i = 0; i < count; i++) {
        const offset = i - Math.round((innerHeight * 0.76) / 2 / STEP);   // today level with the middle at the top of the page
        const d = new Date(now + offset * 7 * day);
        out.push({ text: offset === 0 ? "Today" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), today: offset === 0 });
      }
    }
    return out;
  }

  // ---------- Build the rails ----------
  const left = document.createElement("aside");
  left.className = "gs-rail gs-rail-left";
  left.setAttribute("aria-hidden", "true");
  const items = C.motif ? motifItems(C.motif, 400) : [];
  left.innerHTML = `<div class="gs-line"></div><div class="gs-progress"></div>
    ${items.length ? `<div class="gs-motif ${esc(C.motif)}"><div class="gs-motif-track">${items.map((it, i) => {
      const o = typeof it === "string" ? { text: it } : it;
      return `<div class="gs-motif-item${o.today ? " today" : ""}" style="top:${i * STEP}px">${esc(o.text)}</div>`;
    }).join("")}</div></div>` : ""}
    ${mark("top")}${mark("bottom")}
    ${C.title ? `<div class="gs-title">${esc(C.title)}</div>` : ""}`;

  const right = document.createElement("aside");
  right.className = "gs-rail gs-rail-right";
  right.setAttribute("aria-label", "Sections of this page");
  right.innerHTML = `<div class="gs-line"></div>${mark("top")}${mark("bottom")}
    <ul class="gs-nav">${(C.nav || []).map((n, i) =>
      `<li><button type="button" data-i="${i}" aria-label="${esc(n.label)}"><span>${esc(n.label)}</span></button></li>`).join("")}</ul>
    <div class="gs-readout" hidden></div>`;

  const sheet = Object.assign(document.createElement("div"), { className: "gs-sheet" });
  const glow = Object.assign(document.createElement("div"), { className: "gs-glow" });

  function mount() {
    document.body.prepend(glow, sheet, left, right);
    setUp();
  }

  // ---------- Behaviour ----------
  let ticking = false;
  const bar = left.querySelector(".gs-progress");
  const track = left.querySelector(".gs-motif-track");
  const motifBox = left.querySelector(".gs-motif");
  const buttons = right.querySelectorAll(".gs-nav button");
  const readout = right.querySelector(".gs-readout");

  function wide() { return (window.innerWidth - WIDTH) / 2 >= MIN_SIDE; }

  function current() {
    // Tabs (tracker): the open tab. Sections: the last one whose top has passed 40% of the screen.
    let active = 0;
    (C.nav || []).forEach((n, i) => {
      if (n.tab) {
        const b = document.querySelector(`[data-tab="${n.tab}"]`);
        if (b && b.getAttribute("aria-selected") === "true") active = i;
        return;
      }
      const el = n.target && document.querySelector(n.target);
      if (el && el.offsetParent !== null && el.getBoundingClientRect().top < innerHeight * 0.4) active = i;
    });
    if (!(C.nav || []).some((n) => n.tab) && innerHeight + scrollY >= document.documentElement.scrollHeight - 2) active = (C.nav || []).length - 1;
    return active;
  }

  function update() {
    ticking = false;
    root.classList.toggle("gs-rails", wide());
    if (!wide()) return;
    const y = scrollY, h = document.documentElement.scrollHeight - innerHeight;
    bar.style.height = (h > 0 ? Math.min(1, y / h) : 0) * 76 + "vh";
    if (track && !reduce) {
      const shift = y * 0.35;
      track.style.transform = `translateY(${-shift}px)`;
      // light up the item level with the middle of the screen, like a reading line
      const mid = motifBox.clientHeight / 2 + shift;
      const near = Math.round(mid / STEP);
      track.querySelectorAll(".near").forEach((e) => e.classList.remove("near"));
      const el = track.children[near];
      if (el) el.classList.add("near");
    }
    const a = current();
    buttons.forEach((b, i) => b.classList.toggle("active", i === a));
  }
  const queue = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };

  function go(i) {
    const n = C.nav[i];
    if (n.tab) { const b = document.querySelector(`[data-tab="${n.tab}"]`); if (b) b.click(); }
    const el = n.target && document.querySelector(n.target);
    if (el) {
      const top = el.getBoundingClientRect().top + scrollY - (C.offset || 24);
      window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    }
    setTimeout(update, 50);
  }

  function refreshReadout() {
    if (!C.readout) return;
    const html = C.readout();
    readout.hidden = !html;
    if (html) readout.innerHTML = html;
  }

  function setUp() {
    buttons.forEach((b) => b.addEventListener("click", () => go(+b.dataset.i)));
    addEventListener("scroll", queue, { passive: true });
    addEventListener("resize", queue);
    document.addEventListener("click", (e) => { if (e.target.closest("[data-tab]")) setTimeout(queue, 30); });

    // Fade-up for the page's static parts (never for results that redraw)
    if (C.reveal && "IntersectionObserver" in window && !reduce) {
      const io = new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("gs-in"); io.unobserve(e.target); }
      }), { rootMargin: "0px 0px -6% 0px" });
      document.querySelectorAll(C.reveal).forEach((el, i) => {
        if (el.getBoundingClientRect().top < innerHeight) return;    // already on screen: leave it be
        el.classList.add("gs-reveal");
        el.style.transitionDelay = (i % 3) * 70 + "ms";
        io.observe(el);
      });
    }

    if (C.readout) {
      refreshReadout();
      const target = C.watch && document.querySelector(C.watch);
      if (target) {
        let t = null;
        new MutationObserver(() => { clearTimeout(t); t = setTimeout(refreshReadout, 120); })
          .observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "aria-selected"] });
      }
      if (C.every) setInterval(refreshReadout, C.every);
    }
    update();
  }

  window.GSScroll = { refresh: () => { refreshReadout(); update(); } };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", mount) : mount();
})();
