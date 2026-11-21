// The Grey Swan Editorial: "Leave a mark", the night sky on the homepage.
//
// Every visitor can place one star a day. Stars are kept by The Grey Swan Engine (engine/worker.js): only the star's
// position and date, and a count per day and per country. Nothing about the visitor is stored. If the engine isn't
// set up (assets/engine.js empty) or can't be reached, the section stays hidden.
(function () {
  "use strict";
  const section = document.getElementById("marks");
  const engine = (window.GS_ENGINE || "").replace(/\/$/, "");
  if (!section || !engine) return;

  const sky = document.getElementById("marks-sky");
  const stars = document.getElementById("marks-stars");
  const lines = document.getElementById("marks-lines");
  const count = document.getElementById("marks-count");
  const note = document.getElementById("marks-note");
  const button = document.getElementById("marks-button");
  const NS = "http://www.w3.org/2000/svg";
  const W = 1000, H = 360;
  const today = () => new Date().toISOString().slice(0, 10);
  const mine = () => { try { return JSON.parse(localStorage.getItem("gs-mark") || "null"); } catch (e) { return null; } };
  let busy = false;

  function draw(data, yours) {
    stars.textContent = "";
    lines.textContent = "";
    const marks = data.marks || [];
    // Faint lines between stars placed one after the other, when they're close: constellations grow by themselves
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i - 1], b = marks[i];
      if (Math.hypot(a.x - b.x, (a.y - b.y) * (H / W)) > 0.14) continue;
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", a.x * W); l.setAttribute("y1", a.y * H);
      l.setAttribute("x2", b.x * W); l.setAttribute("y2", b.y * H);
      lines.appendChild(l);
    }
    const t = today();
    marks.forEach((m, i) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", m.x * W); c.setAttribute("cy", m.y * H);
      c.setAttribute("r", m.d === t ? 3.2 : 2.2 + ((i * 7) % 3) * 0.3);
      c.setAttribute("class", m.d === t ? "star new" : "star");
      stars.appendChild(c);
    });
    if (yours) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", yours.x * W); c.setAttribute("cy", yours.y * H); c.setAttribute("r", 5);
      c.setAttribute("class", "star yours");
      stars.appendChild(c);
    }
    const n = data.total || 0, countries = Object.keys(data.countries || {}).length;
    count.innerHTML = n
      ? `<b>${n.toLocaleString()}</b> ${n === 1 ? "star" : "stars"} left by visitors` +
        (data.today ? ` · <b>${data.today}</b> today` : "") + (countries > 1 ? ` · from <b>${countries}</b> countries` : "")
      : "No stars yet. Be the first.";
  }

  function placed() {
    const m = mine();
    return m && m.day === today() ? m : null;
  }

  async function leave(x, y) {
    if (busy) return;
    if (placed()) { note.textContent = "You've left your mark today. Thank you, and come back tomorrow for another."; return; }
    busy = true;
    note.textContent = "Placing your star…";
    try {
      const r = await fetch(`${engine}/marks`, { method: "POST", headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ x, y }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { note.textContent = data.error || "Your star couldn't be placed just now. Try again in a moment."; return; }
      const m = { x, y, day: today(), number: data.number };
      try { localStorage.setItem("gs-mark", JSON.stringify(m)); } catch (e) { /* private mode */ }
      draw(data, m);
      note.textContent = `Thank you. Yours is star number ${Number(data.number).toLocaleString()}.`;
      if (window.goatcounter && window.goatcounter.count) {
        try { window.goatcounter.count({ path: "left-a-mark", title: "left-a-mark", event: true }); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      note.textContent = "Your star couldn't be placed just now. Try again in a moment.";
    } finally {
      busy = false;
    }
  }

  sky.addEventListener("click", (e) => {
    const box = sky.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    leave(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
  });
  button.addEventListener("click", () => leave(Math.round((0.08 + Math.random() * 0.84) * 1000) / 1000,
                                               Math.round((0.12 + Math.random() * 0.76) * 1000) / 1000));

  fetch(`${engine}/marks`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data) => {
      section.hidden = false;
      const m = placed();
      draw(data, m && !(data.marks || []).some((s) => s.x === m.x && s.y === m.y) ? m : null);
      if (m) note.textContent = "You've left your mark today. Thank you.";
    })
    .catch(() => { section.hidden = true; });
})();
