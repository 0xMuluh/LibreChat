const express = require('express');
const { createRoihuHandlers, roihuConfig } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');

/**
 * The signed-in user's own Reports session: a Slurm job on CSC's Roihu, or a machine of their
 * own attached with a one-time pairing code.
 */
const router = express.Router();
const handlers = createRoihuHandlers({ config: () => roihuConfig(), fetch });
// An attached machine has no login; its one-time pairing code is the credential.
router.post('/attach/claim', handlers.claimPairing);
router.use(requireJwtAuth);
router.get('/session', handlers.getSession);
router.post('/session', handlers.launchSession);
router.post('/session/open', handlers.openSession);
router.delete('/session', handlers.stopSession);
router.post('/attach', handlers.startPairing);

module.exports = router;
