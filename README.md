# FossilTrace

**A map of the world's fossil finds, and a place for fossil hunters to log their own.**

Live at **[fossiltrace.vercel.app](https://fossiltrace.vercel.app)**

FossilTrace puts real fossil records on a satellite globe. Zoom anywhere to see museum specimens and research sites, click one to learn what it is, or tap bare ground to see the bedrock under your feet and whether collecting is allowed there. Signed-in users can log their own finds, and the community helps identify them, much like iNaturalist does for living things.

## Features

**Explore**
- **Museum specimens** from [GBIF](https://www.gbif.org) (ROM, Smithsonian, Yale Peabody and hundreds more), with common and scientific name, family, age, rock unit, who found it and when, and the holding museum.
- **Pictures** of the specimen itself when the museum published one, otherwise a labelled reference image from Wikipedia.
- **Research sites** from the [Paleobiology Database](https://paleobiodb.org) (PBDB), drawn as rings. Clicking one lists every fossil recorded there with its publication.
- **Time bar** to filter by geologic period, with dots colored by age (ICS colors) or by fossil group.
- **Fossil group search** with common names ("trilobites", "ammonites"), backed by PBDB.
- **Bedrock layer** from [Macrostrat](https://macrostrat.org). Tap anywhere for the rock unit, age and lithology.
- **"Can I collect here?"** Protected areas from [Protected Planet](https://www.protectedplanet.net) plus short collecting rules for the US, Canada (Alberta, BC, Ontario) and the UK.
- **Share links**: the whole view lives in the URL, and "Copy link" shares it exactly.
- **Famous sites** tour for a quick start.

**Log finds**
- Email magic-link sign-in with Cloudflare Turnstile CAPTCHA.
- Log a find with photos, date, guess and notes, and optionally flag it as notable for a museum. Exact locations stay private; the public map shows them snapped to about 10 km.
- **Community ID**: others suggest names; a find is marked **Confirmed** when at least two other people agree and the name has over two thirds of the votes.
- Plausibility checks against PBDB and Macrostrat (for example, a dinosaur in Cambrian rock gets flagged).
- **Abuse protections**: report button (3 reports hide a find), 20 finds a day per account, 2 MB JPEG photos only, banned accounts, and a "confirmed only" filter.

## How it works

```
Browser (index.html, app.js, finds.js, style.css)
   |                         \
   |  /api/proxy?url=...      \  Supabase JS (publishable key)
   v                           v
Vercel edge function        Supabase (Postgres + PostGIS, Auth, Storage)
(api/proxy.js)              finds, profiles, identifications, reports
   |  cached 4 days on Vercel's CDN, 2 more days stale-while-revalidate
   v
GBIF · PBDB · Macrostrat · Protected Planet · Wikipedia · Nominatim
```

- **No build step.** Plain HTML, CSS and JavaScript with [MapLibre GL](https://maplibre.org) (globe view) and Esri World Imagery.
- **One edge function**, `api/proxy.js`, sits in front of the public data APIs. It only forwards to an allowlist of hosts and lets Vercel's CDN cache each answer, so all visitors share results and the APIs see about one call per URL every few days.
- **Finds load per fixed map tile** (up to 100 per tile, 8 tiles at a time) so requests repeat and hit the cache.
- **Supabase** stores logged finds. Row-level security and column-level grants mean users can only write their own rows and can't set moderation fields. Public reads go through `security definer` functions (`map_finds`, `find_identifications`) that never return exact locations or notes.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | Page shell and script tags |
| `app.js` | Map, data layers, filters, specimen and site panels |
| `finds.js` | Sign-in, logging finds, community ID, reporting |
| `style.css` | Styles |
| `api/proxy.js` | Vercel edge function: allowlisted, CDN-cached API proxy |
| `supabase/migrations/` | Database schema, in the order it was applied |

## Running locally

```bash
npm i -g vercel
vercel dev
```

Then open http://localhost:3000. The map works without any setup. Logging finds talks to the production Supabase project; sign-in links and the Turnstile CAPTCHA are tied to `fossiltrace.vercel.app`, so use the live site to test those.

## Deploying

The Vercel project is connected to this repo. Every push to `main` deploys to production at fossiltrace.vercel.app, and every pull request gets its own preview link (previews need a Vercel login). To undo a bad release, use Instant Rollback on an earlier deployment in the Vercel dashboard.

## Setting up your own database

1. Create a Supabase project and run the files in `supabase/migrations/` in order (SQL editor, or `supabase db push` with the Supabase CLI).
2. Put your project URL and publishable key at the top of `finds.js`.
3. In Supabase Auth, set the Site URL and redirect URLs to your domain. Optionally turn on CAPTCHA (Turnstile) and set `TURNSTILE_SITE_KEY` in `finds.js`.

Moderation today is done in the Supabase table editor: set `finds.hidden` to hide a find, or `profiles.banned` to block an account.

## Backups

`.github/workflows/backup.yml` dumps the database every Monday, encrypts it, and keeps it as a workflow artifact for 90 days. It needs two repository secrets (Settings > Secrets and variables > Actions):

- `SUPABASE_DB_URL`: the **Session pooler** connection string from Supabase (Connect button), with the database password filled in. The direct connection doesn't work from GitHub's runners because it is IPv6 only.
- `BACKUP_PASSPHRASE`: a long random string. Keep a copy somewhere safe; without it the backups can't be opened.

To restore, download the artifact from the workflow run, then:

```bash
gpg --decrypt fossiltrace-YYYY-MM-DD.dump.gpg > backup.dump
pg_restore --no-owner --no-privileges --dbname "$NEW_DB_URL" backup.dump
```

Photos in the `find-photos` storage bucket are not included yet.

## Analytics

`index.html` loads [Vercel Web Analytics](https://vercel.com/docs/analytics) (page views, referrers, countries; no cookies). It starts counting once Web Analytics is enabled for the project in the Vercel dashboard.

## Known limits

- GBIF and Wikipedia rate-limit bursts (HTTP 429). Requests are throttled and retried, but gaps can still appear.
- GBIF's backbone taxonomy lacks some fossil groups (Dinosauria, Ammonoidea), so those searches fall back to sub-groups and may be incomplete; the app says when this happens.
- Collecting rules are short summaries, not legal advice, and protected-area data doesn't cover private land.
- Many museum records have no collector or date ("Not recorded").
- Esri World Imagery and the public Nominatim server are fine for a free project; a paid tier would need licensed imagery and geocoding.

## Data and credits

Fossil records: [GBIF](https://www.gbif.org) (each record keeps its dataset's license; see the GBIF link in the panel) and the [Paleobiology Database](https://paleobiodb.org) (CC BY 4.0). Geology: [Macrostrat](https://macrostrat.org) (CC BY 4.0). Protected areas: [Protected Planet / WDPA](https://www.protectedplanet.net). Images and descriptions: [Wikipedia](https://www.wikipedia.org) and Wikimedia Commons. Imagery: Esri, Maxar, Earthstar Geographics. Place search: [OpenStreetMap](https://www.openstreetmap.org) Nominatim.
