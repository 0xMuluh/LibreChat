/**
 * OmicsBase: read-only data for the landing page and the Examples and Datasets
 * pages. Signed-out visitors can read it; nothing here needs or reveals a user.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { excludeHiddenModelSpecs } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config/app');
const { datasets, listExamples, getExampleCover, shuffle } = require('~/server/services/Discover');

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

/** The deployment's own footer, which the public startup config leaves out. */
router.get('/footer', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    customFooter: typeof process.env.CUSTOM_FOOTER === 'string' ? process.env.CUSTOM_FOOTER : null,
  });
});

/** Model names for the picker, without any endpoint or key details. */
router.get('/models', async (req, res) => {
  try {
    const appConfig = await getAppConfig();
    const specs = excludeHiddenModelSpecs(appConfig?.modelSpecs)?.list ?? [];
    res.json({
      items: specs.map((spec) => ({
        name: spec.name,
        label: spec.label ?? spec.name,
        description: spec.description ?? '',
        default: spec.default === true,
      })),
    });
  } catch (error) {
    logger.error('[discover] Error listing models:', error);
    res.json({ items: [] });
  }
});

module.exports = router;
