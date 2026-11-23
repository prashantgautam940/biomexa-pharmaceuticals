// Small in-memory cache for patient report PDFs. A report is built once (when it is sent on
// WhatsApp, or on the first open) and then served instantly for viewing and downloading.
// Entries expire after a few hours so later opens show fresh data.
const TTL_MS = 6 * 3600 * 1000;
const MAX = 80;
const store = new Map(); // key -> { at, buf } | { at, pending: Promise }

function getPdf(key, build) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.buf ? Promise.resolve(hit.buf) : hit.pending;
  const t0 = Date.now();
  const pending = Promise.resolve().then(build).then(buf => {
    store.set(key, { at: Date.now(), buf });
    console.log(`📄 Report PDF built in ${Date.now() - t0} ms (${Math.round(buf.length / 1024)} KB)`);
    while (store.size > MAX) store.delete(store.keys().next().value);
    return buf;
  }, err => { store.delete(key); throw err; });
  store.set(key, { at: Date.now(), pending });
  return pending;
}
// Build it ahead of time (e.g. right after the WhatsApp message goes out).
function warm(key, build) { getPdf(key, build).catch(() => {}); }
function drop(key) { store.delete(key); }

module.exports = { getPdf, warm, drop };
