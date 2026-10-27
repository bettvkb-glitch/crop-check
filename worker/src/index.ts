/**
 * Crop Check API gateway (Cloudflare Worker)
 *
 * POST /api/scan   -> verify user, run SAM 3.1 + Muse Spark in parallel,
 *                     save the result to Supabase, return it to the client.
 * GET  /api/health -> liveness check
 *
 * The Meta key lives only here (Worker secret). The browser never sees it.
 */

export interface Env {
  MODEL_API_KEY: string; // secret
  META_BASE_URL: string; // https://api.meta.ai/v1
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ALLOWED_ORIGIN: string;
}

const MAX_IMAGE_BYTES = 3_000_000; // client compresses to ~300-600 KB; this is a hard cap
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const SPARK_MODEL = "muse-spark-1.1";
const SAM_MODEL = "sam-3.1";

// ---------- helpers ----------

function corsHeaders(env: Env, req: Request): HeadersInit {
  const origin = req.headers.get("Origin");
  const allowed = origin && origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(env: Env, req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, req) },
  });
}

/** Verify the Supabase access token and return the user id (or null). */
async function getUser(env: Env, token: string): Promise<{ id: string } | null> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string };
  return user.id ? { id: user.id } : null;
}

/** Call Meta Model API (OpenAI Responses format). */
async function metaResponses(env: Env, payload: Record<string, unknown>, timeoutMs: number) {
  const res = await fetch(`${env.META_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.MODEL_API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Meta API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as any;
}

/** Pull the text out of a Responses API result (handles both shapes). */
function extractText(data: any): string {
  if (typeof data?.output_text === "string") return data.output_text;
  const parts: string[] = [];
  for (const item of data?.output ?? []) {
    for (const c of item?.content ?? []) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

// ---------- model calls ----------

/** SAM 3.1: one concrete noun phrase per request. Returns raw output for client/parser. */
async function segment(env: Env, image: string, concept: string) {
  const data = await metaResponses(
    env,
    {
      model: SAM_MODEL,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: concept },
            { type: "input_image", image_url: image },
          ],
        },
      ],
    },
    20_000,
  );
  // NOTE: SAM returns special-token text (boxes + encoded masks). Meta ships a
  // parser (`meta-sam-parser`, Python/native). For the first build we pass the raw
  // string through; see web/src/sam.js for the client-side TODO.
  return { concept, raw: extractText(data) };
}

const DIAGNOSIS_INSTRUCTIONS = `You are an agronomy assistant for smallholder farmers.
Look at the crop photo and reply with ONLY a JSON object (no markdown) shaped like:
{
  "crop": string,
  "is_healthy": boolean,
  "disease": string | null,
  "confidence": number,            // 0 to 1
  "severity": "none" | "low" | "moderate" | "severe",
  "summary": string,               // 1-2 plain sentences, 6th-grade reading level
  "symptoms_seen": string[],
  "treatment": {
    "act_today": string[],
    "low_cost_or_organic": string[],
    "chemical_options": string[],  // active ingredients, not brand names
    "prevention": string[]
  },
  "see_expert": boolean
}
Rules: prefer low-cost options available to small farms. If confidence is under 0.6 or the
photo is unclear, set see_expert to true and say what photo would help. Never invent a
disease to sound certain.`;

async function diagnose(env: Env, image: string, cropHint?: string) {
  const data = await metaResponses(
    env,
    {
      model: SPARK_MODEL,
      reasoning: { effort: "low" }, // keep latency down on mobile networks
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: DIAGNOSIS_INSTRUCTIONS }] },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: cropHint ? `Crop (user says): ${cropHint}` : "Crop not specified." },
            { type: "input_image", image_url: image },
          ],
        },
      ],
    },
    30_000,
  );
  const text = extractText(data).trim();
  const match = text.match(/\{[\s\S]*\}/); // tolerate stray text around the JSON
  if (!match) throw new Error("Diagnosis was not valid JSON");
  return JSON.parse(match[0]);
}

// ---------- persistence ----------

const round2 = (n: unknown) => (typeof n === "number" && isFinite(n) ? Math.round(n * 100) / 100 : null); // ~1 km, protects farm location

async function saveScan(env: Env, token: string, d: any, lat: number | null, lng: number | null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/scans`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`, // user's own JWT, so RLS applies
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      crop: d.crop ?? null,
      disease: d.is_healthy ? null : (d.disease ?? null),
      confidence: typeof d.confidence === "number" ? d.confidence : null,
      severity: d.severity ?? null,
      treatment: d.treatment ?? null,
      lat,
      lng,
    }),
  });
  if (!res.ok) throw new Error(`Supabase insert ${res.status}`);
  const rows = (await res.json()) as any[];
  return rows[0];
}

// ---------- routes ----------

async function handleScan(req: Request, env: Env): Promise<Response> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return json(env, req, { error: "Sign in required" }, 401);
  const user = await getUser(env, token);
  if (!user) return json(env, req, { error: "Session expired. Reload the app." }, 401);

  let body: { image?: string; crop?: string; lat?: number; lng?: number };
  try {
    body = await req.json();
  } catch {
    return json(env, req, { error: "Send JSON with an image field" }, 400);
  }

  const image = body.image ?? "";
  if (!DATA_URL_RE.test(image)) return json(env, req, { error: "Image must be a JPEG, PNG or WebP data URL" }, 400);
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return json(env, req, { error: "Image too large. Try a closer, smaller photo." }, 413);

  const crop = typeof body.crop === "string" ? body.crop.slice(0, 40) : undefined;

  // Run both models at once; segmentation is a bonus, diagnosis is required.
  const [diag, seg] = await Promise.allSettled([diagnose(env, image, crop), segment(env, image, "diseased leaf")]);

  if (diag.status === "rejected") {
    console.error("diagnose failed", diag.reason);
    return json(env, req, { error: "Diagnosis is unavailable right now. Try again in a moment." }, 502);
  }

  let saved: any = null;
  try {
    saved = await saveScan(env, token, diag.value, round2(body.lat), round2(body.lng));
  } catch (e) {
    console.error("save failed", e); // still return the diagnosis to the farmer
  }

  return json(env, req, {
    scanId: saved?.id ?? null,
    saved: Boolean(saved),
    diagnosis: diag.value,
    segmentation: seg.status === "fulfilled" ? seg.value : null,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env, req) });
    if (url.pathname === "/api/health") return json(env, req, { ok: true });

    if (url.pathname === "/api/scan" && req.method === "POST") {
      try {
        return await handleScan(req, env);
      } catch (e) {
        console.error(e);
        return json(env, req, { error: "Something went wrong" }, 500);
      }
    }
    return json(env, req, { error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
