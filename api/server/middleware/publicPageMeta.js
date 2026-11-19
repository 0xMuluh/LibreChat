/**
 * OmicsBase: page tags for public pages.
 *
 * Every response carries `X-Robots-Tag: noindex` (middleware/noIndex.js) and the same
 * HTML shell. For the front page and for publicly shared notes on the canonical host,
 * this drops the noindex header and writes the page's own title, description, canonical
 * URL and preview (Open Graph / Twitter) tags into the shell. A public note also gets a
 * plain HTML copy of its questions, explanations, R code, output and plots inside the
 * React root, for crawlers that do not run JavaScript; React replaces it on first render.
 *
 * Share data comes from this server's own share and notes APIs, requested without
 * credentials, so a page can only show what an anonymous visitor could already read.
 */
const { escapeHtmlAttribute } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const SITE_NAME = 'OmicsBase';
const SITE_DESCRIPTION =
  'The open-source AI workspace for biological data analysis in R and Bioconductor.';
const SITE_TITLE = `${SITE_NAME}: the open-source AI workspace for biological data analysis`;
/** The front page and the welcome page it opens for signed-out visitors share one canonical URL. */
const FRONT_PATHS = new Set(['/', '/welcome']);
/** Preview image for the front page, served from the client's public assets. */
const SITE_IMAGE = '/assets/og-image.png';
const SHARE_PATH = /^\/share\/([A-Za-z0-9_-]{6,64})\/?$/;
const PUBLIC_TTL_MS = 60 * 60 * 1000;
const NOT_PUBLIC_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 400;
const FETCH_TIMEOUT_MS = 2500;
/** Size limits for the readable copy of a note: per cell output, and the whole article. */
const OUTPUT_MAX = 1500;
const ARTICLE_MAX = 100000;

const internalBase = `http://127.0.0.1:${Number(process.env.PORT) || 3080}`;
const canonicalOrigin = (() => {
  try {
    return new URL(process.env.DOMAIN_CLIENT).origin;
  } catch {
    return null;
  }
})();

/** shareId -> { expires, meta | null } */
const cache = new Map();

const esc = (value) => escapeHtmlAttribute(String(value));

/** Plain-text summary of a message: markdown and code removed, cut at a word boundary. */
function summarize(text, max = 160) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    /* Underscores stay: they are part of dataset and function names. */
    .replace(/[`*>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) {
    return plain;
  }
  const cut = plain.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2))}…`;
}

/** Minimal markdown to HTML: fenced code, headings, list items and paragraphs, all escaped. */
function markdownToHtml(text) {
  const out = [];
  const chunks = String(text || '').split(/```[^\n]*\n?/);
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      if (chunk.trim()) {
        out.push(`<pre><code>${esc(chunk.replace(/\n$/, ''))}</code></pre>`);
      }
      return;
    }
    const prose = chunk
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    for (const block of prose.split(/\n\s*\n/)) {
      const lines = block
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) {
        continue;
      }
      const clean = (l) => esc(l.replace(/\*\*|__|`/g, ''));
      if (lines.every((l) => /^([-*]|\d+\.)\s+/.test(l))) {
        out.push(
          `<ul>${lines.map((l) => `<li>${clean(l.replace(/^([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`,
        );
      } else if (lines.length === 1 && /^#{1,6}\s/.test(lines[0])) {
        out.push(`<h3>${clean(lines[0].replace(/^#+\s*/, ''))}</h3>`);
      } else {
        out.push(`<p>${lines.map(clean).join('<br>')}</p>`);
      }
    }
  });
  return out.join('\n');
}

/** The text output of an R cell tool call: markers, images and fences removed, shortened. */
function cellOutput(output) {
  const text = String(output || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\[cell_id:[^\]]*\]\s*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^```[^\n]*$/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}\n…` : text;
}

/** Readable HTML copy of a shared note, in message order. */
function renderArticle(share, plotsByCell) {
  const parts = [`<article class="omicsbase-note"><h1>${esc(share.title || SITE_NAME)}</h1>`];
  let size = parts[0].length;
  const push = (html) => {
    if (size < ARTICLE_MAX) {
      parts.push(html);
      size += html.length;
    }
  };
  for (const message of share.messages) {
    if (message.isCreatedByUser) {
      if (message.text) {
        const heading = summarize(message.text, 200);
        const full =
          heading === summarize(message.text, Infinity) ? '' : markdownToHtml(message.text);
        push(`<section><h2>${esc(heading)}</h2>${full}</section>`);
      }
      continue;
    }
    for (const part of message.content ?? []) {
      if (part?.type === 'text' && part.text) {
        push(markdownToHtml(part.text));
      } else if (part?.type === 'tool_call' && /execute_r_cell/.test(part.tool_call?.name ?? '')) {
        const { args } = part.tool_call;
        let code = typeof args === 'object' ? (args?.code ?? '') : '';
        if (typeof args === 'string') {
          try {
            code = JSON.parse(args).code ?? '';
          } catch {
            code = '';
          }
        }
        const output = cellOutput(part.tool_call.output);
        const cellId = /cellId=([a-f0-9]+)/.exec(part.tool_call.output ?? '')?.[1];
        const plots = (plotsByCell.get(cellId) ?? [])
          .map(
            (url, i) =>
              `<img src="${esc(url)}" alt="Plot ${i + 1} from this R cell" loading="lazy">`,
          )
          .join('');
        push(
          `<figure>${code ? `<pre><code class="language-r">${esc(code)}</code></pre>` : ''}` +
            `${output ? `<pre>${esc(output)}</pre>` : ''}${plots}</figure>`,
        );
      }
    }
  }
  if (size >= ARTICLE_MAX) {
    parts.push('<p>…</p>');
  }
  parts.push('</article>');
  return parts.join('\n');
}

async function getJson(path) {
  const res = await fetch(`${internalBase}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

/**
 * Title, description and first plot of a public share; null if it is not public.
 * Throws on rate limiting, timeouts and server errors, which are not cached.
 */
async function loadShareMeta(shareId) {
  const hit = cache.get(shareId);
  if (hit && hit.expires > Date.now()) {
    return hit.meta;
  }

  const id = encodeURIComponent(shareId);
  const { status, body: share } = await getJson(`/api/share/${id}`);
  if (status !== 200 && status !== 401 && status !== 404) {
    throw new Error(`share API answered ${status}`);
  }
  let meta = null;
  if (share && Array.isArray(share.messages)) {
    const question = share.messages.find((m) => m.isCreatedByUser && m.text);
    meta = {
      title: share.title || SITE_NAME,
      description: summarize(question?.text) || SITE_DESCRIPTION,
      modified: share.updatedAt,
      image: null,
    };
    const notes = (await getJson(`/api/notes/${id}/cells`).catch(() => null))?.body;
    const cells = [...(notes?.cells ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const plotsByCell = new Map();
    for (const cell of cells) {
      const plots = (cell.latestExecution?.artifacts ?? [])
        .filter((a) => a.artifactType === 'plot' && a.contentUrl)
        .map((a) => a.contentUrl);
      plotsByCell.set(cell.id, plots);
      meta.image = meta.image ?? plots[0] ?? null;
    }
    meta.article = renderArticle(share, plotsByCell);
  }

  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(shareId, { expires: Date.now() + (meta ? PUBLIC_TTL_MS : NOT_PUBLIC_TTL_MS), meta });
  return meta;
}

/** Layout for the readable copy while the app loads; React removes the copy on first render. */
const ARTICLE_STYLE =
  '<style>.omicsbase-note{max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.5;' +
  'font-family:system-ui,sans-serif}.omicsbase-note pre{white-space:pre-wrap;' +
  'overflow-wrap:anywhere;font-size:.85em}.omicsbase-note img{max-width:100%}</style>';

function renderTags({ title, description, url, image, type }) {
  const tags = [
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
  ];
  if (image) {
    tags.push(`<meta property="og:image" content="${esc(image)}" />`);
  }
  return tags.join('\n    ');
}

function withTags(html, page) {
  return html
    .replace(/<title>.*?<\/title>/, () => `<title>${esc(page.title)}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
      () => `<meta name="description" content="${esc(page.description)}" />`,
    )
    .replace('</head>', () => `    ${renderTags(page)}\n  </head>`);
}

/**
 * Returns the shell with page tags for public pages; any other page, host or failure
 * returns the shell unchanged and keeps the noindex header.
 */
async function applyPublicPageMeta(req, res, html) {
  if (
    !canonicalOrigin ||
    (req.method !== 'GET' && req.method !== 'HEAD') ||
    req.hostname !== new URL(canonicalOrigin).hostname
  ) {
    return html;
  }
  try {
    if (FRONT_PATHS.has(req.path)) {
      res.removeHeader('X-Robots-Tag');
      return withTags(html, {
        title: SITE_TITLE,
        description: SITE_DESCRIPTION,
        url: `${canonicalOrigin}/`,
        image: `${canonicalOrigin}${SITE_IMAGE}`,
        type: 'website',
      });
    }

    const match = SHARE_PATH.exec(req.path);
    if (!match) {
      return html;
    }
    const meta = await loadShareMeta(match[1]);
    if (!meta) {
      return html;
    }
    res.removeHeader('X-Robots-Tag');
    const withArticle = html
      .replace(
        '<div id="loading-container"></div>',
        () => `<div id="loading-container"></div>\n${meta.article}`,
      )
      .replace('</head>', () => `${ARTICLE_STYLE}\n  </head>`);
    return withTags(withArticle, {
      title: `${meta.title} | ${SITE_NAME}`,
      description: meta.description,
      url: `${canonicalOrigin}/share/${match[1]}`,
      image: meta.image ? `${canonicalOrigin}${meta.image}` : null,
      type: 'article',
    });
  } catch (err) {
    logger.warn('[publicPageMeta] page tags skipped', { path: req.path, error: err?.message });
    return html;
  }
}

module.exports = { applyPublicPageMeta, summarize };
