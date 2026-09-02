import { DISPOSABLE_EMAIL_DOMAINS as STATIC_DOMAINS } from "../../shared/blocked-email-domains.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { set: null, fetchedAt: 0 };

async function loadDomainSet(db) {
  const merged = new Set(STATIC_DOMAINS);
  try {
    const snap = await db.collection("config").doc("disposableEmailDomains").get();
    if (snap.exists) {
      const list = snap.data().domains || [];
      for (const domain of list) {
        if (typeof domain === "string" && domain) merged.add(domain.toLowerCase().trim());
      }
    }
  } catch (err) {
    console.error("disposable-domains: Firestore lookup failed, using static list only.", err);
  }
  return merged;
}

async function getDomainSet(db) {
  const now = Date.now();
  if (cache.set && now - cache.fetchedAt < CACHE_TTL_MS) return cache.set;
  cache = { set: await loadDomainSet(db), fetchedAt: now };
  return cache.set;
}

export async function isDisposableEmailAsync(email, db) {
  const domain = typeof email === "string" ? email.split("@")[1] : "";
  if (!domain) return false;
  const normalized = domain.toLowerCase().trim();
  const set = await getDomainSet(db);
  if (set.has(normalized)) return true;
  for (const blocked of set) {
    if (normalized.endsWith(`.${blocked}`)) return true;
  }
  return false;
}
