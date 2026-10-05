/**
 * OmicsBase: a repeatable shuffle. The same seed gives the same order, so a
 * visitor can page through a random order without repeats; a new seed (a new
 * visit, or the next day) gives a new order.
 */

/** Small seeded generator (mulberry32). */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from the request, or one that changes daily. */
function resolveSeed(seed) {
  const n = Number.parseInt(seed, 10);
  return Number.isFinite(n) ? n : Math.floor(Date.now() / 86_400_000);
}

function shuffle(items, seed) {
  const random = seededRandom(resolveSeed(seed));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { shuffle, resolveSeed };
