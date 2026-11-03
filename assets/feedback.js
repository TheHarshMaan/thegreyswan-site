// The Grey Swan: feedback button and visit counting, on every page.
//
// Feedback: a "Feedback" button opens a short form. Sending opens the visitor's email (their mail app or Gmail) with
// the message filled in; nothing is sent from the page itself. The address is shown too, for anyone without either.
//
// Visits: GoatCounter (goatcounter.com), no cookies, counts page views and a few anonymous events (a check run, a report
// downloaded). Never file names, file contents, references or the names of people checked. Switched off until
// GOATCOUNTER_CODE is set, and never counted on this computer's own test server (localhost).
(function () {
  "use strict";
  const GOATCOUNTER_CODE = "thegreyswan";        // https://thegreyswan.goatcounter.com
  const FEEDBACK_EMAIL = "harsh@thegreyswan.in";

  const here = document.currentScript && document.currentScript.src;

  // ---------- Visit counting ----------
  const queue = [];
  window.GS_EVENT = function (name) {
    if (!name) return;
    if (window.goatcounter && window.goatcounter.count) {
      try { window.goatcounter.count({ path: String(name), title: String(name), event: true }); } catch (e) { /* ignore */ }
    } else queue.push(name);
  };
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname) || location.protocol === "file:";
  if (GOATCOUNTER_CODE && !local) {
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://gc.zgo.at/count.js";
    s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
    s.onload = () => { while (queue.length) window.GS_EVENT(queue.shift()); };
    document.head.appendChild(s);
  }

  // ---------- Feedback ----------
  if (here) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = here.replace(/feedback\.js(\?.*)?$/, "feedback.css");
    document.head.appendChild(css);
  }

  const PAGES = { "/checker/": "GS Screening Tool", "/references/": "Reference Integrity", "/researchers/": "Cygnus",
                  "/tracker/": "Reviewer Tracker", "/account/": "Account", "/privacy/": "Privacy page", "/": "Home page" };
  function pageName() {
    const p = location.pathname.replace(/index\.html$/, "");
    const key = Object.keys(PAGES).find((k) => k !== "/" && p.endsWith(k)) || "/";
    return PAGES[key];
  }

  function build() {
    if (document.getElementById("gs-fb-open")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "gs-fb-open";
    btn.className = "gs-fb-open";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.textContent = "Feedback";
    document.body.appendChild(btn);

    const box = document.createElement("div");
    box.className = "gs-fb";
    box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "false");
    box.setAttribute("aria-labelledby", "gs-fb-title");
    box.innerHTML = `
      <div class="gs-fb-head"><h2 id="gs-fb-title">Tell us what you think</h2>
        <button type="button" class="gs-fb-x" aria-label="Close">×</button></div>
      <fieldset class="gs-fb-kind"><legend>This is about</legend>
        <label><input type="radio" name="gs-fb-kind" value="Something broke" checked> Something broke</label>
        <label><input type="radio" name="gs-fb-kind" value="Something missed or wrong"> It missed or got something wrong</label>
        <label><input type="radio" name="gs-fb-kind" value="Suggestion"> A suggestion</label>
        <label><input type="radio" name="gs-fb-kind" value="Question"> A question</label>
      </fieldset>
      <label class="gs-fb-field">What happened, or what would help?
        <textarea id="gs-fb-text" rows="5" placeholder="Please don't paste confidential manuscript text"></textarea></label>
      <label class="gs-fb-check"><input type="checkbox" id="gs-fb-details" checked> Add the page and browser, to help find the problem</label>
      <div class="gs-fb-send">
        <button type="button" class="gs-fb-btn primary" data-send="mail">Open in my email app</button>
        <button type="button" class="gs-fb-btn" data-send="gmail">Send with Gmail</button>
        <button type="button" class="gs-fb-btn" data-send="copy">Copy</button>
      </div>
      <p class="gs-fb-note">Your message opens in your own email, ready to send. Or write to
        <a href="mailto:${FEEDBACK_EMAIL}">${FEEDBACK_EMAIL}</a>.</p>
      <p class="gs-fb-status" aria-live="polite"></p>`;
    document.body.appendChild(box);

    const text = box.querySelector("#gs-fb-text");
    const status = box.querySelector(".gs-fb-status");
    const open = () => { box.hidden = false; btn.setAttribute("aria-expanded", "true"); status.textContent = ""; text.focus(); };
    const close = () => { box.hidden = true; btn.setAttribute("aria-expanded", "false"); btn.focus(); };
    btn.addEventListener("click", () => (box.hidden ? open() : close()));
    box.querySelector(".gs-fb-x").addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !box.hidden) close(); });

    function message() {
      const kind = box.querySelector("input[name=gs-fb-kind]:checked").value;
      const subject = `The Grey Swan feedback: ${kind} (${pageName()})`;
      let body = text.value.trim();
      if (box.querySelector("#gs-fb-details").checked) {
        body += `\n\n---\nPage: ${location.origin}${location.pathname}\nBrowser: ${navigator.userAgent}\n` +
          `Screen: ${window.innerWidth}×${window.innerHeight}\nDate: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
      }
      return { subject, body };
    }

    box.querySelector(".gs-fb-send").addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (!text.value.trim()) { status.textContent = "Please write a few words first."; text.focus(); return; }
      const { subject, body } = message();
      const how = b.dataset.send;
      window.GS_EVENT("feedback-" + how);
      if (how === "mail") {
        location.href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        status.textContent = "Your email app should open now. If nothing happened, use Gmail or Copy instead.";
      } else if (how === "gmail") {
        window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(FEEDBACK_EMAIL)}` +
          `&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_blank", "noopener");
        status.textContent = "Gmail opened in a new tab, ready to send.";
      } else {
        try {
          await navigator.clipboard.writeText(`To: ${FEEDBACK_EMAIL}\nSubject: ${subject}\n\n${body}`);
          status.textContent = `Copied. Paste it into an email to ${FEEDBACK_EMAIL}.`;
        } catch (err) { status.textContent = `Couldn't copy. Please write to ${FEEDBACK_EMAIL}.`; }
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
