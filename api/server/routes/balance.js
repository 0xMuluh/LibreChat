const express = require('express');
const { createSetBalanceConfig } = require('@librechat/api');
const router = express.Router();
const controller = require('../controllers/Balance');
const impactsController = require('../controllers/Impacts');
const { requireJwtAuth } = require('../middleware/');
const { findBalanceByUser, upsertBalanceFields } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

const setBalanceConfig = createSetBalanceConfig({
  getAppConfig,
  findBalanceByUser,
  upsertBalanceFields,
});

router.get('/', requireJwtAuth, setBalanceConfig, controller);
router.get('/impacts', requireJwtAuth, impactsController);

module.exports = router;
