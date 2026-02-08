# wiki-rss

Cloudflare Worker (TypeScript) that serves shared Wikipedia RSS feeds by cadence using a deterministic date->article mapping (no database).

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

- Worker computes a stable hash from `ARTICLE_SALT` + UTC date.
- It probes deterministic Wikipedia page IDs until it finds a valid page.
- Same `ARTICLE_SALT` and same date always produce the same article.
