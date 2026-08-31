// ============================================================
// MEDIA-PICKER.JS — shared "attach photos" UI for the post
// composer and Edit Post modal: a hidden multi-file <input>, and
// a single live grid that opens with a square image+ "add" tile
// (sized like a thumbnail, Instagram/Facebook-style) followed by
// every attached photo — already-uploaded ones (edit mode) and
// newly-picked ones side by side, each with its own remove (×)
// button. Selected File objects are tracked in memory per modal
// instance and only compressed + uploaded to Cloudinary at submit
// time (see wall.js). Also renders an already-uploaded post's
// image grid in the feed, and a simple full-screen tap-to-enlarge
// viewer for it.
// ============================================================
import { escapeHtml, showToast } from "./ui-utils.js";

// Guardrails applied before a picked file is ever handed to Cloudinary.
// This runs BEFORE compression (js/cloudinary.js resizes/re-encodes valid
// images), so it exists purely to reject the wrong kind of file early —
// e.g. someone renaming a video/PDF to look like an image, or a huge
// original photo straight off a phone camera that would otherwise sit in
// memory as a full-size <img> + <canvas> for no reason.
const MAX_RAW_FILE_BYTES = 15 * 1024 * 1024; // 15MB — generous for an unedited phone photo

/** True (and lets it through) if this File looks like a real, reasonably-sized image. Exported for the profile-photo picker in app.js. */
export function isAcceptableImageFile(file) {
  if (!file.type || !file.type.startsWith("image/")) {
    showToast(`"${file.name}" isn't an image — skipped.`);
    return false;
  }
  if (file.size > MAX_RAW_FILE_BYTES) {
    showToast(`"${file.name}" is too large (max 15MB) — skipped.`);
    return false;
  }
  return true;
}

const addTileIcon = `
  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-4.6-4.6a2 2 0 0 0-2.8 0L5 20"/></svg>
  <span class="media-picker-add-plus">
    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  </span>`;

const removeIcon = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;

/** Markup for the hidden file input + the (initially empty, JS-rendered) photo grid. `inputId` must be unique per modal instance. */
export function imagePickerHtml(inputId) {
  return `
    <div class="media-picker" data-picker="${inputId}">
      <input type="file" id="${inputId}" accept="image/*" multiple class="hidden" />
      <div class="media-picker-grid" data-picker-grid="${inputId}"></div>
    </div>`;
}

/**
 * Wires the file input + live add-tile/thumbnail grid for a picker created
 * with imagePickerHtml(). Pass `existingImages` (already-uploaded URLs) when
 * wiring an Edit Post modal — they render as removable thumbnails right
 * alongside newly-picked files, sharing one grid and one max count.
 *
 * Returns { getRemainingUrls, getFiles } read at submit/save time:
 * getRemainingUrls() -> existing URLs the user didn't remove (edit mode only)
 * getFiles()         -> newly-picked File[] still to be uploaded
 */
export function wireImagePicker(root, inputId, { max = 6, existingImages = [] } = {}) {
  const input = root.querySelector(`#${inputId}`);
  const grid = root.querySelector(`[data-picker-grid="${inputId}"]`);
  let remaining = [...(existingImages || [])];
  let files = [];
  if (!input || !grid) return { getRemainingUrls: () => remaining, getFiles: () => files };

  const total = () => remaining.length + files.length;

  function renderGrid() {
    const full = total() >= max;
    grid.innerHTML = `
      <button type="button" class="media-picker-add${full ? " is-disabled" : ""}" data-picker-trigger aria-label="Add photos" ${full ? "disabled" : ""}>${addTileIcon}</button>
      ${remaining.map((url, i) => `
        <div class="media-thumb">
          <img src="${escapeHtml(url)}" alt="" />
          <button type="button" class="media-thumb-remove" data-remove-existing-idx="${i}" aria-label="Remove photo">${removeIcon}</button>
        </div>`).join("")}
      ${files.map((f, i) => `
        <div class="media-thumb">
          <img src="${URL.createObjectURL(f)}" alt="" />
          <button type="button" class="media-thumb-remove" data-remove-idx="${i}" aria-label="Remove photo">${removeIcon}</button>
        </div>`).join("")}`;

    grid.querySelector("[data-picker-trigger]")?.addEventListener("click", () => input.click());
    grid.querySelectorAll("[data-remove-existing-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        remaining.splice(Number(btn.dataset.removeExistingIdx), 1);
        renderGrid();
      });
    });
    grid.querySelectorAll("[data-remove-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        files.splice(Number(btn.dataset.removeIdx), 1);
        renderGrid();
      });
    });
  }
  renderGrid();

  input.addEventListener("change", () => {
    const picked = Array.from(input.files || []).filter(isAcceptableImageFile);
    const room = max - total();
    if (picked.length > room) showToast(`You can attach up to ${max} photos.`);
    files = [...files, ...picked.slice(0, Math.max(0, room))];
    input.value = "";
    renderGrid();
  });

  return { getRemainingUrls: () => remaining, getFiles: () => files };
}

/** Grid of a post's already-uploaded image URLs, shown in the feed card. Tap to view full-size. */
export function postImagesHtml(images = []) {
  if (!images || !images.length) return "";
  const countClass = images.length === 1 ? "one" : images.length === 2 ? "two" : images.length === 3 ? "three" : "many";
  return `
    <div class="post-image-grid ${countClass}">
      ${images.slice(0, 4).map((url, i) => `
        <button type="button" class="post-image-item" data-view-image="${escapeHtml(url)}" aria-label="View photo full size">
          <img src="${escapeHtml(url)}" alt="" loading="lazy" />
          ${i === 3 && images.length > 4 ? `<span class="post-image-more">+${images.length - 4}</span>` : ""}
        </button>`).join("")}
    </div>`;
}

// Single-photo posts show the photo at (a clamped version of) its own
// aspect ratio instead of always being force-cropped into a fixed box —
// these bounds keep an extreme portrait/landscape photo from blowing up
// the feed card too tall or too short, matching the cap most feeds use.
const SINGLE_IMAGE_MIN_RATIO = 0.66; // tallest allowed (portrait)
const SINGLE_IMAGE_MAX_RATIO = 1.91; // widest allowed (landscape)

/** Set each single-photo post's card to its real (clamped) aspect ratio once the image has loaded. Idempotent — safe to call on every re-render. */
export function applyPostImageRatios(root) {
  root.querySelectorAll(".post-image-grid.one .post-image-item").forEach(item => {
    if (item.dataset.ratioApplied) return;
    const img = item.querySelector("img");
    if (!img) return;
    const setRatio = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      item.dataset.ratioApplied = "1";
      const raw = img.naturalWidth / img.naturalHeight;
      const ratio = Math.min(SINGLE_IMAGE_MAX_RATIO, Math.max(SINGLE_IMAGE_MIN_RATIO, raw));
      item.style.aspectRatio = String(ratio);
    };
    if (img.complete) setRatio();
    else img.addEventListener("load", setRatio, { once: true });
  });
}

/** Wires tap-to-enlarge for every `[data-view-image]` under `root` (idempotent — safe to call on every re-render). */
export function wirePostImageViewer(root) {
  root.querySelectorAll("[data-view-image]").forEach(btn => {
    if (btn.dataset.wiredView) return;
    btn.dataset.wiredView = "1";
    btn.addEventListener("click", () => openImageViewer(btn.dataset.viewImage));
  });
}

/** Opens the same full-screen tap-to-enlarge viewer used for post photos — exported for the profile-photo "View Photo" action in app.js. */
export function openImageViewer(url) {
  const overlay = document.createElement("div");
  overlay.className = "image-viewer-overlay";
  overlay.innerHTML = `
    <button type="button" class="image-viewer-close" aria-label="Close">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
    </button>
    <img src="${escapeHtml(url)}" alt="" />`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target.closest(".image-viewer-close")) close(); });
}
