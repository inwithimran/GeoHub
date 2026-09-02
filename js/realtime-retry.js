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
