import "./styles.css";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
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
  if (view === "map") showMap();
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
  actions: $("actions"), crop: $("crop"), notes: $("notes"), part: $("part"), partTip: $("part-tip"), analyze: $("analyze"), retake: $("retake"),
  status: $("status"), result: $("result"), signals: $("signals"), empty: $("signals-empty"),
};

let currentImage = null; // JPEG data URL, max 1280px on the long edge
let scanMode = "diagnose"; // "diagnose" = check a problem, "advise" = preventive advice

const MODE_TEXT = {
  diagnose: { notes: "What happened? When did you first notice it? What did you already do, and which chemicals did you use?", sub: "Photograph the damaged part: leaf, stem, root, fruit or the whole plant. Natural light works best.", btn: "Check This Crop →" },
  advise: { notes: "What do you want help with? Crop age, what you planted, soil, rain, what you did so far, your goal for this season.", sub: "Photograph a healthy crop or your field. We tell you what to watch for, when to spray, weed and feed, and how to grow a better harvest.", btn: "Get Advice →" },
  chemical: { notes: "What do you want to use it for? What problem are you fighting? What did you spray before, and when?", sub: "Photograph the label of the chemical you want to use. We tell you if it suits your crop, when to apply it and how to stay safe. Hold the label flat, close and in good light.", btn: "Check This Chemical →" },
};
function setMode(m) {
  scanMode = m;
  document.querySelectorAll("#mode-seg [data-scan-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.scanMode === m)));
  $("scan-sub").textContent = MODE_TEXT[m].sub;
  el.analyze.textContent = MODE_TEXT[m].btn;
  $("part-field").hidden = m === "chemical";
  $("video-row").hidden = m === "chemical";
  el.notes.placeholder = MODE_TEXT[m].notes;
  showPartTip();
  el.result.hidden = true;
  setStatus();
}
document.querySelectorAll("#mode-seg [data-scan-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.scanMode)));

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
    currentFrames = null;
    el.capture.hidden = true; el.stage.hidden = false; el.actions.hidden = false; el.result.hidden = true;
    setStatus();
  } catch {
    setStatus("We couldn't read that photo. Try taking it again.", true);
  }
}

const PART_TIPS = {
  leaf: "Fill the frame with one affected leaf.",
  stem: "Show the damaged area up close, including a little healthy stem.",
  root: "Clean off the soil first, then photograph the roots in good light.",
  fruit: "Show the spots or damage on the fruit, grain or pod up close.",
  field: "Stand back and photograph your crop rows and what is around them: soil, weeds, water, bushes.",
  "whole plant": "Stand back so the whole plant is in the photo, then take a second close-up if you can.",
};
const ADVISE_TIPS = {
  leaf: "Photograph a healthy leaf up close. We look for early signs of trouble.",
  stem: "Show the stem and where it meets the soil, so we can spot early problems.",
  root: "Clean off the soil first, then photograph the roots in good light.",
  fruit: "Show the fruit, grain or pod up close to judge how it is developing.",
  "whole plant": "Stand back so the whole plant fits in the photo.",
  field: "Stand back and photograph your crop rows and what is around them: soil, weeds, water, bushes.",
};
function showPartTip() {
  const tips = scanMode === "advise" ? ADVISE_TIPS : PART_TIPS;
  el.partTip.textContent = tips[el.part.value] || "";
}
el.part.addEventListener("change", showPartTip);
function updateNotesCount() { $("notes-count").textContent = `${el.notes.value.length} / 800`; }
el.notes.addEventListener("input", updateNotesCount);
showPartTip();

// ---------- video: up to 15 seconds, sent to the AI as 8 frames ----------
const VIDEO_SECONDS = 15, MAX_FRAMES = 8, FRAME_EDGE = 768;
let currentFrames = null; // array of JPEG data URLs when the farmer used a video

function grabFrame(source, w, h) {
  const s = Math.min(1, FRAME_EDGE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

async function useFrames(frames) {
  currentFrames = frames;
  currentImage = frames[0];
  const img = new Image();
  await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = frames[Math.floor(frames.length / 2)]; });
  el.preview.width = img.width; el.preview.height = img.height;
  el.preview.getContext("2d").drawImage(img, 0, 0);
  el.capture.hidden = true; el.stage.hidden = false; el.actions.hidden = false; el.result.hidden = true;
  setStatus(`Video ready. ${frames.length} frames will be checked.`);
}

// Pick a video from the gallery: use its first 15 seconds
$("vfile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  setStatus("Preparing video…");
  const url = URL.createObjectURL(f);
  try {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = no; });
    const dur = Math.min(v.duration || VIDEO_SECONDS, VIDEO_SECONDS);
    const n = dur < 4 ? 3 : MAX_FRAMES;
    const frames = [];
    for (let i = 0; i < n; i++) {
      const seeked = new Promise((ok) => { v.onseeked = ok; setTimeout(ok, 4000); });
      v.currentTime = ((i + 0.5) * dur) / n;
      await seeked;
      frames.push(grabFrame(v, v.videoWidth, v.videoHeight));
    }
    await useFrames(frames);
    if (v.duration > VIDEO_SECONDS + 0.5) setStatus(`That video is longer than ${VIDEO_SECONDS} seconds, so we used the first ${VIDEO_SECONDS}.`);
  } catch {
    setStatus("We couldn't read that video. Try recording it again.", true);
  } finally {
    URL.revokeObjectURL(url);
    e.target.value = "";
  }
});

// Record in the app: live camera for 15 seconds, then it stops by itself
let camStream = null, camTimer = null, camFrames = [];
const CAM_HINTS = [[0, "Show the whole plant"], [4, "Move slowly to the damaged part"], [9, "Close-up of the problem"]];

async function openCam() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
  } catch {
    setStatus("We couldn't open the camera. Use \"Choose a Video\" instead.", true);
    return;
  }
  $("cam-video").srcObject = camStream;
  $("cam").hidden = false;
  $("cam-start").hidden = false; $("cam-done").hidden = true;
  $("cam-time").textContent = `${VIDEO_SECONDS}s`;
  $("cam-hint").textContent = "Hold steady in daylight, then press Start.";
}
function closeCam() {
  clearInterval(camTimer); camTimer = null;
  camStream?.getTracks().forEach((t) => t.stop()); camStream = null;
  $("cam-video").srcObject = null;
  $("cam").hidden = true;
}
function startCam() {
  const v = $("cam-video"), t0 = Date.now();
  camFrames = [];
  $("cam-start").hidden = true;
  camTimer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    $("cam-time").textContent = `${Math.max(0, Math.ceil(VIDEO_SECONDS - t))}s`;
    $("cam-hint").textContent = [...CAM_HINTS].reverse().find(([s]) => t >= s)[1];
    if (v.videoWidth) {
      while (camFrames.length < MAX_FRAMES && t >= 0.5 + camFrames.length * 2) camFrames.push(grabFrame(v, v.videoWidth, v.videoHeight));
    }
    if (camFrames.length >= 3) $("cam-done").hidden = false;
    if (t >= VIDEO_SECONDS) finishCam();
  }, 200);
}
function finishCam() {
  const frames = camFrames; camFrames = [];
  closeCam();
  if (frames.length >= 3) useFrames(frames);
  else setStatus("The recording was too short. Hold the phone steady for at least 5 seconds.", true);
}
$("rec").addEventListener("click", openCam);
$("cam-start").addEventListener("click", startCam);
$("cam-done").addEventListener("click", finishCam);
$("cam-cancel").addEventListener("click", () => { camFrames = []; closeCam(); });

el.retake.addEventListener("click", resetScan);
function resetScan() {
  currentImage = null; currentFrames = null;
  el.file.value = ""; $("file2").value = "";
  el.crop.value = ""; el.notes.value = ""; updateNotesCount();
  el.part.value = "leaf"; showPartTip(); setMode("diagnose");
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
  const mode = scanMode;
  setStatus(
    mode === "chemical" ? "Reading the label. This can take up to 30 seconds."
    : mode === "advise" ? `Studying your ${el.part.value} to prepare advice. This can take up to 30 seconds.`
    : `Checking your ${el.part.value}. This can take up to 30 seconds on a slow connection.`);
  try {
    // getSession() refreshes an expired access token automatically.
    const [{ data }, loc] = await Promise.all([supabase.auth.getSession(), getCoarseLocation()]);
    if (!data.session) { signOut(); return; }

    const res = await fetch(`${API}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ ...(currentFrames ? { images: currentFrames } : { image: currentImage }), crop: el.crop.value.trim() || undefined, part: el.part.value, mode, notes: el.notes.value.trim() || undefined, ...loc }),
    });
    const body = await res.json();
    if (res.status === 401) { await signOut(); return; }
    if (!res.ok) throw new Error(body.error || "Request failed");

    if (mode === "chemical") {
      renderChemical(body.chemical);
      setStatus();
      return;
    }
    if (mode === "advise") {
      renderAdvice(body.advice);
      setStatus();
      return;
    }

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
    ${section("When to apply", d.when_to_apply)}
    ${d.safety?.length ? `<div class="safe"><h4>Stay safe</h4>${list(d.safety)}</div>` : ""}
    ${section("Prevent it spreading", t.prevention)}`;
  el.result.hidden = false;
  el.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

const SUIT = {
  yes: ["ok", "Suits this crop"],
  no: ["bad", "Not for this crop"],
  unsure: ["warn", "Check it suits your crop"],
};
function renderChemical(d) {
  const [cls, label] = d.label_readable === false ? ["bad", "Label not clear"] : SUIT[d.suitable_for_crop] || ["warn", "Read the label"];
  const s = d.safety_steps || {};
  const section = (title, items) => (items?.length ? `<h4>${title}</h4>${list(items)}` : "");
  const ingredients = d.active_ingredients?.length ? `Active ingredient: ${d.active_ingredients.map(esc).join(", ")}` : "";
  el.result.innerHTML = `
    <span class="badge ${cls}">${esc(label)}</span>${d.type && d.type !== "unknown" ? `<span class="badge warn">${esc(d.type)}</span>` : ""}
    <h3>${esc(d.product_name || "Unknown product")}</h3>
    <p>${esc(d.what_its_for || "")}${ingredients ? `<br><small>${ingredients}</small>` : ""}</p>
    ${d.label_readable === false ? `<p class="expert">We could not read the label clearly. Do not use this product until you know what it is. Take a closer, well-lit photo of the label, or ask your agrovet.</p>` : ""}
    ${d.suitability_note ? `<p>${esc(d.suitability_note)}</p>` : ""}
    ${d.warnings?.length ? `<div class="safe"><h4>Warning</h4>${list(d.warnings)}</div>` : ""}
    ${section("Dose and mixing (from the label)", d.dose_and_mixing)}
    ${section("Best time to apply", d.best_time_to_apply)}
    ${section("Do not spray when", d.avoid)}
    ${section("Wear this", d.protective_gear)}
    ${section("Before you spray", s.before)}
    ${section("While spraying", s.while_spraying)}
    ${section("After spraying", s.after)}
    ${section("Waiting periods", d.waiting_periods)}
    ${d.first_aid?.length ? `<div class="safe"><h4>If someone is poisoned</h4>${list(d.first_aid)}</div>` : ""}
    ${section("Store and dispose safely", d.storage_and_disposal)}
    ${d.see_expert ? `<p class="expert">Ask your agrovet or agriculture officer to confirm before you use it.</p>` : ""}
    <p class="fine">We only read what is printed in your photo. The product label is the final rule, so always follow it.</p>`;
  el.result.hidden = false;
  el.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

const RISK_CLS = { high: "bad", medium: "warn", low: "ok" };
const HEALTH = {
  excellent: ["ok", "Looking excellent"],
  good: ["ok", "Looking good"],
  fair: ["warn", "Fair, can improve"],
  needs_attention: ["bad", "Needs attention"],
};
function renderAdvice(d) {
  const [cls, label] = HEALTH[d.health_status] || ["warn", "Advice ready"];
  const section = (title, items) => (items?.length ? `<h4>${title}</h4>${list(items)}` : "");
  const risks = (d.early_warnings || []).map((r) =>
    `<li><span class="badge ${RISK_CLS[r.likelihood] || "warn"}">${esc(r.likelihood || "watch")}</span><b>${esc(r.risk)}</b>${r.why ? `: ${esc(r.why)}` : ""}${r.prevent ? `<br><i>What to do: ${esc(r.prevent)}</i>` : ""}</li>`).join("");
  const bestTimes = d.best_times?.length
    ? `<h4>Best time for each job</h4><ul>${d.best_times.map((b) => `<li><b>${esc(b.task)}</b>: ${esc(b.when || "")}${b.why ? ` <i>(${esc(b.why)})</i>` : ""}</li>`).join("")}</ul>`
    : "";
  el.result.innerHTML = `
    <span class="badge ${cls}">${esc(label)}</span>
    <h3>${esc(d.crop || "Your crop")}${d.growth_stage ? ` · ${esc(d.growth_stage)}` : ""}</h3>
    <p>${esc(d.summary || "")}</p>
    ${d.problem_spotted ? `<p class="expert">We can already see signs of ${esc(d.problem_spotted)}. Switch to "Check a problem" and scan the affected part for a full treatment plan.</p>` : ""}
    ${section("What is going well", d.going_well)}
    ${risks ? `<h4>Watch out for (early warnings)</h4><ul>${risks}</ul>` : ""}
    ${section("Do this week", d.do_this_week)}
    ${section("Grow a better harvest", d.improve_yield)}
    ${section("Low-cost or organic", d.low_cost_or_organic)}
    ${bestTimes}
    ${section("Before you weed", d.before_weeding)}
    ${d.safety_basics?.length ? `<div class="safe"><h4>Stay safe</h4>${list(d.safety_basics)}</div>` : ""}
    ${section("Plan for next season", d.next_season)}
    ${section("Tell us more for better advice", d.ask_farmer)}
    ${d.see_expert ? `<p class="expert">For advice that fits your soil and weather, talk to your local agriculture officer.</p>` : ""}
    <p class="fine">Guidance based on the photo only. We can't see your soil or weather.</p>`;
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
// ---------- real map (Leaflet + OpenStreetMap) ----------
let map = null, mapLayer = null;
function showMap() {
  if (!map) {
    map = L.map("map").setView([0.3, 37.9], 6); // Kenya; re-fits to the pins when there are reports
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
  }
  setTimeout(() => { map.invalidateSize(); drawMap(true); }, 0); // map was hidden, so recompute its size
}
function drawMap(fit = false) {
  if (!map) return;
  mapLayer.clearLayers();
  const pts = [];
  for (const s of recentSignals) {
    const lat = Number(s.lat), lng = Number(s.lng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const severe = s.severity === "severe";
    L.circleMarker([lat, lng], { radius: 11, color: severe ? "#c1121f" : "#d97706", weight: 2, fillOpacity: 0.55 })
      .bindPopup(`<b>${esc(s.disease)}</b><br>${esc(s.crop || "Crop")} · ${esc(s.severity)}<br>${timeAgo(s.created_at)}`)
      .addTo(mapLayer);
    pts.push([lat, lng]);
  }
  if (fit && pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.4), { maxZoom: 11 });
}

function drawRail() {
  drawMap();
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
