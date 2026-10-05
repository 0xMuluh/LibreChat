const crypto = require('crypto');
const uap = require('ua-parser-js');
const { ViolationTypes } = require('librechat-data-provider');
const { handleError } = require('@librechat/api');
const { logViolation } = require('../../cache');

/**
 * Middleware to parse User-Agent header and check if it's from a recognized browser.
 * If the User-Agent is not recognized as a browser, logs a violation and sends an error response.
 *
 * @function
 * @async
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {void} Sends an error response if the User-Agent is not recognized as a browser.
 *
 * @example
 * app.use(uaParser);
 */
/**
 * OmicsBase: the example-note recorder runs inside this container and is not a
 * browser. It is let through only while OMICSBASE_RECORDER_ENABLED is true, and only
 * for connections from this machine that carry the internal engine secret.
 */
function isRecorder(req) {
  const secret = process.env.OMICSBASE_AUTH_SECRET;
  const provided = req.headers['x-internal-secret'];
  if (
    process.env.OMICSBASE_RECORDER_ENABLED !== 'true' ||
    !secret ||
    typeof provided !== 'string'
  ) {
    return false;
  }
  const address = req.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function uaParser(req, res, next) {
  if (isRecorder(req)) {
    return next();
  }
  const { NON_BROWSER_VIOLATION_SCORE: score = 20 } = process.env;
  const ua = uap(req.headers['user-agent']);

  if (!ua.browser.name) {
    const type = ViolationTypes.NON_BROWSER;
    await logViolation(req, res, type, { type }, score);
    return handleError(res, { message: 'Illegal request' });
  }
  next();
}

module.exports = uaParser;
