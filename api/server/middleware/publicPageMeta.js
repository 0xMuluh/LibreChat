/**
 * OmicsBase: page tags for public pages.
 *
 * Every response carries `X-Robots-Tag: noindex` (middleware/noIndex.js) and the same
 * HTML shell. For the front page and for publicly shared notes on the canonical host,
 * this drops the noindex header and writes the page's own title, description, canonical
 * URL and preview (Open Graph / Twitter) tags into the shell.
 *
 * Share data comes from this server's own share and notes APIs, requested without
 * credentials, so a page can only show what an anonymous visitor could already read.
 */
const { escapeHtmlAttribute } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const SITE_NAME = 'OmicsBase';
const SITE_DESCRIPTION =
  'Analyse microbiome, single-cell, spatial and mass spectrometry data in R with an AI assistant. ' +
  'Every note keeps its code, output and figures together.';
const SHARE_PATH = /^\/share\/([A-Za-z0-9_-]{6,64})\/?$/;
const PUBLIC_TTL_MS = 60 * 60 * 1000;
const NOT_PUBLIC_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 1000;
const FETCH_TIMEOUT_MS = 2500;

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
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) {
    return plain;
  }
  const cut = plain.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2))}…`;
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
    for (const cell of cells) {
      const plot = cell.latestExecution?.artifacts?.find((a) => a.artifactType === 'plot');
      if (plot?.contentUrl) {
        meta.image = plot.contentUrl;
        break;
      }
    }
  }

  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(shareId, { expires: Date.now() + (meta ? PUBLIC_TTL_MS : NOT_PUBLIC_TTL_MS), meta });
  return meta;
}

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
    if (req.path === '/') {
      res.removeHeader('X-Robots-Tag');
      return withTags(html, {
        title: `${SITE_NAME}: omics analysis in R with an AI assistant`,
        description: SITE_DESCRIPTION,
        url: `${canonicalOrigin}/`,
        image: null,
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
    return withTags(html, {
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
