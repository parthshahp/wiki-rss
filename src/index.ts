interface Env {
  ANCHOR_DATE?: string;
  MAX_FEED_ITEMS?: string;
  ARTICLE_SALT?: string;
}

type DailyArticle = {
  date: string;
  wiki_page_id: number;
  title: string;
  url: string;
  extract: string;
  chosen_at: string;
};

type WikipediaQueryResponse = {
  query?: {
    pages?: Array<{
      pageid?: number;
      title?: string;
      fullurl?: string;
      extract?: string;
      missing?: boolean;
      invalid?: boolean;
    }>;
  };
};

const CADENCE_MIN = 1;
const CADENCE_MAX = 7;
const DEFAULT_MAX_FEED_ITEMS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ARTICLE_SALT = "wiki-rss";
const MAX_WIKI_PAGE_ID = 60_000_000;
const MAX_PAGE_LOOKUP_ATTEMPTS = 14;
const PAGEID_STEP = 104_729;

class ArticleResolutionError extends Error {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const anchorDate = env.ANCHOR_DATE ?? "2026-01-01";
      const maxFeedItems = parsePositiveInt(env.MAX_FEED_ITEMS, DEFAULT_MAX_FEED_ITEMS);
      const articleSalt = env.ARTICLE_SALT ?? DEFAULT_ARTICLE_SALT;

      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      if (url.pathname === "/") {
        return new Response(renderHomePage(url.origin), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/health") {
        return Response.json({ ok: true, now_utc: new Date().toISOString() });
      }

      const feedMatch = url.pathname.match(/^\/feed\/(\d+)\.xml$/);
      if (feedMatch) {
        const cadence = Number(feedMatch[1]);
        if (!isValidCadence(cadence)) {
          return Response.json(
            { error: `cadence must be an integer from ${CADENCE_MIN} to ${CADENCE_MAX}` },
            { status: 400 },
          );
        }

        const today = toIsoDate(new Date());
        const publishDates = getRecentPublishDates(today, cadence, anchorDate, maxFeedItems);
        const articles: DailyArticle[] = [];

        for (const date of publishDates) {
          const article = await getDeterministicDailyArticle(date, articleSalt);
          articles.push(article);
        }

        const xml = buildRssXml({
          origin: url.origin,
          cadence,
          items: articles,
          generatedAt: new Date().toUTCString(),
        });

        return new Response(xml, {
          headers: {
            "content-type": "application/rss+xml; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      }

      const articleMatch = url.pathname.match(/^\/article\/(\d{4}-\d{2}-\d{2})$/);
      if (articleMatch) {
        const date = articleMatch[1];
        if (!isIsoDate(date)) {
          return Response.json({ error: "invalid date format, expected YYYY-MM-DD" }, { status: 400 });
        }
        const article = await getDeterministicDailyArticle(date, articleSalt);
        return Response.json(article);
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      if (error instanceof ArticleResolutionError) {
        return Response.json({ error: "article_unavailable", message: error.message }, { status: 503 });
      }
      const message = error instanceof Error ? error.message : "unknown error";
      return Response.json({ error: "internal_error", message }, { status: 500 });
    }
  },
};

async function getDeterministicDailyArticle(date: string, salt: string): Promise<DailyArticle> {
  const seed = seededHash(`${salt}:${date}`);
  for (let attempt = 0; attempt < MAX_PAGE_LOOKUP_ATTEMPTS; attempt += 1) {
    const pageId = candidatePageId(seed, attempt);
    const page = await fetchWikipediaPageById(pageId);
    if (!page) {
      continue;
    }
    const title = page.title?.trim() || "Wikipedia Article";
    const pageUrl = page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    const extract = page.extract?.trim() || "No summary available.";
    return {
      date,
      wiki_page_id: pageId,
      title,
      url: pageUrl,
      extract,
      chosen_at: `${date}T00:00:00.000Z`,
    };
  }

  throw new ArticleResolutionError(`unable to resolve wikipedia article for date ${date}`);
}

async function fetchWikipediaPageById(pageId: number): Promise<{
  title?: string;
  fullurl?: string;
  extract?: string;
} | null> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "extracts|info",
    inprop: "url",
    exintro: "1",
    explaintext: "1",
    pageids: String(pageId),
  });
  const endpoint = `https://en.wikipedia.org/w/api.php?${params.toString()}`;

  for (let retry = 1; retry <= 2; retry += 1) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          accept: "application/json",
          "user-agent": "wiki-rss-worker/0.1",
        },
      });
      if (!response.ok) {
        throw new Error(`wikipedia returned ${response.status}`);
      }

      const body = (await response.json()) as WikipediaQueryResponse;
      const page = body.query?.pages?.[0];
      if (!page || page.missing || page.invalid || !page.pageid) {
        return null;
      }
      return page;
    } catch {
      if (retry === 2) {
        return null;
      }
      await sleep(retry * 120);
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidCadence(value: number): boolean {
  return Number.isInteger(value) && value >= CADENCE_MIN && value <= CADENCE_MAX;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getRecentPublishDates(today: string, cadence: number, anchorDate: string, maxItems: number): string[] {
  const results: string[] = [];
  const todayMs = isoDateToUtcMs(today);

  for (let offset = 0; results.length < maxItems && offset < 3650; offset += 1) {
    const date = toIsoDate(new Date(todayMs - offset * DAY_MS));
    if (isPublishDay(date, cadence, anchorDate)) {
      results.push(date);
    }
  }

  return results;
}

function isPublishDay(date: string, cadence: number, anchorDate: string): boolean {
  if (!isIsoDate(anchorDate)) {
    anchorDate = "2026-01-01";
  }
  const delta = daysBetweenUtc(anchorDate, date);
  return delta >= 0 && delta % cadence === 0;
}

function daysBetweenUtc(from: string, to: string): number {
  const fromMs = isoDateToUtcMs(from);
  const toMs = isoDateToUtcMs(to);
  return Math.floor((toMs - fromMs) / DAY_MS);
}

function isoDateToUtcMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && toIsoDate(new Date(timestamp)) === value;
}

function seededHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function candidatePageId(seed: number, attempt: number): number {
  const offset = (seed + attempt * PAGEID_STEP) % MAX_WIKI_PAGE_ID;
  return offset + 1;
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildRssXml(params: {
  origin: string;
  cadence: number;
  items: DailyArticle[];
  generatedAt: string;
}): string {
  const { origin, cadence, items, generatedAt } = params;
  const feedUrl = `${origin}/feed/${cadence}.xml`;
  const channelTitle = `Wikipedia Every ${cadence} Day${cadence === 1 ? "" : "s"}`;
  const description = `Shared Wikipedia RSS feed with one article every ${cadence} day${cadence === 1 ? "" : "s"}.`;

  const itemXml = items
    .map((item) => {
      const title = escapeXml(item.title);
      const link = escapeXml(item.url);
      const guid = escapeXml(`${item.date}:${item.wiki_page_id}`);
      const summary = escapeXml(item.extract);
      const pubDate = new Date(`${item.date}T00:00:00.000Z`).toUTCString();
      return [
        "<item>",
        `  <title>${title}</title>`,
        `  <link>${link}</link>`,
        `  <guid isPermaLink="false">${guid}</guid>`,
        `  <pubDate>${pubDate}</pubDate>`,
        `  <description>${summary}</description>`,
        "</item>",
      ].join("\n");
    })
    .join("\n");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<rss version=\"2.0\">",
    "<channel>",
    `  <title>${escapeXml(channelTitle)}</title>`,
    `  <link>${escapeXml(feedUrl)}</link>`,
    `  <description>${escapeXml(description)}</description>`,
    `  <lastBuildDate>${generatedAt}</lastBuildDate>`,
    itemXml,
    "</channel>",
    "</rss>",
  ].join("\n");
}

function renderHomePage(origin: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Wiki RSS</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: #ffffff;
        color: #000000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }

      @media (prefers-color-scheme: dark) {
        body {
          background: #000000;
          color: #ffffff;
        }
      }

      main {
        width: min(640px, 100%);
      }

      h1 {
        margin: 0 0 12px;
      }

      .controls {
        display: flex;
        flex-wrap: nowrap;
        gap: 10px;
        align-items: center;
        margin-bottom: 14px;
      }

      input[type="number"] {
        width: 96px;
        padding: 6px 8px;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
        font: inherit;
      }

      .feed-row {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      button {
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
        padding: 6px 10px;
        font: inherit;
        cursor: pointer;
      }

      code {
        padding: 8px;
        border: 1px solid currentColor;
        white-space: nowrap;
        overflow-x: auto;
      }

      .error {
        margin-top: 8px;
        min-height: 1.25rem;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Wikipedia RSS</h1>

      <div class="controls">
        <label for="cadence">Receive an article every</label>
        <input id="cadence" type="number" min="1" max="7" step="1" value="1" />
        <span>days (max 7)</span>
      </div>

      <div class="feed-row">
        <code id="feed-url">${origin}/feed/1.xml</code>
        <button id="copy-btn" type="button">Copy Feed URL</button>
      </div>
      <div class="error" id="error"></div>
    </main>

    <script>
      const input = document.getElementById("cadence");
      const code = document.getElementById("feed-url");
      const copyBtn = document.getElementById("copy-btn");
      const error = document.getElementById("error");

      function normalizeCadence(value) {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 7) {
          return null;
        }
        return parsed;
      }

      function updateUrl() {
        const cadence = normalizeCadence(input.value);
        if (cadence === null) {
          error.textContent = "x must be an integer from 1 to 7.";
          return null;
        }
        error.textContent = "";
        const url = window.location.origin + "/feed/" + cadence + ".xml";
        code.textContent = url;
        return url;
      }

      input.addEventListener("input", updateUrl);
      copyBtn.addEventListener("click", async () => {
        const url = updateUrl();
        if (!url) return;
        await navigator.clipboard.writeText(url);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy Feed URL"), 1100);
      });
    </script>
  </body>
</html>`;
}
