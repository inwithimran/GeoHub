// ============================================================
// MEDIA-PICKER.JS — shared "attach photos" UI for the post
// composer and Edit Post modal: a hidden multi-file <input>, a
// trigger button, and a live thumbnail preview grid with a
// remove (×) button on each thumbnail. Selected File objects are
// tracked in memory per modal instance and only compressed +
// uploaded to Cloudinary at submit time (see wall.js). Also
// renders an already-uploaded post's image grid in the feed, and
// a simple full-screen tap-to-enlarge viewer for it.
// ============================================================
import { escapeHtml, showToast } from "./ui-utils.js";

/** Markup for the "Add Photos" trigger + empty preview strip. `inputId` must be unique per modal instance. */
export function imagePickerHtml(inputId, label = "Add Photos") {
  return `
    <div class="media-picker" data-picker="${inputId}">
      <input type="file" id="${inputId}" accept="image/*" multiple class="hidden" />
      <button type="button" class="media-picker-btn" data-picker-trigger="${inputId}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>
        <span>${escapeHtml(label)}</span>
      </button>
      <div class="media-picker-grid" data-picker-grid="${inputId}"></div>
    </div>`;
}

/**
 * Wires the trigger + file input + live preview/remove for a picker created
 * with imagePickerHtml(). Returns getFiles() -> File[] currently selected,
 * called at submit time.
 */
export function wireImagePicker(root, inputId, { max = 6 } = {}) {
  const input = root.querySelector(`#${inputId}`);
  const trigger = root.querySelector(`[data-picker-trigger="${inputId}"]`);
  const grid = root.querySelector(`[data-picker-grid="${inputId}"]`);
  let files = [];
  if (!input || !trigger || !grid) return () => files;

  function renderGrid() {
    grid.innerHTML = files.map((f, i) => `
      <div class="media-thumb">
        <img src="${URL.createObjectURL(f)}" alt="" />
        <button type="button" class="media-thumb-remove" data-remove-idx="${i}" aria-label="Remove photo">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
        </button>
      </div>`).join("");
    grid.querySelectorAll("[data-remove-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        files.splice(Number(btn.dataset.removeIdx), 1);
        renderGrid();
      });
    });
  }

  trigger.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const picked = Array.from(input.files || []);
    const room = max - files.length;
    if (picked.length > room) showToast(`You can attach up to ${max} photos.`);
    files = [...files, ...picked.slice(0, Math.max(0, room))];
    input.value = "";
    renderGrid();
  });

  return () => files;
}

/** Grid of a post's already-uploaded image URLs, shown in the feed card. Tap to view full-size. */
export function postImagesHtml(images = []) {
  if (!images || !images.length) return "";
  const countClass = images.length === 1 ? "one" : images.length === 2 ? "two" : images.length === 3 ? "three" : "many";
  return `
    <div class="post-image-grid ${countClass}">
      ${images.slice(0, 4).map((url, i) => `
        <button type="button" class="post-image-item" data-view-image="${escapeHtml(url)}">
          <img src="${escapeHtml(url)}" alt="" loading="lazy" />
          ${i === 3 && images.length > 4 ? `<span class="post-image-more">+${images.length - 4}</span>` : ""}
        </button>`).join("")}
    </div>`;
}

/** Wires tap-to-enlarge for every `[data-view-image]` under `root` (idempotent — safe to call on every re-render). */
export function wirePostImageViewer(root) {
  root.querySelectorAll("[data-view-image]").forEach(btn => {
    if (btn.dataset.wiredView) return;
    btn.dataset.wiredView = "1";
    btn.addEventListener("click", () => openImageViewer(btn.dataset.viewImage));
  });
}

function openImageViewer(url) {
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

/**
 * Existing-images strip for Edit Post: shows already-uploaded photos with
 * remove buttons, plus its own "Add more" picker for brand-new files.
 * Returns { getRemainingUrls, getNewFiles } read at save time.
 */
export function wireEditImagePicker(root, inputId, existingImages = [], { max = 6 } = {}) {
  const grid = root.querySelector(`[data-existing-grid="${inputId}"]`);
  let remaining = [...(existingImages || [])];

  function renderExisting() {
    if (!grid) return;
    grid.innerHTML = remaining.map((url, i) => `
      <div class="media-thumb">
        <img src="${escapeHtml(url)}" alt="" />
        <button type="button" class="media-thumb-remove" data-remove-existing-idx="${i}" aria-label="Remove photo">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
        </button>
      </div>`).join("");
    grid.querySelectorAll("[data-remove-existing-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        remaining.splice(Number(btn.dataset.removeExistingIdx), 1);
        renderExisting();
      });
    });
  }
  renderExisting();

  const getNewFiles = wireImagePicker(root, inputId, { max: Math.max(1, max - remaining.length) });
  return { getRemainingUrls: () => remaining, getNewFiles };
}
