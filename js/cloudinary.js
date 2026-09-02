const CLOUD_NAME = "s9htrtz2";
const UPLOAD_PRESET = "GeoHub";
const UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;

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

export async function uploadImage(file, { maxDim = 1600, quality = 0.8, folder } = {}) {
  const compressed = await compressImage(file, { maxDim, quality });
  const form = new FormData();
  form.append("file", compressed, file.name || "upload.jpg");
  form.append("upload_preset", UPLOAD_PRESET);
  if (folder) form.append("folder", folder);

  const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
  if (!res.ok) {
    let msg = "Upload failed.";
    try { msg = (await res.json())?.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return data.secure_url;
}

export async function uploadImages(files, opts = {}) {
  return Promise.all(Array.from(files).map((f) => uploadImage(f, opts)));
}

const RAW_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/raw/upload`;

export async function uploadRawFile(file, { folder } = {}) {
  const form = new FormData();
  form.append("file", file, file.name || "upload");
  form.append("upload_preset", UPLOAD_PRESET);
  form.append("use_filename", "true");
  form.append("unique_filename", "true");
  if (folder) form.append("folder", folder);

  const res = await fetch(RAW_UPLOAD_URL, { method: "POST", body: form });
  if (!res.ok) {
    let msg = "Upload failed.";
    try { msg = (await res.json())?.error?.message || msg; } catch {  }
    throw new Error(msg);
  }
  const data = await res.json();
  return data.secure_url;
}
