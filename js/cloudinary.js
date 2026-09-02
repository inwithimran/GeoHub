import { callApi } from "./api-client.js";

async function getSignature(folder) {
  // Every upload requires a fresh, short-lived, server-issued signature —
  // tied to a signed-in user and a whitelisted folder — so the Cloudinary
  // preset can no longer be used anonymously from outside the app.
  return callApi("sign-upload", { folder }, { skipClientCooldown: true });
}

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
      resolve(file);
    };
    img.src = objectUrl;
  });
}

async function uploadSigned(file, filename, sig, uploadUrl, extraFields = {}) {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("api_key", sig.apiKey);
  form.append("timestamp", sig.timestamp);
  form.append("signature", sig.signature);
  form.append("upload_preset", sig.uploadPreset);
  form.append("folder", sig.folder);
  for (const [k, v] of Object.entries(extraFields)) form.append(k, v);

  const res = await fetch(uploadUrl, { method: "POST", body: form });
  if (!res.ok) {
    let msg = "Upload failed.";
    try { msg = (await res.json())?.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return data.secure_url;
}

export async function uploadImage(file, { maxDim = 1600, quality = 0.8, folder } = {}) {
  const [compressed, sig] = await Promise.all([
    compressImage(file, { maxDim, quality }),
    getSignature(folder)
  ]);
  const uploadUrl = `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`;
  return uploadSigned(compressed, file.name || "upload.jpg", sig, uploadUrl);
}

export async function uploadImages(files, opts = {}) {
  // One signature covers the whole batch (Cloudinary signatures aren't
  // per-file), so we avoid hammering the sign-upload rate limit when a post
  // has several attached photos.
  const { maxDim = 1600, quality = 0.8, folder } = opts;
  const fileList = Array.from(files);
  const sig = await getSignature(folder);
  const uploadUrl = `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`;
  return Promise.all(fileList.map(async (f) => {
    const compressed = await compressImage(f, { maxDim, quality });
    return uploadSigned(compressed, f.name || "upload.jpg", sig, uploadUrl);
  }));
}

export async function uploadRawFile(file, { folder } = {}) {
  const sig = await getSignature(folder);
  const uploadUrl = `https://api.cloudinary.com/v1_1/${sig.cloudName}/raw/upload`;
  return uploadSigned(file, file.name || "upload", sig, uploadUrl, {
    use_filename: "true",
    unique_filename: "true"
  });
}
