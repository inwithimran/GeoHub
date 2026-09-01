// ============================================================
// REALTIME-RETRY.JS — a drop-in replacement for Firestore's
// onSnapshot() that adds exponential backoff retry on error.
//
// WHY: onSnapshot's error callback isn't a transient "hiccup"
// notice — once it fires, the SDK has already torn the listener
// down, and nothing resubscribes on its own (unlike a plain dropped
// connection, which the SDK's internal transport reconnects from
// automatically without ever reaching the error callback). Every
// onSnapshot() error handler in this app used to just show a toast
// and leave that section of the UI frozen — dead — until the user
// manually reloaded the page.
//
// This wraps that: on error, it still calls the error callback (so
// existing toasts/fallback UI keep working exactly as before), then
// schedules a resubscribe after a delay that doubles each consecutive
// failure (capped, with jitter so many listeners don't all retry in
// the same instant) — and resets back to the short delay the moment a
// snapshot comes through healthy. It also listens for the browser's
// `online` event and retries immediately on reconnect instead of
// waiting out whatever delay is currently in flight, so listeners come
// back the moment the connection does rather than up to MAX_DELAY_MS
// later.
//
// Usage is identical to onSnapshot(ref, onNext, onError) — same
// signature, and the return value is still a single function that
// tears everything down (including the retry timer and the 'online'
// listener), same as onSnapshot's own unsubscribe.
// ============================================================
import { onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

export function onSnapshotWithRetry(refOrQuery, onNext, onError, { baseDelayMs = BASE_DELAY_MS, maxDelayMs = MAX_DELAY_MS } = {}) {
  let unsub = null;
  let retryTimer = null;
  let attempt = 0;
  let disposed = false;

  function scheduleRetry() {
    if (disposed) return;
    const cappedDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    attempt++;
    retryTimer = setTimeout(start, Math.random() * cappedDelay);
  }

  function start() {
    if (disposed) return;
    retryTimer = null;
    if (unsub) { unsub(); unsub = null; }
    unsub = onSnapshot(refOrQuery, (snap) => {
      attempt = 0;
      onNext(snap);
    }, (err) => {
      if (onError) onError(err);
      scheduleRetry();
    });
  }

  function onReconnect() {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    attempt = 0;
    start();
  }
  window.addEventListener("online", onReconnect);

  start();

  return function dispose() {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (unsub) unsub();
    window.removeEventListener("online", onReconnect);
  };
}
