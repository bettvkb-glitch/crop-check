// Pure functions that turn data into HTML strings. No DOM or network access here,
// so they can be tested in Node. Everything that came from a person or a model goes through esc().

import { t, cropName, cropKeys, getLang } from "./i18n.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const pct = (n) => Math.max(0, Math.min(100, (Number(n) || 0) * 100));
const SEVERITIES = ["none", "low", "moderate", "severe"];
const sevOf = (s) => (SEVERITIES.includes(s) ? s : "none");

export const dateText = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(getLang() === "sw" ? "sw-KE" : "en-KE", { day: "numeric", month: "short" });
};

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const icons = {
  scan: svg('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.5"/>'),
  history: svg('<path d="M4 5h16M4 12h16M4 19h10"/>'),
  outbreaks: svg('<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  profile: svg('<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.4 7-5.4s6.2 1.8 7 5.4"/>'),
};

export const leafMark = `<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><path d="M5 27C5 12 13 5 27 5c0 14-7 22-22 22z" fill="#2E7D45"/><path d="M6 26C12 18 17 13 24 8" stroke="#F2F5EE" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`;

const leafOutline = `<svg viewBox="0 0 64 64" width="84" height="84" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 54C10 27 26 11 54 10c-1 28-17 44-44 44z"/><path d="M12 52C26 38 38 26 50 14M30 34l-1 11M38 26l7-1"/></svg>`;

// ---------- sign in / register ----------

export function authView({ mode, error, notice, busy }) {
  const register = mode === "register";
  return `
  <main class="auth">
    <div class="auth-brand">${leafMark}<h1>${esc(t("appName"))}</h1></div>
    <p class="auth-tag">${esc(t("tagline"))}</p>
    <form id="auth-form" class="card form" novalidate>
      <label>${esc(t("email"))}
        <input name="email" type="email" inputmode="email" autocomplete="email" required />
      </label>
      <label>${esc(t("password"))}
        <input name="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" minlength="8" required />
        ${register ? `<small>${esc(t("pwHint"))}</small>` : ""}
      </label>
      ${error ? `<p class="msg error" role="alert">${esc(error)}</p>` : ""}
      ${notice ? `<p class="msg ok" role="status">${esc(notice)}</p>` : ""}
      <button class="btn primary" type="submit" ${busy ? "disabled" : ""}>${esc(register ? t("register") : t("login"))}</button>
      <button class="link" type="button" id="auth-switch">${esc(register ? t("haveAccount") : t("noAccount"))}</button>
    </form>
    <div class="lang-row">${langButtons()}</div>
  </main>`;
}

export function langButtons() {
  const cur = getLang();
  return `<div class="seg" role="group" aria-label="${esc(t("language"))}">
    <button type="button" data-lang="en" aria-pressed="${cur === "en"}">English</button>
    <button type="button" data-lang="sw" aria-pressed="${cur === "sw"}">Kiswahili</button>
  </div>`;
}

// ---------- scan ----------

export function scanView({ draft, busy, error, crop, share }) {
  const cropOptions =
    `<option value="unknown">${esc(t("cropAuto"))}</option>` +
    cropKeys.map((k) => `<option value="${k}" ${crop === k ? "selected" : ""}>${esc(cropName(k))}</option>`).join("");

  return `
  <section class="scan">
    <h2>${esc(t("scanTitle"))}</h2>
    <p class="help">${esc(t("scanHelp"))}</p>
    <div class="loupe ${draft ? "has-photo" : ""} ${busy ? "busy" : ""}">
      ${draft ? `<img src="${draft.image}" alt="" />` : leafOutline}
    </div>
    ${
      draft
        ? `<div class="stack">
            <label class="field">${esc(t("cropLabel"))}
              <select id="crop" ${busy ? "disabled" : ""}>${cropOptions}</select>
            </label>
            <label class="check"><input type="checkbox" id="share" ${share ? "checked" : ""} ${busy ? "disabled" : ""} /> <span>${esc(t("shareLoc"))}</span></label>
            ${error ? `<p class="msg error" role="alert">${esc(error)}</p>` : ""}
            <button class="btn primary" id="diagnose" ${busy ? "disabled" : ""}>${esc(busy ? t("analyzing") : t("diagnose"))}</button>
            <button class="btn quiet" id="retake" ${busy ? "disabled" : ""}>${esc(t("retake"))}</button>
          </div>`
        : `<div class="stack">
            ${error ? `<p class="msg error" role="alert">${esc(error)}</p>` : ""}
            <button class="btn primary" id="take">${esc(t("takePhoto"))}</button>
            <button class="btn quiet" id="pick">${esc(t("pickPhoto"))}</button>
            <ul class="tips"><li>${esc(t("tip1"))}</li><li>${esc(t("tip2"))}</li><li>${esc(t("tip3"))}</li></ul>
          </div>`
    }
    <input id="file-camera" type="file" accept="image/*" capture="environment" hidden />
    <input id="file-gallery" type="file" accept="image/*" hidden />
  </section>`;
}

// ---------- result ----------

const SECTIONS = [
  ["symptoms", "sec-see"],
  ["immediate", "sec-now"],
  ["organic", "sec-organic"],
  ["chemical", "sec-chem"],
  ["prevention", "sec-prevent"],
];

export function resultView(r, { photo, backLabel } = {}) {
  const isLeaf = r.is_plant_leaf !== false;
  const sev = sevOf(r.severity);
  const healthy = isLeaf && (r.disease_key === "healthy" || sev === "none");
  const tr = r.treatment || {};
  const regions = Array.isArray(r.affected_regions) ? r.affected_regions : [];

  const boxes = regions
    .map(
      (b) =>
        `<span class="box" style="left:${pct(b.x)}%;top:${pct(b.y)}%;width:${pct(b.w)}%;height:${pct(b.h)}%"></span>`
    )
    .join("");

  const title = !isLeaf ? t("notLeaf") : healthy ? t("healthy") : r.disease || r.disease_key || "";
  const conf = Math.round((Number(r.confidence) || 0) * 100);
  const crop = r.crop && r.crop !== "unknown" ? cropName(r.crop) : "";

  const sections = SECTIONS.map(([key, cls]) => {
    const items = Array.isArray(key === "symptoms" ? r.symptoms : tr[key]) ? (key === "symptoms" ? r.symptoms : tr[key]) : [];
    if (!items.length || (!isLeaf && key !== "symptoms")) return "";
    return `<section class="sec ${cls}">
      <h3>${esc(t(key))}</h3>
      <ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      ${key === "chemical" ? `<p class="fine">${esc(t("pcpb"))}</p>` : ""}
    </section>`;
  }).join("");

  return `
  <article class="result sev-${sev}">
    ${photo ? `<div class="leaf"><img src="${photo}" alt="" />${boxes}</div>` : ""}
    <header class="verdict">
      <h2>${esc(title)}</h2>
      ${isLeaf ? `<p class="meta">${crop ? `<span>${esc(crop)}</span>` : ""}<span>${esc(t("confidence"))} ${conf}%</span></p>` : ""}
    </header>
    ${
      isLeaf && !healthy
        ? `<div class="gauge"><strong>${Math.round(Number(r.affected_percent) || 0)}%</strong>
            <span>${esc(t("affected"))}</span>
            <em class="chip">${esc(t("sev_" + sev))}</em></div>`
        : ""
    }
    ${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
    ${r.see_expert && isLeaf ? `<p class="callout">${esc(t("expert"))}</p>` : ""}
    ${sections}
    <p class="fine disclaimer">${esc(t("disclaimer"))}</p>
    <button class="btn primary" id="result-done">${esc(backLabel || t("scanAnother"))}</button>
  </article>`;
}

// ---------- history ----------

export function historyView(rows, loading) {
  if (loading) return `<section class="list"><h2>${esc(t("historyTitle"))}</h2><p class="help">${esc(t("loading"))}</p></section>`;
  const items = rows
    .map((row, i) => {
      const sev = sevOf(row.severity);
      const healthy = row.disease_key === "healthy" || sev === "none";
      const name = healthy ? t("healthy") : row.disease || row.disease_key || "";
      const crop = row.crop && row.crop !== "unknown" ? cropName(row.crop) : "";
      return `<li><button class="row sev-${sev}" data-scan="${i}">
        <span class="dot" aria-hidden="true"></span>
        <span class="row-main"><strong>${esc(name)}</strong><small>${esc(crop)}</small></span>
        <span class="row-side">${esc(dateText(row.created_at))}</span>
      </button></li>`;
    })
    .join("");
  return `<section class="list">
    <h2>${esc(t("historyTitle"))}</h2>
    ${rows.length ? `<ul class="rows">${items}</ul>` : `<p class="empty">${esc(t("historyEmpty"))}</p>`}
  </section>`;
}

// ---------- outbreaks ----------

export function outbreaksView(items, { loading, error } = {}) {
  const list = (items || [])
    .map((o) => {
      const sev = sevOf(o.worst);
      const crop = o.crop && o.crop !== "unknown" ? cropName(o.crop) : "";
      return `<li class="outbreak sev-${sev}">
        <span class="dot" aria-hidden="true"></span>
        <div><strong>${esc(o.disease || o.disease_key)}</strong>
        <small>${crop ? esc(crop) + ": " : ""}${esc(Number(o.farmers) || 0)} ${esc(t("farmers"))}</small>
        <small>${esc(t("lastReport"))}: ${esc(dateText(o.last_reported))}</small></div>
      </li>`;
    })
    .join("");
  return `<section class="outbreaks">
    <h2>${esc(t("outbreaksTitle"))}</h2>
    <p class="help">${esc(t("outbreaksHelp"))}</p>
    <div id="map" class="map" role="img" aria-label="${esc(t("outbreaksTitle"))}"></div>
    ${error ? `<p class="msg error" role="alert">${esc(error)}</p>` : ""}
    ${loading ? `<p class="help">${esc(t("loading"))}</p>` : items && items.length ? `<ul class="rows plain">${list}</ul>` : error ? "" : `<p class="empty">${esc(t("outbreaksEmpty"))}</p>`}
  </section>`;
}

// ---------- profile ----------

export function profileView(email, notice) {
  return `<section class="profile">
    <h2>${esc(t("profileTitle"))}</h2>
    <p class="who">${esc(email)}</p>
    <div class="stack">
      <p class="field-label">${esc(t("language"))}</p>
      ${langButtons()}
      <p class="fine">${esc(t("privacy"))}</p>
      ${notice ? `<p class="msg ok" role="status">${esc(notice)}</p>` : ""}
      <button class="btn quiet danger" id="delete-scans">${esc(t("deleteScans"))}</button>
      <button class="btn primary" id="sign-out">${esc(t("signOut"))}</button>
    </div>
  </section>`;
}
