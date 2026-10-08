const fs = require('fs');

const ENGINE_URL = (
  process.env.NOTEKERNEL_URL ||
  process.env.ENGINE_URL ||
  'http://engine:8001'
).replace(/\/$/, '');
const INTERNAL_SECRET = process.env.OMICSBASE_AUTH_SECRET || process.env.JWT_SECRET || '';

/**
 * Call NoteKernel HTTP execute (server-side only).
 */
async function executeOnEngine({ code, threadId, executionId, timeoutSeconds = 180 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeoutSeconds + 30) * 1000);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (INTERNAL_SECRET) {
      headers['X-Internal-Secret'] = INTERNAL_SECRET;
    }

    const response = await fetch(`${ENGINE_URL}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code,
        thread_id: threadId,
        execution_id: executionId,
        timeout_seconds: timeoutSeconds,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Engine HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    return await response.json();
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('Cell execution timed out');
      timeoutErr.code = 'TIMED_OUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch artifact bytes from engine static /projects mount.
 */
async function fetchArtifactFromEngine(threadId, relativePath) {
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
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

function noteFileUrl(threadId, filename) {
  return `${ENGINE_URL}/api/projects/${encodeURIComponent(threadId)}/data/${encodeURIComponent(filename)}`;
}

async function noteHasDataFile(threadId, filename) {
  const response = await fetch(noteFileUrl(threadId, filename), {
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
  const response = await fetch(noteFileUrl(threadId, filename), {
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
async function copyNoteFiles(sourceThreadId, targetThreadId) {
  const response = await fetch(
    `${ENGINE_URL}/api/projects/${encodeURIComponent(targetThreadId)}/copy`,
    {
      method: 'POST',
      headers: { 'X-Internal-Secret': INTERNAL_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: sourceThreadId }),
    },
  );
  if (!response.ok) {
    throw new Error(`Engine HTTP ${response.status} copying note files`);
  }
  return response.json();
}

async function signalCancel(conversationId, executionId) {
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SECRET) headers['X-Internal-Secret'] = INTERNAL_SECRET;
  await fetch(`${ENGINE_URL}/api/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ thread_id: conversationId, execution_id: executionId }),
  });
}

module.exports = {
  signalCancel,
  copyNoteFiles,
  noteHasDataFile,
  uploadNoteDataFile,
  ENGINE_URL,
  INTERNAL_SECRET,
  executeOnEngine,
  fetchArtifactFromEngine,
};
