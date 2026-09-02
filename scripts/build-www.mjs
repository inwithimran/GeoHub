import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT_DIR = "www";

const ITEMS = [
  "index.html",
  "js",
  "icons",
  "shared",
  "manifest.json",
  "favicon.ico",
  "firebase-messaging-sw.js"
];

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  for (const item of ITEMS) {
    if (!existsSync(item)) continue;
    await cp(item, `${OUT_DIR}/${item}`, { recursive: true });
  }
}

main();
