// Crop Check API gateway (Cloudflare Worker).
// Keeps the Meta API key off the phone, checks the farmer is signed in,
// limits how often one farmer can scan, then saves the result to Supabase.

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  MODEL_API_KEY: string;
  META_BASE_URL?: string;
  VISION_MODEL?: string;
  ALLOWED_ORIGIN?: string;
}

const MAX_IMAGE_CHARS = 2_000_000; // ~1.5 MB of image after base64
const SCANS_PER_HOUR = 10;

type Json = Record<string, unknown>;

// ---------- helpers ----------

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  // No ALLOWED_ORIGIN set means local development: allow any origin.
  const allow = allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function reply(req: Request, env: Env, body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req, env), "Content-Type": "application/json" },
  });
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === "number" ? n : parseFloat(String(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

const cleanList = (v: unknown, max: number, len = 220): string[] =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, max).map((x) => (x as string).trim().slice(0, len))
    : [];

const cleanKey = (v: unknown, fallback: string): string => {
  const s = String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return s || fallback;
};

// ---------- Supabase ----------

async function getUser(token: string, env: Env): Promise<{ id: string } | null> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!r.ok) return null;
  const u = (await r.json()) as { id?: string };
  return u.id ? { id: u.id } : null;
}

async function scansLastHour(token: string, env: Env): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/scans?select=id&created_at=gte.${encodeURIComponent(since)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_ANON_KEY,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  // content-range looks like "0-0/12" or "*/0"
  const total = (r.headers.get("content-range") || "").split("/")[1];
  const n = parseInt(total, 10);
  return Number.isFinite(n) ? n : 0;
}

async function saveScan(token: string, env: Env, row: Json): Promise<Json | null> {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/scans`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) return null;
  const rows = (await r.json()) as Json[];
  return rows[0] || null;
}

// ---------- the model ----------

const SYSTEM_PROMPT = `You are an experienced agronomist helping smallholder farmers in Kenya.
You are shown one photo of a crop leaf. Reply with ONE JSON object and nothing else.

Rules:
- Only diagnose what is visible. If the image is not a plant leaf, or too blurry or dark to judge, set "is_plant_leaf": false and explain in "note" how to retake the photo.
- If you are unsure, lower "confidence" and set "see_expert": true. Never invent certainty.
- Advice must be low-cost and realistic for a smallholder: start with cultural and organic steps.
- For chemical options give generic active ingredients only, and always say to use only products registered by the Pest Control Products Board (PCPB) and to follow the label.
- Keep every list item to one short sentence in plain words.

JSON shape:
{
  "is_plant_leaf": true,
  "crop": "lowercase English crop name, or unknown",
  "disease_key": "lowercase_snake_case English name, or healthy, or unknown",
  "disease": "disease name written in the requested language",
  "confidence": 0.0,
  "severity": "none | low | moderate | severe",
  "affected_percent": 0,
  "affected_regions": [{"x":0.0,"y":0.0,"w":0.0,"h":0.0}],
  "symptoms": ["what you can see on the leaf"],
  "treatment": {
    "immediate": ["what to do today"],
    "organic": ["low-cost or natural options"],
    "chemical": ["generic active ingredients, with the PCPB reminder"],
    "prevention": ["how to stop it coming back"]
  },
  "see_expert": false,
  "note": "one short extra sentence, or empty"
}
"affected_regions" are boxes around damaged areas as fractions of the image width and height (0 to 1, x and y are the top-left corner). Give at most 6.
"affected_percent" is the share of the visible leaf that is damaged, 0 to 100.`;

function extractJson(text: string): Json | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Json;
  } catch {
    return null;
  }
}

export function sanitize(raw: Json): Json {
  const isLeaf = raw.is_plant_leaf !== false;
  const sevIn = String(raw.severity || "none").toLowerCase();
  const severity = ["none", "low", "moderate", "severe"].includes(sevIn) ? sevIn : "none";
  const t = (raw.treatment && typeof raw.treatment === "object" ? raw.treatment : {}) as Json;

  const regions = (Array.isArray(raw.affected_regions) ? raw.affected_regions : [])
    .slice(0, 6)
    .map((r) => {
      const o = (r || {}) as Json;
      const x = clamp(o.x, 0, 1, 0);
      const y = clamp(o.y, 0, 1, 0);
      const r3 = (n: number) => Math.round(n * 1000) / 1000;
      return {
        x: r3(x),
        y: r3(y),
        w: r3(Math.min(clamp(o.w, 0, 1, 0), 1 - x)),
        h: r3(Math.min(clamp(o.h, 0, 1, 0), 1 - y)),
      };
    })
    .filter((r) => r.w > 0.02 && r.h > 0.02);

  return {
    is_plant_leaf: isLeaf,
    crop: isLeaf ? cleanKey(raw.crop, "unknown") : "unknown",
    disease_key: isLeaf ? cleanKey(raw.disease_key, "unknown") : "unknown",
    disease: String(raw.disease || "").trim().slice(0, 80),
    confidence: isLeaf ? clamp(raw.confidence, 0, 1, 0) : 0,
    severity: isLeaf ? severity : "none",
    affected_percent: isLeaf ? Math.round(clamp(raw.affected_percent, 0, 100, 0)) : 0,
    affected_regions: isLeaf ? regions : [],
    symptoms: cleanList(raw.symptoms, 6),
    treatment: {
      immediate: cleanList(t.immediate, 5),
      organic: cleanList(t.organic, 5),
      chemical: cleanList(t.chemical, 4),
      prevention: cleanList(t.prevention, 5),
    },
    see_expert: raw.see_expert === true || !isLeaf,
    note: String(raw.note || "").trim().slice(0, 240),
  };
}

async function diagnose(env: Env, image: string, lang: string, cropHint: string): Promise<Json | null> {
  // ASSUMPTION: an OpenAI-compatible chat completions endpoint. Check the Meta Model API
  // docs from the hackathon and adjust the URL, headers and body here if they differ.
  const base = (env.META_BASE_URL || "").replace(/\/+$/, "");
  const language = lang === "sw" ? "Swahili" : "English";
  const hint = cropHint && cropHint !== "unknown" ? ` The farmer says the crop is ${cropHint}.` : "";

  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.VISION_MODEL,
      temperature: 0.2,
      max_tokens: 1400,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `Write all text fields in ${language}.${hint} Diagnose this leaf.` },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
    }),
  });
  if (!r.ok) return null;
  const data = (await r.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p?.text || "").join("") : "";
  const parsed = extractJson(text);
  return parsed ? sanitize(parsed) : null;
}

// ---------- routes ----------

async function handleScan(req: Request, env: Env): Promise<Response> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(req, env, { error: "sign_in_required" }, 401);

  const user = await getUser(token, env);
  if (!user) return reply(req, env, { error: "sign_in_required" }, 401);

  let body: Json;
  try {
    body = (await req.json()) as Json;
  } catch {
    return reply(req, env, { error: "bad_request" }, 400);
  }

  const image = typeof body.image === "string" ? body.image : "";
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > MAX_IMAGE_CHARS) {
    return reply(req, env, { error: "bad_image" }, 400);
  }

  if ((await scansLastHour(token, env)) >= SCANS_PER_HOUR) {
    return reply(req, env, { error: "rate_limited" }, 429);
  }

  if (!env.MODEL_API_KEY || !env.META_BASE_URL || !env.VISION_MODEL) {
    return reply(req, env, { error: "model_not_configured" }, 503);
  }

  const lang = body.lang === "sw" ? "sw" : "en";
  const cropHint = cleanKey(body.crop, "unknown");
  const result = await diagnose(env, image, lang, cropHint);
  if (!result) return reply(req, env, { error: "diagnosis_unavailable" }, 502);

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  const saved = await saveScan(token, env, {
    crop: result.crop,
    disease: result.disease,
    disease_key: result.disease_key,
    confidence: result.confidence,
    severity: result.severity,
    affected_percent: result.affected_percent,
    result,
    lat: hasLocation ? Math.round(lat * 100) / 100 : null,
    lng: hasLocation ? Math.round(lng * 100) / 100 : null,
  });

  return reply(req, env, { result, scan_id: saved ? saved.id : null });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req, env) });

    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/api/health") {
      return reply(req, env, {
        ok: true,
        app: "crop-check",
        configured: {
          supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
          model: Boolean(env.MODEL_API_KEY && env.META_BASE_URL && env.VISION_MODEL),
        },
      });
    }

    if (req.method === "POST" && pathname === "/api/scan") {
      try {
        return await handleScan(req, env);
      } catch {
        return reply(req, env, { error: "server_error" }, 500);
      }
    }

    return reply(req, env, { error: "not_found" }, 404);
  },
};
