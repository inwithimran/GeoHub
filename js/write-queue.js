// ============================================================
// WRITE-QUEUE.JS — offline write queue for user actions that must
// reach the server (currently: creating a Wall post — see the
// "create-post" handler wired up in js/wall.js).
//
// IndexedDB, not localStorage: a queued post can carry image
// files, and localStorage only holds strings under a small (~5MB
// combined) quota — IndexedDB stores Blobs/Files directly and
// scales far past that.
//
// Flow:
//   1. A write that fails because the network is unreachable (see
//      isNetworkError below) gets handed to enqueueWrite() instead
//      of surfacing an error the user can't do anything about.
//   2. initWriteQueueSync() (called once per login, from app.js)
//      wires a `window.addEventListener("online", ...)` and also
//      makes one attempt immediately on startup, in case writes
//      were queued last session and we're already back online by
//      the time the app reloads.
//   3. syncPendingWrites() drains the queue in order, oldest first,
//      via whatever handler was registered for that write's `kind`
//      (registerWriteHandler). The moment it hits another network
//      failure it stops and waits for the next reconnect — it does
//      NOT drop the remaining queue, so nothing is lost by a second
//      dropped connection mid-sync.
// ============================================================

const DB_NAME = "geohub-offline";
const DB_VERSION = 1;
const STORE = "pendingWrites";

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function requested(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueWrite(kind, payload) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const id = await requested(tx.objectStore(STORE).add({ kind, payload, queuedAt: Date.now() }));
  return id;
}

async function getAllWrites() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return requested(tx.objectStore(STORE).getAll());
}

async function removeWrite(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  await requested(tx.objectStore(STORE).delete(id));
}

export async function countPendingWrites() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return requested(tx.objectStore(STORE).count());
}

const handlers = new Map();

export function registerWriteHandler(kind, handler) {
  handlers.set(kind, handler);
}

export function isNetworkError(err) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!err) return false;
  if (err.name === "TypeError") return true;
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("failed to fetch") || msg.includes("network") || msg.includes("load failed");
}

let syncing = false;
let resyncRequested = false;

export async function syncPendingWrites() {
  if (syncing) { resyncRequested = true; return; }
  syncing = true;
  try {
    do {
      resyncRequested = false;
      const writes = await getAllWrites();
      for (const w of writes) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) return;
        const handler = handlers.get(w.kind);
        if (!handler) { await removeWrite(w.id); continue; }
        try {
          await handler(w.payload);
          await removeWrite(w.id);
        } catch (err) {
          if (isNetworkError(err)) return;
          await removeWrite(w.id);
          console.error(`geohub write-queue: dropped a queued "${w.kind}" write after a non-network failure`, err);
        }
      }
    } while (resyncRequested);
  } finally {
    syncing = false;
  }
}

let wired = false;

export function initWriteQueueSync() {
  if (wired) return;
  wired = true;
  window.addEventListener("online", syncPendingWrites);
  syncPendingWrites();
}
