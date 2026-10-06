/**
 * OmicsBase: read-only data for the landing page and the Examples and Datasets
 * pages. Signed-out visitors can read it; nothing here needs or reveals a user.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { normalizeEndpointName } = require('librechat-data-provider');
const { excludeHiddenModelSpecs, loadCustomEndpointsConfig } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config/app');
const {
  datasets,
  shuffle,
  listExamples,
  listStudies,
  getExampleCover,
} = require('~/server/services/Discover');

const router = express.Router();

router.get('/examples', async (req, res) => {
  try {
    const { page, pageSize, field, mode, q, perField, seed } = req.query;
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await listExamples({ page, pageSize, field, mode, q, perField, seed }));
  } catch (error) {
    logger.error('[discover] Error listing examples:', error);
    res.status(500).json({ message: 'Error listing examples' });
  }
});

router.get('/examples/:shareId/cover', async (req, res) => {
  try {
    const cover = await getExampleCover(req.params.shareId);
    if (!cover) {
      return res.status(404).end();
    }
    res.set('Content-Type', cover.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(cover.buffer);
  } catch (error) {
    logger.error('[discover] Error reading a cover:', error);
    res.status(500).end();
  }
});

router.get('/datasets', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ items: shuffle(datasets, req.query.seed) });
});

/** Open microbiome studies from MGnify or Zenodo, one page at a time. */
router.get('/studies', async (req, res) => {
  try {
    const { source, biome, q, page } = req.query;
    res.set('Cache-Control', 'public, max-age=600');
    res.json(await listStudies({ source, biome, q, page }));
  } catch (error) {
    logger.warn(`[discover] Open studies unavailable: ${error.message}`);
    res.status(error.status === 429 ? 429 : 502).json({ message: 'Source unavailable' });
  }
});

/** The deployment's own footer, which the public startup config leaves out. */
router.get('/footer', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    customFooter: typeof process.env.CUSTOM_FOOTER === 'string' ? process.env.CUSTOM_FOOTER : null,
  });
});

/**
 * Model names for the picker, with what the signed-in picker uses to draw the
 * provider logo (endpoint, model, icon, provider). No keys or URLs.
 */
router.get('/models', async (req, res) => {
  try {
    const appConfig = await getAppConfig();
    const specs = excludeHiddenModelSpecs(appConfig?.modelSpecs)?.list ?? [];
    const custom = loadCustomEndpointsConfig(appConfig?.endpoints?.custom) ?? {};
    /* The landing may preselect a different model from the app's default, e.g. a free one. */
    const landingDefault = process.env.DISCOVER_DEFAULT_SPEC;
    const useLanding = specs.some((spec) => spec.name === landingDefault);
    res.json({
      items: specs.map((spec) => {
        const endpoint = spec.preset?.endpoint ?? null;
        const configured = endpoint ? custom[normalizeEndpointName(endpoint)] : undefined;
        return {
          name: spec.name,
          label: spec.label ?? spec.name,
          description: spec.description ?? '',
          default: useLanding ? spec.name === landingDefault : spec.default === true,
          endpoint,
          model: spec.preset?.model ?? null,
          iconURL: spec.iconURL ?? spec.preset?.iconURL ?? null,
          endpointIconURL: configured?.iconURL ?? null,
          providerId: configured?.providerId ?? null,
        };
      }),
    });
  } catch (error) {
    logger.error('[discover] Error listing models:', error);
    res.json({ items: [] });
  }
});

module.exports = router;
