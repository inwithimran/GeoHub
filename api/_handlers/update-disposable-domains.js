import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const SOURCE_URL = "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf";

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) });
}

function parseDomainList(text) {
  const domains = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) domains.add(trimmed);
  }
  return [...domains];
}

export async function updateDisposableDomains(req, res) {
  if (!process.env.CRON_SECRET) {
    console.error("update-disposable-domains: CRON_SECRET is not set — refusing request.");
    return res.status(500).json({ error: "Server misconfiguration." });
  }
  const authHeader = req.headers.authorization || "";
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`Source list fetch failed with status ${response.status}`);
    const domains = parseDomainList(await response.text());
    if (domains.length < 500) throw new Error(`Fetched list looks too small (${domains.length} domains), refusing to overwrite cache.`);

    const app = getAdminApp();
    const db = getFirestore(app);
    await db.collection("config").doc("disposableEmailDomains").set({
      domains,
      count: domains.length,
      source: SOURCE_URL,
      updatedAt: Timestamp.now()
    });

    return res.status(200).json({ ok: true, count: domains.length });
  } catch (err) {
    console.error("update-disposable-domains error:", err);
    return res.status(500).json({ error: err.message || "Failed to update disposable domain list." });
  }
}
