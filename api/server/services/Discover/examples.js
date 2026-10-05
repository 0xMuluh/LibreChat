/**
 * OmicsBase: Examples are the publicly shared notes. A share becomes an example
 * as soon as it is public; the optional `discover_examples` collection adds the
 * card details a share does not carry (field, dataset, summary, cover plot) and
 * lets an example be hidden or pinned.
 */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { findPubliclyAccessibleResources } = require('~/server/services/PermissionService');
const { fetchArtifactFromEngine } = require('~/server/services/NoteCells/engineClient');

const METADATA_COLLECTION = 'discover_examples';
const MAX_PAGE_SIZE = 48;
const COVER_PATH = /^runs\/[\w-]+\/plots\/[\w.-]+\.(png|jpe?g|svg)$/;

const notExpired = () => ({ $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] });

async function loadMetadata(shareIds) {
  const db = mongoose.connection.db;
  if (!db || shareIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .collection(METADATA_COLLECTION)
    .find({ shareId: { $in: shareIds } })
    .toArray();
  return new Map(rows.map((row) => [row.shareId, row]));
}

/** All public, unexpired, not hidden shares as example cards, pinned ones first. */
async function listAllExamples() {
  const ids = await findPubliclyAccessibleResources({
    resourceType: ResourceType.SHARED_LINK,
    requiredPermissions: PermissionBits.VIEW,
  });
  if (!ids.length) {
    return [];
  }

  const SharedLink = mongoose.models.SharedLink;
  const shares = await SharedLink.find({ _id: { $in: ids }, ...notExpired() })
    .select('shareId title createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const metadata = await loadMetadata(shares.map((share) => share.shareId));
  return shares
    .map((share) => {
      const meta = metadata.get(share.shareId) ?? {};
      return {
        shareId: share.shareId,
        title: share.title || 'Untitled',
        summary: meta.summary ?? '',
        field: meta.field ?? '',
        dataset: meta.dataset ?? '',
        source: meta.source ?? '',
        prompt: meta.prompt ?? '',
        mode: meta.mode ?? 'notes',
        hasCover: typeof meta.cover === 'string' && COVER_PATH.test(meta.cover),
        order: typeof meta.order === 'number' ? meta.order : Number.MAX_SAFE_INTEGER,
        hidden: meta.hidden === true,
        createdAt: share.createdAt,
      };
    })
    .filter((example) => !example.hidden)
    .sort((a, b) => a.order - b.order);
}

/**
 * One page of examples, filtered by field, mode and a free-text query.
 * Filtering happens in memory: public examples are counted in hundreds.
 */
async function listExamples({ page = 1, pageSize = 12, field = '', mode = '', q = '' } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 12, 1), MAX_PAGE_SIZE);
  const query = String(q).trim().toLowerCase();

  const all = await listAllExamples();
  const filtered = all.filter(
    (example) =>
      (!field || example.field === field) &&
      (!mode || example.mode === mode) &&
      (!query ||
        [
          example.title,
          example.summary,
          example.field,
          example.dataset,
          example.source,
          example.prompt,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)),
  );

  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const start = (current - 1) * size;
  const items = filtered
    .slice(start, start + size)
    .map(({ order: _order, hidden: _hidden, ...example }) => example);

  const fields = [...new Set(all.map((example) => example.field).filter(Boolean))];
  return { items, total: filtered.length, page: current, pages, pageSize: size, fields };
}

/** The cover plot of a public example, read from the engine. Null if there is none. */
async function getExampleCover(shareId) {
  const ids = await findPubliclyAccessibleResources({
    resourceType: ResourceType.SHARED_LINK,
    requiredPermissions: PermissionBits.VIEW,
  });
  const SharedLink = mongoose.models.SharedLink;
  const share = await SharedLink.findOne({ shareId, _id: { $in: ids }, ...notExpired() })
    .select('conversationId')
    .lean();
  if (!share) {
    return null;
  }

  const meta = (await loadMetadata([shareId])).get(shareId);
  if (!meta || typeof meta.cover !== 'string' || !COVER_PATH.test(meta.cover)) {
    return null;
  }

  try {
    return await fetchArtifactFromEngine(share.conversationId, meta.cover);
  } catch (error) {
    logger.warn(`[discover] Cover not available for ${shareId}: ${error.message}`);
    return null;
  }
}

module.exports = { listExamples, getExampleCover, METADATA_COLLECTION };
