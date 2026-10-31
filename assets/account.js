/* The Grey Swan: accounts and sync
   =====================================================================
   Sign in with Google, and everything saved by the tools (reviewer tracker, checker settings and history,
   reference checks, your profile) is kept in a private app folder in YOUR OWN Google Drive, so it follows you
   to any device. The Grey Swan has no server and never sees the data.

   How it works
   - Every tool keeps working exactly as before, saving to this browser (localStorage). That copy is the one
     the page uses, so nothing waits for the internet.
   - When you're signed in, each saved "store" is also kept as a small JSON file in the app's hidden folder in
     your Drive (the drive.appdata permission: the app can only see its own folder, never your other files).
   - Syncing is a three-way merge: what this device last synced (the base), what's here now, and what's in
     Drive now. Records are matched by id, so adding on two devices keeps both; an edit wins over no edit;
     and something deleted on one device and untouched on the other stays deleted.

   Used by the pages
     GSAccount.get(store)               -> the store's data (an object)
     GSAccount.set(store, data)         -> save it here and sync it
     GSAccount.changed(store)           -> "I saved it myself; sync it" (the tracker saves on its own)
     GSAccount.onRemote(store, fn)      -> fn() after newer data from another device was merged in
     GSAccount.onChange(fn)             -> fn(state) whenever sign-in or sync state changes
   ===================================================================== */
(function () {
  "use strict";

  // The OAuth client ID from Google Cloud (APIs & Services -> Credentials). Safe to publish.
  const CLIENT_ID = "PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  const SCOPES = "openid email profile " + DRIVE_SCOPE;
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

  // Everything that's saved, and the file each is kept in
  const STORES = {
    profile:    { key: "gs-profile",                    file: "profile.json",    label: "Your profile" },
    tracker:    { key: "greyswan-reviewer-tracker-v1",  file: "tracker.json",    label: "Reviewer tracker" },
    checker:    { key: "gs-checker",                    file: "checker.json",    label: "Manuscript checker" },
    references: { key: "gs-references",                 file: "references.json", label: "Reference checks" },
  };
  const ACCOUNT_KEY = "gs-account";      // {user, token, expires, owner}
  const BASE_KEY = "gs-sync-base:";      // + store: the copy last agreed with Drive
  const LAST_SYNC_KEY = "gs-last-sync";

  // ---------- Small helpers ----------
  const store = {
    read(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; } },
    write(key, value) {
      try {
        value === null || value === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) { return false; }
    },
  };

  // JSON with sorted keys, so the same data always compares equal
  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
    }
    return JSON.stringify(value === undefined ? null : value);
  }
  const same = (a, b) => stable(a) === stable(b);
  const isRecordList = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => x && typeof x === "object" && "id" in x);

  function mergeLists(base, local, remote) {
    const byId = (list) => new Map(list.map((x) => [x.id, x]));
    const B = byId(base), L = byId(local), R = byId(remote);
    const order = [...L.keys(), ...[...R.keys()].filter((id) => !L.has(id))];
    const out = [];
    for (const id of order) {
      const b = B.get(id), l = L.get(id), r = R.get(id);
      if (l && r) out.push(!b || !same(l, b) ? l : r);        // edited here wins; otherwise take Drive's
      else if (l) { if (!(b && same(l, b))) out.push(l); }    // gone from Drive: deleted there, unless edited here
      else if (r) { if (!(b && same(r, b))) out.push(r); }    // gone from here: deleted here, unless edited there
    }
    return out;
  }

  // Three-way merge of two versions of a store, field by field
  function merge(base, local, remote) {
    base = base || {}; local = local || {}; remote = remote || {};
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])) {
      const b = base[k], l = local[k], r = remote[k];
      let v;
      if (isRecordList(b) || isRecordList(l) || isRecordList(r)) v = mergeLists(b || [], l || [], r || []);
      else v = !same(l, b) ? l : !same(r, b) ? r : l;
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  // ---------- State ----------
  let account = store.read(ACCOUNT_KEY);       // null when signed out
  let status = "idle";                         // idle | syncing | synced | offline | reconnect | error
  let message = "";
  const listeners = [], remoteListeners = {};
  const fileIds = {};
  let tokenClient = null, gisLoading = null, pendingSignIn = null;

  function state() {
    return { signedIn: !!account, user: account && account.user, status, message,
             lastSync: store.read(LAST_SYNC_KEY), stores: STORES };
  }
  function emit() { listeners.forEach((fn) => { try { fn(state()); } catch (e) { console.error(e); } }); renderChip(); }
  function setStatus(s, msg) { status = s; message = msg || ""; emit(); }

  function token() {
    return account && account.token && account.expires > Date.now() + 60000 ? account.token : null;
  }

  // ---------- Google sign-in ----------
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisLoading = null; reject(new Error("Google sign-in couldn't load. Check your connection.")); };
      document.head.appendChild(s);
    });
    return gisLoading;
  }

  function getTokenClient() {
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        const done = pendingSignIn; pendingSignIn = null;
        if (resp.error) return done && done.reject(new Error(resp.error_description || resp.error));
        done && done.resolve(resp);
      },
      error_callback: (err) => {
        const done = pendingSignIn; pendingSignIn = null;
        const text = err && err.type === "popup_closed" ? "Sign-in was closed before it finished."
          : err && err.type === "popup_failed_to_open" ? "Your browser blocked the sign-in window. Allow pop-ups for this site and try again."
          : "Sign-in didn't complete.";
        done && done.reject(new Error(text));
      },
    });
    return tokenClient;
  }

  // Must be called from a click (browsers only allow the Google window to open after one)
  async function signIn() {
    try {
      await loadGis();
    } catch (e) { setStatus(account ? "reconnect" : "error", e.message); return false; }
    const resp = await new Promise((resolve, reject) => {
      pendingSignIn = { resolve, reject };
      const hint = account && account.user && account.user.email;
      getTokenClient().requestAccessToken(Object.assign({ prompt: account ? "" : "select_account" }, hint ? { login_hint: hint } : {}));
    }).catch((e) => { setStatus(account ? "reconnect" : "idle", e.message); return null; });
    if (!resp) return false;

    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
      setStatus(account ? "reconnect" : "idle",
        "To save your work, tick “See, create and delete its own configuration data in your Google Drive” when Google asks.");
      return false;
    }
    let user;
    try {
      const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + resp.access_token } });
      if (!r.ok) throw new Error();
      const u = await r.json();
      user = { id: u.sub, name: u.name || u.email, email: u.email, picture: u.picture || "" };
    } catch (e) { setStatus("error", "Signed in, but your Google profile couldn't be read. Try again."); return false; }

    const previous = store.read("gs-data-owner");          // whose data is in this browser now
    if (previous && previous.id !== user.id && hasLocalData()) {
      const choice = await ask(`This browser has saved data from another account (${previous.email}).`,
        "Add it to your account, or keep it out?",
        [["merge", "Add it to my account"], ["skip", "Keep it out"]]);
      if (choice !== "merge") clearLocalData();
      clearBases();
    } else if (previous && previous.id !== user.id) {
      clearBases();
    }
    account = { user, token: resp.access_token, expires: Date.now() + (resp.expires_in || 3600) * 1000 };
    store.write(ACCOUNT_KEY, account);
    store.write("gs-data-owner", { id: user.id, email: user.email });
    // Fill in the profile from Google the first time
    const prof = get("profile");
    if (!prof.displayName) set("profile", Object.assign({ displayName: user.name, created: new Date().toISOString() }, prof), true);
    emit();
    await syncAll();
    return true;
  }

  async function signOut() {
    const choice = await ask("Sign out of The Grey Swan?",
      "Your work stays safe in your Google Drive. On a shared computer, remove it from this browser too.",
      [["keep", "Sign out, keep a copy here"], ["remove", "Sign out and remove it from this browser"], ["cancel", "Cancel"]]);
    if (choice === "cancel" || !choice) return false;
    if (account && account.token && token()) {      // tell Google to cancel this sign-in
      try { await loadGis(); google.accounts.oauth2.revoke(account.token, () => {}); } catch (e) { /* offline or already gone */ }
    }
    if (choice === "remove") { clearLocalData(); store.write("gs-data-owner", null); }
    clearBases();
    account = null;
    store.write(ACCOUNT_KEY, null);
    store.write(LAST_SYNC_KEY, null);
    Object.keys(remoteListeners).forEach((name) => notifyRemote(name));
    setStatus("idle");
    return true;
  }

  function hasLocalData() {
    return Object.keys(STORES).some((name) => {
      const d = store.read(STORES[name].key);
      return d && Object.values(d).some((v) => Array.isArray(v) ? v.length : v);
    });
  }
  function clearLocalData() { Object.values(STORES).forEach((s) => store.write(s.key, null)); }
  function clearBases() { Object.keys(STORES).forEach((name) => store.write(BASE_KEY + name, null)); Object.keys(fileIds).forEach((k) => delete fileIds[k]); }

  // ---------- Google Drive (the app's own hidden folder) ----------
  async function drive(url, options = {}) {
    const t = token();
    if (!t) { const e = new Error("reconnect"); e.reconnect = true; throw e; }
    const r = await fetch(url, Object.assign({}, options, { headers: Object.assign({ Authorization: "Bearer " + t }, options.headers || {}) }));
    if (r.status === 401) { account.expires = 0; store.write(ACCOUNT_KEY, account); const e = new Error("reconnect"); e.reconnect = true; throw e; }
    if (!r.ok) throw new Error(`Google Drive answered ${r.status}`);
    return r;
  }

  async function listFiles() {
    const r = await drive(`${DRIVE}/files?spaces=appDataFolder&pageSize=100&fields=files(id,name,modifiedTime,size)`);
    const files = (await r.json()).files || [];
    Object.keys(fileIds).forEach((k) => delete fileIds[k]);
    // If a file somehow exists twice, use the newest
    files.sort((a, b) => (a.modifiedTime < b.modifiedTime ? -1 : 1)).forEach((f) => { fileIds[f.name] = f.id; });
    return files;
  }

  async function readFile(name) {
    if (!(name in fileIds)) return null;
    const r = await drive(`${DRIVE}/files/${fileIds[name]}?alt=media`);
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  async function writeFile(name, data) {
    const body = JSON.stringify(data);
    if (fileIds[name]) {
      await drive(`${UPLOAD}/files/${fileIds[name]}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
      return;
    }
    const boundary = "gs" + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json" });
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
                      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await drive(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
    fileIds[name] = (await r.json()).id;
  }

  // ---------- Syncing ----------
  let syncing = null, again = false;

  async function syncStore(name) {
    const s = STORES[name];
    const local = store.read(s.key);
    const base = store.read(BASE_KEY + name);
    const remote = await readFile(s.file);
    const merged = remote ? merge(base, local, remote) : (local || {});
    if (!same(merged, local || {})) {
      if (!store.write(s.key, merged)) throw new Error("This browser's storage is full.");
      notifyRemote(name);
    }
    if (!same(merged, remote || {}) && Object.keys(merged).length) await writeFile(s.file, merged);
    store.write(BASE_KEY + name, merged);
  }

  async function syncAll() {
    if (!account) return;
    if (syncing) { again = true; return syncing; }
    if (!token()) { setStatus("reconnect", "Your sign-in has expired. Reconnect to sync."); return; }
    if (!navigator.onLine) { setStatus("offline", "You're offline. Changes are saved here and will sync when you're back online."); return; }
    syncing = (async () => {
      setStatus("syncing");
      try {
        await listFiles();
        for (const name of Object.keys(STORES)) await syncStore(name);
        store.write(LAST_SYNC_KEY, new Date().toISOString());
        setStatus("synced");
      } catch (e) {
        if (e.reconnect) setStatus("reconnect", "Your sign-in has expired. Reconnect to sync.");
        else setStatus("error", "Couldn't sync just now: " + e.message + ". Your changes are saved in this browser.");
      }
    })();
    await syncing;
    syncing = null;
    if (again) { again = false; return syncAll(); }
  }

  let timer = null;
  function scheduleSync(delay = 1200) {
    if (!account) return;
    clearTimeout(timer);
    if (status !== "reconnect") setStatus("pending");
    timer = setTimeout(syncAll, delay);
  }

  function notifyRemote(name) { (remoteListeners[name] || []).forEach((fn) => { try { fn(get(name)); } catch (e) { console.error(e); } }); }

  // ---------- Public API for the pages ----------
  function get(name) { return Object.assign({}, store.read(STORES[name].key) || {}); }
  function set(name, data, quiet) {
    const ok = store.write(STORES[name].key, data);
    if (ok) scheduleSync(quiet ? 300 : 1200);
    return ok;
  }
  function changed() { scheduleSync(); }

  // Everything, as one file the visitor can keep
  function exportAll() {
    const out = { exported: new Date().toISOString(), account: account ? account.user.email : null };
    for (const [name, s] of Object.entries(STORES)) out[name] = store.read(s.key) || {};
    return out;
  }

  // Delete the Drive copies and this browser's copy
  async function deleteEverything() {
    if (account) {
      if (!token()) throw new Error("Reconnect first, so the copies in your Google Drive can be deleted too.");
      for (const f of await listFiles()) await drive(`${DRIVE}/files/${f.id}`, { method: "DELETE" });
      Object.keys(fileIds).forEach((k) => delete fileIds[k]);
    }
    clearLocalData();
    clearBases();
    Object.keys(remoteListeners).forEach((n) => notifyRemote(n));
    emit();
  }

  // ---------- A small dialog (instead of the browser's alert boxes) ----------
  function ask(title, text, buttons) {
    return new Promise((resolve) => {
      const d = document.createElement("div");
      d.className = "gs-modal";
      d.setAttribute("role", "dialog");
      d.setAttribute("aria-modal", "true");
      d.innerHTML = `<div class="gs-modal-box"><h3></h3><p></p><div class="gs-modal-buttons"></div></div>`;
      d.querySelector("h3").textContent = title;
      d.querySelector("p").textContent = text;
      const row = d.querySelector(".gs-modal-buttons");
      buttons.forEach(([value, label], i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = i === 0 ? "gs-btn gs-btn-gold" : "gs-btn";
        b.textContent = label;
        b.dataset.value = value;
        b.onclick = () => { d.remove(); resolve(value); };
        row.appendChild(b);
      });
      d.addEventListener("keydown", (e) => { if (e.key === "Escape") { d.remove(); resolve(null); } });
      document.body.appendChild(d);
      row.querySelector("button").focus();
    });
  }

  // ---------- The account button in each page's header ----------
  let menuOpen = false;
  function escapeHtml(t) { return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function ago(iso) {
    if (!iso) return "";
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago`
      : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  const STATUS_TEXT = {
    idle: "", pending: "Saving…", syncing: "Syncing…", synced: "Saved to your Google Drive",
    offline: "Offline: saved here", reconnect: "Sign-in expired: reconnect to sync", error: "Not synced",
  };
  function accountUrl() {
    const here = document.currentScript || document.querySelector('script[src*="account.js"]');
    return here && here.src ? new URL("../account/", here.src).href : "/account/";
  }
  const ACCOUNT_URL = accountUrl();
  const PRIVACY_URL = ACCOUNT_URL.replace(/account\/$/, "privacy/");

  function renderChip() {
    const mount = document.getElementById("gs-account");
    if (!mount) return;
    if (!account) {
      mount.innerHTML = `<button type="button" class="gs-signin" data-gs="signin">${GOOGLE_G}<span>Sign in</span></button>`;
      return;
    }
    const u = account.user;
    const first = escapeHtml((get("profile").displayName || u.name || u.email).split(" ")[0]);
    const avatar = u.picture ? `<img src="${escapeHtml(u.picture)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="gs-initial">${first.slice(0, 1)}</span>`;
    const dot = { synced: "ok", syncing: "busy", pending: "busy", reconnect: "warn", offline: "warn", error: "warn" }[status] || "";
    const line = status === "synced" ? `${STATUS_TEXT.synced} · ${ago(store.read(LAST_SYNC_KEY))}` : (STATUS_TEXT[status] || "");
    mount.innerHTML = `
      <button type="button" class="gs-chip" data-gs="menu" aria-haspopup="true" aria-expanded="${menuOpen}">
        ${avatar}<span class="gs-name">${first}</span><span class="gs-dot ${dot}" title="${escapeHtml(line)}"></span></button>
      <div class="gs-menu" ${menuOpen ? "" : "hidden"} role="menu">
        <div class="gs-menu-head"><b>${escapeHtml(u.name)}</b><span>${escapeHtml(u.email)}</span></div>
        <div class="gs-menu-status ${dot}">${escapeHtml(line)}${message && status !== "synced" ? `<small>${escapeHtml(message)}</small>` : ""}</div>
        ${status === "reconnect" ? '<button type="button" class="gs-btn gs-btn-gold" data-gs="signin">Reconnect</button>'
          : '<button type="button" class="gs-menu-item" data-gs="sync">Sync now</button>'}
        <a class="gs-menu-item" href="${ACCOUNT_URL}">My account</a>
        <button type="button" class="gs-menu-item" data-gs="signout">Sign out</button>
      </div>`;
  }

  const GOOGLE_G = '<svg viewBox="0 0 18 18" aria-hidden="true" width="16" height="16"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.96 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/></svg>';

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-gs]");
    const mount = document.getElementById("gs-account");
    if (!t) { if (menuOpen && mount && !mount.contains(e.target)) { menuOpen = false; renderChip(); } return; }
    const what = t.dataset.gs;
    if (what === "menu") { menuOpen = !menuOpen; renderChip(); }
    if (what === "signin") { menuOpen = false; await signIn(); }
    if (what === "sync") { menuOpen = false; await syncAll(); }
    if (what === "signout") { menuOpen = false; renderChip(); await signOut(); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menuOpen) { menuOpen = false; renderChip(); } });

  // Pick up changes made on other devices when coming back to the page, and every few minutes
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && account && token()) syncAll(); });
  window.addEventListener("online", () => { if (account) syncAll(); });
  setInterval(() => { if (account && token() && document.visibilityState === "visible") syncAll(); }, 3 * 60 * 1000);
  // Another tab of this site saved something: tell this page
  window.addEventListener("storage", (e) => {
    if (e.key === ACCOUNT_KEY) { account = store.read(ACCOUNT_KEY); emit(); return; }
    for (const [name, s] of Object.entries(STORES)) if (e.key === s.key) notifyRemote(name);
  });

  window.GSAccount = {
    get, set, changed: (name) => changed(name),
    onRemote(name, fn) { (remoteListeners[name] = remoteListeners[name] || []).push(fn); },
    onChange(fn) { listeners.push(fn); fn(state()); },
    state, signIn, signOut, syncNow: syncAll, exportAll, deleteEverything, ask,
    stores: STORES, privacyUrl: PRIVACY_URL, accountUrl: ACCOUNT_URL,
    _merge: merge,                      // for the tests
  };

  function start() {
    renderChip();
    if (account) {
      if (token()) syncAll(); else setStatus("reconnect", "Your sign-in has expired. Reconnect to sync.");
    }
  }
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start) : start();
})();
