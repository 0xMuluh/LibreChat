const fs = require('fs');
const { Readable } = require('stream');

const ENGINE_URL = (
  process.env.NOTEKERNEL_URL ||
  process.env.ENGINE_URL ||
  'http://engine:8001'
).replace(/\/$/, '');
const INTERNAL_SECRET =
  process.env.OMICSBASE_ENGINE_SECRET ||
  process.env.OMICSBASE_AUTH_SECRET ||
  process.env.JWT_SECRET ||
  '';

function engineHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SECRET) {
    headers['X-Internal-Secret'] = INTERNAL_SECRET;
  }
  return headers;
}

/** One engine request may not hang the polling loop, whose safety stop runs between requests. */
const REQUEST_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 5000;

/** The engine's host for messages and logs: no path, no credentials. */
const ENGINE_HOST = (() => {
  try {
    return new URL(ENGINE_URL).host;
  } catch {
    return 'the address in ENGINE_URL';
  }
})();

const CONNECTION_ERROR =
  /^(ECONN|ENOTFOUND|EAI_|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_|ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

/** True when the request never got an answer: refused, unknown name, timeout or TLS failure. */
function isConnectionError(err) {
  const code = err?.cause?.code || err?.code;
  if (typeof code === 'string' && CONNECTION_ERROR.test(code)) {
    return true;
  }
  return (
    err?.name === 'TimeoutError' || (err?.name === 'TypeError' && err?.message === 'fetch failed')
  );
}

/** What a cell says when the engine cannot be reached; the technical reason stays in `cause`. */
function engineUnreachableError(cause) {
  const err = new Error(
    `Could not reach the notes engine at ${ENGINE_HOST}. Check that the server is running and that ENGINE_URL in ~/omicsbase/.env is right, then run the cell again.`,
    { cause },
  );
  err.code = 'ENGINE_UNREACHABLE';
  return err;
}

/** fetch to the engine; a connection failure is reported as the engine being unreachable. */
async function engineFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    throw isConnectionError(err) ? engineUnreachableError(err) : err;
  }
}

/**
 * Ask the engine's /health once. Resolves to null when it answers, otherwise to the
 * reason as text; never rejects.
 */
async function checkEngineHealth() {
  try {
    const response = await fetch(`${ENGINE_URL}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok ? null : `HTTP ${response.status} from /health`;
  } catch (err) {
    return err?.cause?.code || err?.cause?.message || err?.message || String(err);
  }
}

/**
 * Start a cell on the engine (server-side only). Returns at once with
 * `{execution_id, phase}`; the run is followed with getExecutionStatus.
 */
async function startExecution({ code, threadId, executionId, timeoutSeconds = 600 }) {
  const response = await engineFetch(`${ENGINE_URL}/api/execute`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({
      code,
      thread_id: threadId,
      execution_id: executionId,
      timeout_seconds: timeoutSeconds,
      wait: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Engine HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return await response.json();
}

/**
 * Status of a run: `{phase, phase_started_at, started_at, cancel_requested, output,
 * next_offset, done, result}`. Null when the engine does not know the run.
 */
async function getExecutionStatus({ threadId, executionId, offset = 0 }) {
  const query = new URLSearchParams({ thread_id: threadId, offset: String(offset) });
  const response = await engineFetch(
    `${ENGINE_URL}/api/executions/${encodeURIComponent(executionId)}?${query}`,
    { headers: engineHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Engine HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return await response.json();
}

/** Requests an artifact from the engine's static /projects mount. */
async function requestArtifact(threadId, relativePath) {
  const url = `${ENGINE_URL}/projects/${encodeURIComponent(threadId)}/${relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const headers = {};
  if (INTERNAL_SECRET) headers['X-Internal-Secret'] = INTERNAL_SECRET;
  const response = await fetch(url, { headers, redirect: 'error' });
  if (!response.ok) {
    const err = new Error(`Artifact fetch failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return response;
}

/**
 * Fetch artifact bytes from engine static /projects mount.
 */
async function fetchArtifactFromEngine(threadId, relativePath) {
  const response = await requestArtifact(threadId, relativePath);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

/** An artifact as a stream, so a large file is passed on without being held in memory. */
async function streamArtifactFromEngine(threadId, relativePath) {
  const response = await requestArtifact(threadId, relativePath);
  return {
    stream: Readable.fromWeb(response.body),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    // fetch decodes a compressed body, so the engine's length holds only for a plain one.
    contentLength: response.headers.get('content-encoding')
      ? null
      : response.headers.get('content-length'),
  };
}

function noteFileUrl(threadId, filename) {
  return `${ENGINE_URL}/api/projects/${encodeURIComponent(threadId)}/data/${encodeURIComponent(filename)}`;
}

async function noteHasDataFile(threadId, filename) {
  const response = await engineFetch(noteFileUrl(threadId, filename), {
    method: 'HEAD',
    headers: { 'X-Internal-Secret': INTERNAL_SECRET },
  });
  if (response.status === 200 || response.status === 404) {
    return response.status === 200;
  }
  throw new Error(`Engine HTTP ${response.status} checking ${filename}`);
}

/**
 * Upload a file into the note's data/ folder on the engine. A copy already there is kept.
 */
async function uploadNoteDataFile(threadId, filename, sourcePath) {
  const response = await engineFetch(noteFileUrl(threadId, filename), {
    method: 'PUT',
    headers: { 'X-Internal-Secret': INTERNAL_SECRET, 'Content-Type': 'application/octet-stream' },
    body: fs.createReadStream(sourcePath),
    duplex: 'half',
  });
  if (!response.ok) {
    throw new Error(`Engine HTTP ${response.status} uploading ${filename}`);
  }
  return response.json();
}

/**
 * Copy one note's files into another (conversation fork). The engine leaves out the
 * source's live session processes.
 */
/** Copy one note's files into another; without data, uploads and the saved R session stay behind. */
async function copyNoteFiles(sourceThreadId, targetThreadId, { includeData = true } = {}) {
  const response = await fetch(
    `${ENGINE_URL}/api/projects/${encodeURIComponent(targetThreadId)}/copy`,
    {
      method: 'POST',
      headers: { 'X-Internal-Secret': INTERNAL_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: sourceThreadId, include_data: includeData }),
    },
  );
  if (!response.ok) {
    throw new Error(`Engine HTTP ${response.status} copying note files`);
  }
  return response.json();
}

async function signalCancel(conversationId, executionId) {
  await fetch(`${ENGINE_URL}/api/cancel`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ thread_id: conversationId, execution_id: executionId }),
  });
}

module.exports = {
  signalCancel,
  copyNoteFiles,
  noteHasDataFile,
  uploadNoteDataFile,
  ENGINE_URL,
  ENGINE_HOST,
  checkEngineHealth,
  engineUnreachableError,
  startExecution,
  getExecutionStatus,
  fetchArtifactFromEngine,
  streamArtifactFromEngine,
};
