# Crop Check

Photograph a sick crop leaf. Get a diagnosis, a low-cost treatment plan in English or Kiswahili,
and see confirmed disease outbreaks near you.

Built for the **Meta Global AI Developer Hackathon**, indie developer track, theme **Build for Your World**:
smallholder farmers in Kenya lose crops to diseases they cannot identify in time.

## What it does

- **Diagnose from a photo.** A Meta vision model reads the leaf and returns the crop, the disease,
  how much of the leaf is affected, boxes around the damaged areas, and low-cost treatment steps.
- **Honest about uncertainty.** Low confidence or a blurry photo asks for a retake and sends the farmer
  to an extension officer instead of guessing. Chemical advice always carries the PCPB (Kenya) reminder.
- **Outbreak map that resists false alarms.** A disease appears on the map only when **two or more different
  farmers** report it in the same ~11 km area within 14 days. Locations are rounded and never linked to a name.
- **Made for phones.** Installable PWA, photos compressed on the device, English and Kiswahili.
- **Protected API.** The Meta key stays on the server, every scan needs a signed-in farmer,
  and each farmer is limited to 10 scans per hour.

## How it is built

```
web/       Vite PWA (vanilla JS, Leaflet map)     -> Cloudflare Pages
worker/    Cloudflare Worker API gateway          -> calls the Meta Model API, saves to Supabase
supabase/  schema.sql: scans, private outbreak reports, get_outbreaks() with the 2-farmer rule
```

## Build history (for the judges)

An early prototype with the same idea existed before the hackathon began, in a separate private repository.
**This repository was started from an empty repo after kickoff on 26 October 2026 and everything in it was
written during the event.** No files were copied from the prototype. The commit history shows the work as it happened.

## Setup

1. **Supabase:** create a project, run `supabase/schema.sql` in the SQL Editor.
   Authentication > Providers > Email on, minimum password length 8.
   Add your site address under Authentication > URL Configuration.
2. **Worker** (Cloudflare, connect this repo): root directory `/worker`, build command empty,
   deploy command `npx wrangler deploy`. In the dashboard under Variables and Secrets add
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLOWED_ORIGIN` (your site address),
   `META_BASE_URL`, `VISION_MODEL`, and the secret `MODEL_API_KEY`.
   The model call assumes an OpenAI-compatible `chat/completions` endpoint; adjust `diagnose()` in
   `worker/src/index.ts` if the Meta Model API differs.
3. **Pages** (Cloudflare, same repo): build command `npm run build`, output directory `web/dist`.
   Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE` (the Worker address).
4. **Check:** open `<worker address>/api/health`. It reports whether Supabase and the model are configured.

## Local development

```
npm --prefix worker install && npm --prefix worker run dev     # needs worker/.dev.vars
npm --prefix web install && npm --prefix web run dev           # needs web/.env
```

## Licence

MIT
