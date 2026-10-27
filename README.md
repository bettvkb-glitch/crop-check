# Crop Check

Photograph a sick crop leaf, get a diagnosis and treatment plan, see outbreaks nearby live.

```
web/       Vite PWA  -> Cloudflare Pages
worker/    Cloudflare Worker (API gateway) -> SAM 3.1 + Muse Spark (Meta Model API)
supabase/  schema.sql (scans, outbreak_signals, RLS, Realtime)
```

## Setup
1. **Supabase**: create a project and run `supabase/schema.sql`. Then in *Authentication*:
   - Providers > Email: on. Set minimum password length to 8.
   - Decide on *Confirm email*. On = users must click a link before signing in (the app handles both).
   - URL Configuration: add your Pages URL and `http://localhost:5173` to Site URL / Redirect URLs
     (needed for confirmation and password-reset links).
2. **Meta**: create a key at dev.meta.ai (US-only public preview at launch; check current availability).
3. **Worker**: edit `worker/wrangler.toml` (SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_ORIGIN).
   Local: `cp worker/.dev.vars.example worker/.dev.vars`, add the key, `npm run dev:worker`.
   Prod: `npx wrangler secret put MODEL_API_KEY` then `npm run deploy:worker`.
4. **Web**: `cp web/.env.example web/.env`, fill in values, `npm i && npm run dev:web`.
5. **Pages**: connect the GitHub repo. Build command `npm run build`, output `web/dist`,
   env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE` (your Worker URL).
   Then set the Worker's `ALLOWED_ORIGIN` to your Pages URL.

## Known gaps (next steps)
- SAM output parsing (`web/src/sam.js`): Meta's parser is Python/native; port the grammar to JS.
- Real map (MapLibre/Leaflet) on top of the existing Realtime feed.
- Rate limiting on `/api/scan` (Cloudflare Rate Limiting rules or a Durable Object).
- Offline queue for scans taken without signal.

## Auth flow
`index.html` has three screens: `#boot` (waiting for Supabase), `#auth` (sign in / create account /
reset / new password) and `#app` (dashboard). `web/src/main.js` `route()` is the only place that picks
one, driven by `supabase.auth.onAuthStateChange`. The Worker re-verifies the user's JWT on every scan,
so the gate is not just cosmetic.

## Design notes
- Look follows the Kenya Educators reference: light mint background, white header with the black/red/green flag stripe,
  green primary buttons, rounded white cards with soft green icon chips, a "Just reported" card strip and a bottom tab bar
  (Home, Scan, Outbreaks, Profile). Dark theme is kept and switchable from the Profile menu. One font family (Inter);
  remove the two `<link>` tags in `web/index.html` to fall back to system fonts on the slowest networks.
- Farmer-help button: set `SUPPORT_WHATSAPP` in `web/src/main.js` (digits with country code). Empty = hidden.
