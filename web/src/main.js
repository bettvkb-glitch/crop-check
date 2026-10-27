import "./styles.css";
import { supabase } from "./supabase.js";
import { signOut, initAuthUI, displayName } from "./auth.js";
import { parseSam, drawOverlay } from "./sam.js";

const API = import.meta.env.VITE_API_BASE;
// Optional farmer-help button. Digits only, with country code, e.g. "2547XXXXXXXX". Empty = button hidden.
const SUPPORT_WHATSAPP = "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// =====================================================================
// Auth gate: one place decides which screen the user sees.
//   no session  -> sign in / create account
//   session     -> dashboard
//   recovery    -> "choose a new password" (opened from the reset email)
// =====================================================================
let recovering = /type=recovery/.test(location.hash);
let currentUid = null;
let feedChannel = null;

const authUI = initAuthUI({
  onPasswordUpdated: () => {
    recovering = false;
    history.replaceState(null, "", location.pathname);
    supabase.auth.getSession().then(({ data }) => route(data.session));
  },
});

// Don't await Supabase calls inside this callback (it can deadlock the client); defer instead.
supabase.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") recovering = true;
  setTimeout(() => route(session), 0);
});

function route(session) {
  $("boot").hidden = true;
  if (recovering) {
    if ($("auth").hidden) screen("auth");
    if (authUI.getMode() !== "recovery") { setAuthState("form"); authUI.setMode("recovery"); }
  } else if (session) {
    showApp(session);
  } else {
    showAuth();
  }
}

function screen(which) {
  for (const id of ["auth", "app"]) {
    const node = $(id);
    node.hidden = id !== which;
    node.classList.remove("enter");
    if (id === which) { void node.offsetWidth; node.classList.add("enter"); } // restart the fade
  }
  window.scrollTo(0, 0);
}

function showApp(session) {
  const user = session.user;
  const name = displayName(user);
  $("menu-email").textContent = user.email || "Signed in";
  $("user-name").textContent = name;
  $("welcome-name").textContent = name;
  if (currentUid !== user.id) {
    currentUid = user.id;
    resetScan();
    go("home");
    loadStats(user.id);
    startFeed(user.id);
  }
  if ($("app").hidden) screen("app");
}

function showAuth() {
  if (currentUid) {
    currentUid = null;
    stopFeed();
    resetScan();
    closeMenu();
    $("signals").replaceChildren();
    recentSignals = []; drawRail();
    $("signals-empty").hidden = false;
    scanCount = 0; $("st-scans").textContent = "0"; $("st-out").textContent = "0"; setLast(null);
  }
  if ($("auth").hidden) { screen("auth"); authUI.setMode("signin"); setAuthState("landing"); }
}

// Landing page <-> form. Login/Register buttons open the form in the right mode.
function setAuthState(state) {
  $("landing").hidden = state !== "landing";
  $("auth-panel").hidden = state !== "form";
  const on = (id, yes) => (yes ? $(id).setAttribute("aria-current", "page") : $(id).removeAttribute("aria-current"));
  on("auth-tab-home", state === "landing");
  on("auth-tab-profile", state === "form");
  window.scrollTo(0, 0);
}
$("auth-tab-home").addEventListener("click", () => setAuthState("landing"));
document.querySelectorAll("[data-go]").forEach((b) =>
  b.addEventListener("click", () => { setAuthState("form"); authUI.setMode(b.dataset.go); $("email").focus(); }),
);
$("auth-home").addEventListener("click", () => setAuthState("landing"));

// ---------- theme (auth screen + profile menu) ----------
document.querySelectorAll(".js-theme").forEach((b) =>
  b.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    closeMenu();
  }),
);

// ---------- profile menu ----------
const menu = $("menu"), avatar = $("avatar");
function closeMenu() { menu.hidden = true; avatar.setAttribute("aria-expanded", "false"); }
avatar.addEventListener("click", () => {
  menu.hidden = !menu.hidden;
  avatar.setAttribute("aria-expanded", String(!menu.hidden));
  if (!menu.hidden) menu.querySelector("button")?.focus();
});
document.addEventListener("click", (e) => { if (!e.target.closest(".profile, #tab-profile")) closeMenu(); });
$("tab-profile").addEventListener("click", () => avatar.click());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { closeMenu(); avatar.focus(); } });
$("logout").addEventListener("click", () => { closeMenu(); signOut(); }); // listener routes back to sign in

// ---------- navigation (top nav, like the reference site) ----------
function go(view) {
  document.querySelectorAll(".nav-link[data-view]").forEach((b) => {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    b.classList.toggle("on", b.dataset.view === view);
  });
  $("view-home").hidden = view !== "home";
  $("view-map").hidden = view !== "map";
  window.scrollTo(0, 0);
}
document.querySelectorAll(".nav-link[data-view]").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
document.querySelectorAll("[data-go-view]").forEach((b) => b.addEventListener("click", () => go(b.dataset.goView)));
// light haptic tick on tab taps (Android; ignored elsewhere)
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => navigator.vibrate?.(8)));
// Scan tab: jump home and open the camera (or scroll to the photo if one is already chosen)
$("tab-scan").addEventListener("click", () => {
  go("home");
  if (!el.capture.hidden) $("file").click(); else el.stage.scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- help button ----------
if (SUPPORT_WHATSAPP) {
  $("fab").href = `https://wa.me/${SUPPORT_WHATSAPP}`;
  $("fab").hidden = false;
}

// =====================================================================
// Scan: capture -> compress -> /api/scan (Worker -> SAM 3.1 + Muse Spark)
// =====================================================================
const el = {
  file: $("file"), capture: $("capture"), stage: $("stage"), preview: $("preview"),
  actions: $("actions"), crop: $("crop"), analyze: $("analyze"), retake: $("retake"),
  status: $("status"), result: $("result"), signals: $("signals"), empty: $("signals-empty"),
};

let currentImage = null; // JPEG data URL, max 1280px on the long edge

async function compress(file, maxEdge = 1280, quality = 0.8) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  el.preview.width = Math.round(bmp.width * s);
  el.preview.height = Math.round(bmp.height * s);
  el.preview.getContext("2d").drawImage(bmp, 0, 0, el.preview.width, el.preview.height);
  return el.preview.toDataURL("image/jpeg", quality);
}

[el.file, $("file2")].forEach((inp) => inp.addEventListener("change", () => onPick(inp)));
async function onPick(inp) {
  const f = inp.files?.[0];
  if (!f) return;
  setStatus("Preparing photo…");
  try {
    currentImage = await compress(f);
    el.capture.hidden = true; el.stage.hidden = false; el.actions.hidden = false; el.result.hidden = true;
    setStatus();
  } catch {
    setStatus("We couldn't read that photo. Try taking it again.", true);
  }
}

el.retake.addEventListener("click", resetScan);
function resetScan() {
  currentImage = null;
  el.file.value = ""; $("file2").value = "";
  el.crop.value = "";
  el.capture.hidden = false; el.stage.hidden = true; el.actions.hidden = true; el.result.hidden = true;
  setStatus();
}

function setStatus(msg, isError = false) {
  el.status.hidden = !msg;
  el.status.textContent = msg ?? "";
  el.status.classList.toggle("error", isError);
}

function getCoarseLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({}),
      { timeout: 4000, maximumAge: 600000 },
    );
  });
}

el.analyze.addEventListener("click", async () => {
  if (!currentImage) return;
  el.analyze.disabled = true;
  setStatus("Checking your leaf. This can take up to 30 seconds on a slow connection.");
  try {
    // getSession() refreshes an expired access token automatically.
    const [{ data }, loc] = await Promise.all([supabase.auth.getSession(), getCoarseLocation()]);
    if (!data.session) { signOut(); return; }

    const res = await fetch(`${API}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ image: currentImage, crop: el.crop.value.trim() || undefined, ...loc }),
    });
    const body = await res.json();
    if (res.status === 401) { await signOut(); return; }
    if (!res.ok) throw new Error(body.error || "Request failed");

    const matches = parseSam(body.segmentation?.raw);
    if (matches.length) drawOverlay(el.preview.getContext("2d"), matches, 1);

    renderResult(body.diagnosis);
    if (body.saved) { scanCount++; $("st-scans").textContent = scanCount; }
    setLast({ crop: body.diagnosis.crop, disease: body.diagnosis.is_healthy ? null : body.diagnosis.disease });
    setStatus(body.saved ? undefined : "Result not saved to your history (connection issue).", !body.saved);
  } catch (e) {
    setStatus(e.message || "Something went wrong. Check your connection and try again.", true);
  } finally {
    el.analyze.disabled = false;
  }
});

// ---------- stat cards ----------
let scanCount = 0;
function setLast(l) {
  const r = $("st-result");
  $("st-crop").textContent = l?.crop || "—";
  r.className = l ? (l.disease ? "bad" : "good") : "";
  r.textContent = l ? (l.disease || "Healthy") : "—";
}
async function loadStats(uid) {
  const { data, count } = await supabase
    .from("scans").select("crop,disease", { count: "exact" })
    .order("created_at", { ascending: false }).limit(1);
  if (currentUid !== uid) return;
  scanCount = count ?? 0;
  $("st-scans").textContent = scanCount;
  setLast(data?.[0] ? { crop: data[0].crop, disease: data[0].disease } : null);
}

const list = (items) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");
function renderResult(d) {
  const cls = d.is_healthy ? "ok" : d.severity === "severe" ? "bad" : "warn";
  const label = d.is_healthy ? "Looks healthy" : `${d.severity ?? "unknown"} severity`;
  const t = d.treatment || {};
  const section = (title, items) => (items?.length ? `<h4>${title}</h4>${list(items)}` : "");
  el.result.innerHTML = `
    <span class="badge ${cls}">${esc(label)}</span>
    <h3>${esc(d.is_healthy ? `${d.crop || "Crop"} is healthy` : d.disease || "Unknown problem")}</h3>
    <p>${esc(d.summary || "")}</p>
    ${d.see_expert ? `<p class="expert">Not sure enough. Show this to your local agriculture officer, or take a closer, clearer photo.</p>` : ""}
    ${section("What we saw", d.symptoms_seen)}
    ${section("Do this today", t.act_today)}
    ${section("Low-cost or organic", t.low_cost_or_organic)}
    ${section("Chemical options", t.chemical_options)}
    ${section("Prevent it spreading", t.prevention)}`;
  el.result.hidden = false;
  el.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

// =====================================================================
// Live outbreak feed (Supabase Realtime), only while signed in
// =====================================================================
const ALERT_ICON = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17v.01"/></svg>`;
function timeAgo(iso) {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
let recentSignals = [];
function drawRail() {
  const rail = $("recent");
  if (!recentSignals.length) {
    rail.innerHTML = `<div class="rail-card rail-empty">No outbreaks reported yet. Confident, serious diagnoses appear here.</div>`;
    return;
  }
  rail.replaceChildren(...recentSignals.slice(0, 6).map((s, i) => {
    const a = document.createElement("article");
    a.className = "rail-card";
    a.innerHTML = `<div class="rail-top"><span class="chip ${s.severity === "severe" ? "bad" : "warn"}">${ALERT_ICON}</span><span>${esc(s.crop || "Crop")} · ${esc(s.severity)}</span></div>
      <strong>${esc(s.disease)}</strong>
      <span class="when">${timeAgo(s.created_at)} · near ${s.lat}, ${s.lng}</span>`;
    return a;
  }));
}

function signalItem(s, fresh = false) {
  const li = document.createElement("li");
  li.className = `${s.severity}${fresh ? " fresh" : ""}`;
  li.innerHTML = `<strong>${esc(s.disease)}</strong>
    <span>${esc(s.crop || "Crop")} · ${esc(s.severity)}</span>
    <span class="when">${new Date(s.created_at).toLocaleString()} · near ${s.lat}, ${s.lng}</span>`;
  return li;
}

async function startFeed(uid) {
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const { data } = await supabase
    .from("outbreak_signals").select("*").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(50);
  if (currentUid !== uid) return; // signed out while loading
  el.signals.replaceChildren(...(data ?? []).map((s) => signalItem(s)));
  el.empty.hidden = el.signals.children.length > 0;
  $("st-out").textContent = el.signals.children.length;
  recentSignals = data ?? []; drawRail();

  feedChannel = supabase
    .channel("outbreaks")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "outbreak_signals" }, ({ new: s }) => {
      el.signals.prepend(signalItem(s, true));
      el.empty.hidden = true;
      $("st-out").textContent = el.signals.children.length;
      recentSignals.unshift(s); drawRail();
    })
    .subscribe();
}

function stopFeed() {
  if (feedChannel) supabase.removeChannel(feedChannel);
  feedChannel = null;
}

if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("/sw.js");
