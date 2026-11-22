const { logger } = require('@librechat/data-schemas');
const { getImpactsTotals } = require('~/models');

/**
 * Energy estimate totals for the user: the whole account and, with a
 * `conversationId` query parameter, that note.
 */
async function impactsController(req, res) {
  const { conversationId } = req.query;
  const hasNote = typeof conversationId === 'string' && conversationId !== '';
  if (conversationId != null && !hasNote) {
    return res.status(400).json({ error: 'Invalid conversationId' });
  }

  try {
    const user = req.user.id;
    const [account, note] = await Promise.all([
      getImpactsTotals({ user }),
      hasNote ? getImpactsTotals({ user, conversationId }) : undefined,
    ]);
    res.status(200).json(note ? { account, note } : { account });
  } catch (error) {
    logger.error('[impactsController] Error reading impacts totals', error);
    res.status(500).json({ error: 'Error reading impacts totals' });
  }
}

module.exports = impactsController;
