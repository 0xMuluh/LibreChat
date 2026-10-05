/**
 * OmicsBase: open microbiome studies, listed straight from MGnify (EMBL-EBI) and
 * Zenodo so nothing has to be maintained by hand. MGnify sends no CORS headers
 * and Zenodo limits clients to 30 requests a minute, so both go through here,
 * with a short cache.
 */
const { logger } = require('@librechat/data-schemas');

const PAGE_SIZE = 12;
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 300;
/* Zenodo refuses requests that carry no User-Agent. */
const USER_AGENT = 'OmicsBase (+https://omicsbase.utu.fi)';

/** Biome filters: an MGnify lineage and the matching Zenodo search terms. */
const BIOMES = {
  all: { lineage: null, zenodo: '' },
  'human-gut': {
    lineage: 'root:Host-associated:Human:Digestive system',
    zenodo: '(gut OR fecal OR faecal OR stool)',
  },
  'human-oral': {
    lineage: 'root:Host-associated:Human:Digestive system:Oral',
    zenodo: '(oral OR saliva OR dental)',
  },
  'human-skin': { lineage: 'root:Host-associated:Human:Skin', zenodo: 'skin' },
  'animal-gut': {
    lineage: 'root:Host-associated:Mammals:Digestive system',
    zenodo: '(mouse OR murine OR pig OR cattle OR chicken) AND (gut OR fecal OR faecal)',
  },
  soil: { lineage: 'root:Environmental:Terrestrial:Soil', zenodo: 'soil' },
  marine: { lineage: 'root:Environmental:Aquatic:Marine', zenodo: '(marine OR ocean OR seawater)' },
};

const ZENODO_BASE =
  '(microbiome OR microbiota) AND ("OTU table" OR "ASV table" OR "abundance table" OR biom OR "feature table")';

const cache = new Map();

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      const error = new Error(`Upstream returned ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const biomeLabel = (id = '') =>
  id
    .split(':')
    .slice(1)
    .filter((part) => !['Host-associated', 'Environmental', 'Engineered', 'Mixed'].includes(part))
    .slice(-2)
    .join(' · ');

async function mgnifyStudies({ biome, q, page }) {
  const params = new URLSearchParams({
    ordering: '-samples_count',
    page_size: String(PAGE_SIZE),
    page: String(page),
  });
  if (BIOMES[biome].lineage) {
    params.set('lineage', BIOMES[biome].lineage);
  }
  if (q) {
    params.set('search', q);
  }
  const body = await getJson(`https://www.ebi.ac.uk/metagenomics/api/v1/studies?${params}`);
  return {
    count: body.meta?.pagination?.count ?? 0,
    hasNext: Boolean(body.links?.next),
    results: (body.data ?? []).map((study) => {
      const attributes = study.attributes ?? {};
      const biomeId = study.relationships?.biomes?.data?.[0]?.id;
      return {
        source: 'MGnify',
        accession: study.id,
        name: attributes['study-name'] ?? study.id,
        samples: attributes['samples-count'] ?? 0,
        biome: biomeLabel(biomeId),
        url: `https://www.ebi.ac.uk/metagenomics/studies/${encodeURIComponent(study.id)}`,
      };
    }),
  };
}

async function zenodoRecords({ biome, q, page }) {
  const words = q.replace(/[^\w\s-]/g, ' ').trim();
  const query = [ZENODO_BASE, BIOMES[biome].zenodo, words && `(${words})`]
    .filter(Boolean)
    .join(' AND ');
  const params = new URLSearchParams({
    q: query,
    type: 'dataset',
    size: String(PAGE_SIZE),
    page: String(page),
    sort: words ? 'bestmatch' : 'mostviewed',
  });
  const body = await getJson(`https://zenodo.org/api/records?${params}`);
  return {
    count: body.hits?.total ?? 0,
    hasNext: Boolean(body.links?.next),
    results: (body.hits?.hits ?? []).map((record) => ({
      source: 'Zenodo',
      accession: `zenodo.${record.id}`,
      id: String(record.id),
      name: record.metadata?.title ?? `Zenodo record ${record.id}`,
      year: (record.metadata?.publication_date ?? '').slice(0, 4),
      license: record.metadata?.license?.id ? String(record.metadata.license.id).toUpperCase() : '',
      files: (record.files ?? []).length,
      url: record.links?.self_html ?? `https://zenodo.org/records/${record.id}`,
    })),
  };
}

/**
 * One page of open studies. Returns `{ count, hasNext, results }`, or throws
 * with `status` set when the source is unreachable or rate-limits us.
 */
async function listStudies({ source = 'mgnify', biome = 'all', q = '', page = 1 } = {}) {
  const key = {
    source: source === 'zenodo' ? 'zenodo' : 'mgnify',
    biome: BIOMES[biome] ? biome : 'all',
    q: String(q).trim().slice(0, 100),
    page: Math.min(Math.max(Number(page) || 1, 1), 100),
  };
  const cacheKey = JSON.stringify(key);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value;
  }

  const value = key.source === 'zenodo' ? await zenodoRecords(key) : await mgnifyStudies(key);
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(cacheKey, { at: Date.now(), value });
  logger.debug(`[discover] ${key.source} studies page ${key.page}: ${value.results.length}`);
  return value;
}

module.exports = { listStudies, BIOMES };
