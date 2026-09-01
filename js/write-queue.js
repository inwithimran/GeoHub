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

/** Wraps an IDBRequest in a Promise. */
function requested(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Queue a write. `payload` can include Blob/File values (e.g. images picked
 *  before going offline) — IndexedDB structured-clones those directly, no
 *  base64 round-trip needed. Returns the queued entry's id. */
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

/** How many writes are currently queued (e.g. for a small "1 post pending" badge, if ever wanted). */
export async function countPendingWrites() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return requested(tx.objectStore(STORE).count());
}

// kind -> async (payload) => void. Should throw on failure — a thrown
// network-shaped error (see isNetworkError) is treated as "still offline,
// try again later"; any other thrown error is treated as unrecoverable and
// the write is dropped (with a console.error) rather than retried forever.
const handlers = new Map();

/** Register the function that actually performs a queued write of this kind. Call once at module load (see js/wall.js). */
export function registerWriteHandler(kind, handler) {
  handlers.set(kind, handler);
}

/** Best-effort classification of "this failed because the network is down/
 *  unreachable" vs. a real server answer (validation error, auth error,
 *  etc.) — only the former is safe to silently retry later. */
export function isNetworkError(err) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!err) return false;
  if (err.name === "TypeError") return true; // fetch()'s own signal for "the request never reached the network"
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("failed to fetch") || msg.includes("network") || msg.includes("load failed");
}

let syncing = false;
let resyncRequested = false;

/** Drain the queue in order (oldest first). Safe to call anytime — it's a
 *  no-op re-entrantly (a call while already syncing just requests another
 *  pass once the current one finishes, so a write queued mid-drain doesn't
 *  have to wait for the next 'online' event). */
export async function syncPendingWrites() {
  if (syncing) { resyncRequested = true; return; }
  syncing = true;
  try {
    do {
      resyncRequested = false;
      const writes = await getAllWrites();
      for (const w of writes) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) return; // went back offline mid-drain — stop, the next 'online' event resumes
        const handler = handlers.get(w.kind);
        if (!handler) { await removeWrite(w.id); continue; } // no handler registered for this kind — shouldn't happen, but don't jam the queue on it forever
        try {
          await handler(w.payload);
          await removeWrite(w.id);
        } catch (err) {
          if (isNetworkError(err)) return; // still offline / flaky — leave it queued, stop for now
          await removeWrite(w.id); // a real, non-network failure (e.g. rejected by the server) — drop it so it doesn't block everything queued after it
          console.error(`geohub write-queue: dropped a queued "${w.kind}" write after a non-network failure`, err);
        }
      }
    } while (resyncRequested);
  } finally {
    syncing = false;
  }
}

let wired = false;

/** Call once per login (after auth is established — a queued write's
 *  handler needs a signed-in user to get an ID token from). Wires
 *  automatic draining on reconnect and makes one attempt right away, in
 *  case the queue already has writes left over from before a reload. */
export function initWriteQueueSync() {
  if (wired) return;
  wired = true;
  window.addEventListener("online", syncPendingWrites);
  syncPendingWrites();
}
