# wiki-rss

Cloudflare Worker (TypeScript) that serves shared Wikipedia RSS feeds by cadence using Wikipedia's featured article (`tfa`) for each UTC date (no database).

## Feed URLs

- `GET /feed/1.xml` to `GET /feed/7.xml`
- `x` means "one article every x days"
- Same UTC day always maps to the same article for everyone
- No D1/KV required for MVP

## Local setup

1. Install dependencies:
   - `npm install`
2. Run dev server:
   - `npm run dev`
3. Optional type-check:
   - `npm run typecheck`

## Routes

- `GET /` UI for selecting cadence and copying RSS URL
- `GET /feed/:x.xml` cadence feed (`x` in `1..7`)
- `GET /health` health endpoint
- `GET /article/:date` inspect article for `YYYY-MM-DD`

## Determinism

- Worker queries Wikipedia featured feed for the requested UTC date.
- It uses `tfa` (Today’s Featured Article) as that date's article.
- Same date always resolves to the same article for everyone.
