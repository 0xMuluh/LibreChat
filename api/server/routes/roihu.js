const express = require('express');
const { createRoihuHandlers, roihuConfig } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');

/** Reports on Roihu: the signed-in user's own Reports session as a Slurm job on CSC's Roihu. */
const router = express.Router();
const handlers = createRoihuHandlers({ config: () => roihuConfig(), fetch });
router.use(requireJwtAuth);
router.get('/session', handlers.getSession);
router.post('/session', handlers.launchSession);
router.post('/session/open', handlers.openSession);
router.delete('/session', handlers.stopSession);

module.exports = router;
