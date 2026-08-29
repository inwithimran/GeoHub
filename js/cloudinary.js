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
