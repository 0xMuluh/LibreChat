/** Stands in for a metadata process that dies before answering. */
process.once('message', () => {
  process.exit(3);
});
