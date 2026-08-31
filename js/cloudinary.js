// ============================================================
// CLOUDINARY.JS — unsigned image uploads (profile photos + post
// photos), each compressed client-side (resized + re-encoded on
// a <canvas>) before it's sent, so uploads stay small and fast
// on a mobile connection without needing any server code.
// ============================================================

const CLOUD_NAME = "s9htrtz2";
const UPLOAD_PRESET = "GeoHub";
const UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;

/**
 * Resize (max dimension) + re-encode an image file to JPEG on a canvas.
 * Keeps aspect ratio, never upscales. Falls back to the original file if
 * anything about the compression step fails (e.g. an exotic format).
 */
export function compressImage(file, { maxDim = 1600, quality = 0.8 } = {}) {
  return new Promise((resolve) => {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      resolve(file);
      return;
    }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.round((height / width) * maxDim);
          width = maxDim;
        } else {
          width = Math.round((width / height) * maxDim);
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => resolve(blob || file),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file); // couldn't decode it client-side — let Cloudinary handle the original
    };
    img.src = objectUrl;
  });
}

/**
 * Compress + upload a single image file to Cloudinary (unsigned preset).
 * Returns the resulting secure_url.
 */
export async function uploadImage(file, { maxDim = 1600, quality = 0.8, folder } = {}) {
  const compressed = await compressImage(file, { maxDim, quality });
  const form = new FormData();
  form.append("file", compressed, file.name || "upload.jpg");
  form.append("upload_preset", UPLOAD_PRESET);
  if (folder) form.append("folder", folder);

  const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
  if (!res.ok) {
    let msg = "Upload failed.";
    try { msg = (await res.json())?.error?.message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  return data.secure_url;
}

/** Compress + upload several image files in parallel. Returns an array of secure_urls, same order as input. */
export async function uploadImages(files, opts = {}) {
  return Promise.all(Array.from(files).map((f) => uploadImage(f, opts)));
}

// ============================================================
// RAW FILE UPLOADS (PDFs, Word/Excel/PowerPoint docs, zips, …) — used
// by the Notes & Sheet Hub's "Upload a file" option (js/resources.js),
// so a student sharing a note doesn't have to go create a Google Drive
// link first.
//
// Deliberately posted to Cloudinary's /raw/upload endpoint (not
// /auto/upload) rather than letting Cloudinary auto-detect the resource
// type: Cloudinary auto-detects PDFs specifically as an "image" asset
// (for thumbnailing), and *delivering* an "image"-type PDF is blocked by
// default under Cloudinary's account-level PDF/ZIP delivery security
// setting unless that's manually turned on in the console — a trap for
// exactly this use case. Uploading explicitly as "raw" sidesteps that
// setting entirely: a raw asset is delivered as-is, no image pipeline
// involved, so a shared PDF opens for classmates with no extra
// Cloudinary console configuration required.
// ============================================================
const RAW_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/raw/upload`;

/**
 * Upload a single non-image file (PDF, .docx, .pptx, .xlsx, .zip, etc.)
 * to Cloudinary as a raw asset. Returns the resulting secure_url.
 */
export async function uploadRawFile(file, { folder } = {}) {
  const form = new FormData();
  form.append("file", file, file.name || "upload");
  form.append("upload_preset", UPLOAD_PRESET);
  // Keeps the original filename (with a uniqueness suffix) in the stored
  // asset instead of a random id, so the URL still ends in a sensible
  // name/extension when a classmate opens or downloads it.
  form.append("use_filename", "true");
  form.append("unique_filename", "true");
  if (folder) form.append("folder", folder);

  const res = await fetch(RAW_UPLOAD_URL, { method: "POST", body: form });
  if (!res.ok) {
    let msg = "Upload failed.";
    try { msg = (await res.json())?.error?.message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  return data.secure_url;
}
