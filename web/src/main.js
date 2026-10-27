import "leaflet/dist/leaflet.css";
import "./style.css";
import L from "leaflet";
import { createClient } from "@supabase/supabase-js";
import { t, setLang, getLang } from "./i18n.js";
import { authView, scanView, resultView, historyView, outbreaksView, profileView, icons, leafMark, esc } from "./views.js";

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const API = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
const root = document.getElementById("app");
const q = (sel) => root.querySelector(sel);

if (!SUPA_URL || !SUPA_KEY || !API) {
  root.innerHTML = `<main class="auth"><h1>Crop Check</h1><p class="msg error">Missing settings. Add VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and VITE_API_BASE in Cloudflare Pages, then redeploy.</p></main>`;
  throw new Error("Missing environment variables");
}

const supabase = createClient(SUPA_URL, SUPA_KEY);

const state = {
  session: null,
  online: navigator.onLine,
  tab: "scan",
  authMode: "login",
  authError: "",
  authNotice: "",
  busy: false,
  draft: null,
  crop: "unknown",
  share: true,
  scanError: "",
  result: null,
  resultPhoto: null,
  resultReturn: "scan",
  history: null,
  historyLoading: false,
  outbreaks: null,
  outbreaksLoading: false,
  outbreakError: "",
  profileNotice: "",
};

let map = null;

// ---------- rendering ----------

const TABS = [
  ["scan", "tabScan"],
  ["history", "tabHistory"],
  ["outbreaks", "tabOutbreaks"],
  ["profile", "tabProfile"],
];

function destroyMap() {
  if (map) {
    map.remove();
    map = null;
  }
}

function render() {
  destroyMap();
  document.documentElement.lang = getLang();

  if (!state.session) {
    root.innerHTML = authView({ mode: state.authMode, error: state.authError, notice: state.authNotice, busy: state.busy });
    return;
  }

  let body = "";
  if (state.result) {
    body = resultView(state.result, {
      photo: state.resultPhoto,
      backLabel: state.resultReturn === "history" ? t("back") : t("scanAnother"),
    });
  } else if (state.tab === "scan") {
    body = scanView({ draft: state.draft, busy: state.busy, error: state.scanError, crop: state.crop, share: state.share });
  } else if (state.tab === "history") {
    body = historyView(state.history || [], state.history === null);
  } else if (state.tab === "outbreaks") {
    body = outbreaksView(state.outbreaks || [], { loading: state.outbreaks === null && !state.outbreakError, error: state.outbreakError });
  } else {
    body = profileView(state.session.user.email, state.profileNotice);
  }

  root.innerHTML = `
    <div class="app">
      <header class="topbar"><span class="brand-leaf">${leafMark}</span><strong>${esc(t("appName"))}</strong></header>
      ${state.online ? "" : `<div class="offline" role="status">${esc(t("offline"))}</div>`}
      <div class="view">${body}</div>
      <nav class="tabs" aria-label="Main">
        ${TABS.map(
          ([id, label]) =>
            `<button data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ""}>${icons[id]}<span>${esc(t(label))}</span></button>`
        ).join("")}
      </nav>
    </div>`;

  if (!state.result && state.tab === "history" && state.history === null) loadHistory();
  if (!state.result && state.tab === "outbreaks") {
    initMap(state.outbreaks || []);
    if (state.outbreaks === null && !state.outbreaksLoading && !state.outbreakError) loadOutbreaks();
  }
}

// ---------- data ----------

async function loadHistory() {
  if (state.historyLoading) return;
  state.historyLoading = true;
  const { data, error } = await supabase
    .from("scans")
    .select("id,crop,disease,disease_key,severity,affected_percent,created_at,result")
    .order("created_at", { ascending: false })
    .limit(50);
  state.historyLoading = false;
  state.history = error ? [] : data;
  if (state.session && !state.result && state.tab === "history") render();
}

async function loadOutbreaks() {
  state.outbreaksLoading = true;
  const { data, error } = await supabase.rpc("get_outbreaks", { days: 14 });
  state.outbreaksLoading = false;
  if (error) {
    state.outbreakError = t("err_generic");
    state.outbreaks = [];
  } else {
    state.outbreakError = "";
    state.outbreaks = data || [];
  }
  if (state.session && !state.result && state.tab === "outbreaks") render();
}

function initMap(items) {
  const el = document.getElementById("map");
  if (!el) return;
  map = L.map(el, { scrollWheelZoom: false }).setView([-0.5, 37.9], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const points = [];
  for (const o of items) {
    const lat = Number(o.lat);
    const lng = Number(o.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const color = o.worst === "severe" ? "#b42318" : "#a8630a";
    L.circleMarker([lat, lng], {
      radius: 10 + Math.min(Number(o.farmers) || 2, 8) * 2,
      color,
      fillColor: color,
      fillOpacity: 0.45,
      weight: 2,
    })
      .addTo(map)
      .bindPopup(`<strong>${esc(o.disease || o.disease_key)}</strong><br>${esc(Number(o.farmers) || 0)} ${esc(t("farmers"))}`);
    points.push([lat, lng]);
  }
  if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 11 });
  setTimeout(() => map && map.invalidateSize(), 0);
}

// ---------- scanning ----------

async function compress(file, max = 1024, quality = 0.8) {
  let source;
  let w;
  let h;
  try {
    source = await createImageBitmap(file);
    w = source.width;
    h = source.height;
  } catch {
    const url = URL.createObjectURL(file);
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    w = source.naturalWidth;
    h = source.naturalHeight;
    URL.revokeObjectURL(url);
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 100) / 100, lng: Math.round(p.coords.longitude * 100) / 100 }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

function errorText(code) {
  const key = "err_" + code;
  const msg = t(key);
  return msg === key ? t("err_generic") : msg;
}

async function onFile(file) {
  if (!file) return;
  try {
    state.scanError = "";
    state.draft = { image: await compress(file) };
  } catch {
    state.scanError = t("err_bad_image");
  }
  render();
}

async function diagnose() {
  if (!state.draft || state.busy) return;
  if (!navigator.onLine) {
    state.scanError = t("offline");
    return render();
  }
  state.crop = q("#crop") ? q("#crop").value : state.crop;
  state.share = q("#share") ? q("#share").checked : state.share;
  state.busy = true;
  state.scanError = "";
  render();

  try {
    const loc = state.share ? await getLocation() : null;
    const { data } = await supabase.auth.getSession();
    const token = data.session && data.session.access_token;
    const res = await fetch(`${API}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        image: state.draft.image,
        lang: getLang(),
        crop: state.crop,
        lat: loc ? loc.lat : undefined,
        lng: loc ? loc.lng : undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "generic");
    state.result = json.result;
    state.resultPhoto = state.draft.image;
    state.resultReturn = "scan";
    state.draft = null;
    state.history = null;
  } catch (e) {
    state.scanError = errorText(e && e.message);
  }
  state.busy = false;
  render();
}

// ---------- events ----------

root.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el) return;

  if (el.dataset.tab) {
    state.tab = el.dataset.tab;
    state.result = null;
    state.profileNotice = "";
    if (state.tab === "outbreaks") {
      state.outbreaks = null;
      state.outbreakError = "";
    }
    return render();
  }
  if (el.dataset.lang) {
    setLang(el.dataset.lang);
    return render();
  }
  if (el.dataset.scan !== undefined) {
    const row = (state.history || [])[Number(el.dataset.scan)];
    if (row) {
      state.result = row.result;
      state.resultPhoto = null;
      state.resultReturn = "history";
      render();
    }
    return;
  }

  switch (el.id) {
    case "take":
      q("#file-camera").click();
      break;
    case "pick":
      q("#file-gallery").click();
      break;
    case "retake":
      state.draft = null;
      state.scanError = "";
      render();
      break;
    case "diagnose":
      diagnose();
      break;
    case "result-done":
      state.tab = state.resultReturn;
      state.result = null;
      state.resultPhoto = null;
      render();
      break;
    case "auth-switch":
      state.authMode = state.authMode === "login" ? "register" : "login";
      state.authError = "";
      state.authNotice = "";
      render();
      break;
    case "sign-out":
      await supabase.auth.signOut();
      break;
    case "delete-scans":
      if (window.confirm(t("deleteConfirm"))) {
        const { error } = await supabase.from("scans").delete().eq("user_id", state.session.user.id);
        state.profileNotice = error ? t("err_generic") : t("deleted");
        state.history = null;
        render();
      }
      break;
  }
});

root.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "file-camera" || el.id === "file-gallery") onFile(el.files && el.files[0]);
  else if (el.id === "crop") state.crop = el.value;
  else if (el.id === "share") state.share = el.checked;
});

root.addEventListener("submit", async (e) => {
  if (e.target.id !== "auth-form") return;
  e.preventDefault();
  const form = new FormData(e.target);
  const email = String(form.get("email") || "").trim();
  const password = String(form.get("password") || "");
  state.busy = true;
  state.authError = "";
  state.authNotice = "";
  render();

  const register = state.authMode === "register";
  const { data, error } = register
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password });

  state.busy = false;
  if (error) {
    state.authError = error.message;
  } else if (register && !data.session) {
    state.authNotice = t("checkEmail");
    state.authMode = "login";
  }
  // On success the auth listener below shows the app.
  render();
});

window.addEventListener("online", () => {
  state.online = true;
  render();
});
window.addEventListener("offline", () => {
  state.online = false;
  render();
});

supabase.auth.onAuthStateChange((_event, session) => {
  const before = state.session && state.session.user.id;
  const after = session && session.user.id;
  state.session = session;
  if (before === after) return; // token refresh: keep what the farmer is doing
  if (!after) {
    Object.assign(state, { tab: "scan", draft: null, result: null, history: null, outbreaks: null, profileNotice: "" });
  }
  render();
});

// ---------- start ----------

supabase.auth.getSession().then(({ data }) => {
  state.session = data.session;
  render();
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
