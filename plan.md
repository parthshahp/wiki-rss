# Wikipedia RSS Worker Plan (No Database)

## Goal
Build a Cloudflare Worker (TypeScript) that serves shared RSS feeds by cadence where:
- Users choose `x` days (`x` is an integer from 1 to 7).
- Feed URL depends only on cadence: `/feed/x.xml`.
- Everyone getting an article on the same UTC date gets the same article.
- No database is used.

## Core Decisions
1. No subscribers table and no persistence layer.
2. Deterministic article mapping from date to Wikipedia page.
3. Shared cadence feeds:
   - `/feed/1.xml` through `/feed/7.xml`
4. UTC-only scheduling.

## Architecture
1. **Cloudflare Worker (TypeScript)**
   - Serves frontend and feed routes.
2. **Wikipedia API**
   - Fetch article details by deterministic page id.
3. **Optional Cloudflare Cache**
   - Cache feed responses briefly to reduce repeated API work.

## Deterministic Date -> Article Algorithm
1. Normalize date to UTC `YYYY-MM-DD`.
2. Query Wikipedia featured feed endpoint for that date:
   - `/api/rest_v1/feed/featured/YYYY/MM/DD`
3. Read `tfa` (Today’s Featured Article).
4. Use `tfa` title, URL, page id, and extract as the article for that date.
5. Same UTC date always maps to the same featured article.

## Cadence Logic
1. Cadence input `x` must be integer from 1 to 7.
2. Use fixed anchor date (UTC): `2026-01-01`.
3. A date is a publish date for cadence `x` if:
   - `days_between(anchor_date, date) % x == 0`
4. This keeps schedule identical for all users on `/feed/x.xml`.

## Frontend Plan
1. Route: `GET /`
2. UI:
   - Number input labeled `Receive an article every x days`
   - `min=1`, `max=7`, `step=1`, default `1`
3. Output:
   - Show generated URL `/feed/{x}.xml`
   - Copy button
4. Validation:
   - Client and server validate integer range `[1,7]`

## API Routes
1. `GET /`
   - Frontend page for cadence selection.
2. `GET /feed/:x.xml`
   - Validate `x`.
   - Compute recent scheduled dates.
   - Resolve each date deterministically to a Wikipedia article.
   - Return RSS XML.
3. `GET /article/:date`
   - Debug endpoint for deterministic date->article output.
4. `GET /health`
   - Basic health response.

## RSS Behavior
1. Feed identity: cadence-based (`/feed/{x}.xml`).
2. Item GUID: `${date}:${wiki_page_id}`.
3. Publish history:
   - Include last `N` scheduled items (configurable, default 20).
4. All content generated from deterministic resolver (no DB reads).

## Error Handling
1. Invalid `x` -> `400`.
2. Invalid date format on `/article/:date` -> `400`.
3. Wikipedia lookup failure after deterministic attempts -> `503`.
4. Internal unexpected errors -> `500`.

## Security and Operations
1. Rate-limit feed and debug endpoints.
2. Cache feed responses (`max-age` short TTL).
3. Add structured logs for:
   - cadence requests
   - date->featured lookup failures
   - generation latency

## Implementation Steps
1. Finalize deterministic resolver function.
2. Keep frontend selector (`x` from 1 to 7).
3. Ensure Worker config has no D1 binding.
4. Remove migration/database scripts/docs.
5. Add tests:
   - cadence validation
   - deterministic repeatability for same date+salt
   - route behavior for valid/invalid `x`
