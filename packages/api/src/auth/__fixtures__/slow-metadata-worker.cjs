const { existsSync } = require('node:fs');

/** Stands in for the metadata process: reports when it ran and whether it saw the XML file. */
process.once('message', ({ file }) => {
  const start = Date.now();
  setTimeout(() => {
    const message = JSON.stringify({ start, end: Date.now(), file, seen: existsSync(file) });
    process.send({ ok: false, error: { code: 'invalid_xml', message } }, () =>
      process.disconnect(),
    );
  }, 150);
});
