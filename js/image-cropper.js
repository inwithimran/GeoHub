// ============================================================
// IMAGE-CROPPER.JS — a small, dependency-free "move & scale"
// cropper for profile photos, in the spirit of the Facebook/
// Instagram profile-photo flow: pick a file, then drag to
// reposition and pinch/scroll/slide to zoom the photo inside a
// circular 1:1 frame before it's uploaded. Output is always a
// square (1:1) JPEG blob, sized for an avatar.
// ============================================================

const OUTPUT_SIZE = 640; // px — the square JPEG we actually upload
const MIN_ZOOM = 1;      // 1 = image just covers the frame (like object-fit:cover)
const MAX_ZOOM = 3.2;

/**
 * Opens the full-screen cropper for `file`. Resolves a square JPEG Blob if
 * the user taps "Use Photo", or `null` if they cancel — either way the
 * overlay is fully cleaned up before resolving.
 */
export function openImageCropper(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    const overlay = document.createElement("div");
    overlay.className = "cropper-overlay";
    overlay.innerHTML = `
      <div class="cropper-topbar">
        <button type="button" class="cropper-cancel">Cancel</button>
        <h4>Move &amp; Scale</h4>
        <button type="button" class="cropper-save" disabled>Use Photo</button>
      </div>
      <div class="cropper-stage">
        <div class="cropper-viewport">
          <img alt="" draggable="false" />
        </div>
      </div>
      <div class="cropper-controls">
        <svg class="cropper-zoom-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="6.5"/><line x1="19" y1="19" x2="14.8" y2="14.8"/></svg>
        <input type="range" class="cropper-zoom-slider" min="0" max="1" step="0.001" value="0" disabled />
        <svg class="cropper-zoom-icon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="6.5"/><line x1="19" y1="19" x2="14.8" y2="14.8"/></svg>
      </div>
      <p class="cropper-hint">Drag to reposition · pinch or slide to zoom</p>`;
    document.body.appendChild(overlay);

    const viewport = overlay.querySelector(".cropper-viewport");
    const imgEl = overlay.querySelector(".cropper-viewport img");
    const stage = overlay.querySelector(".cropper-stage");
    const slider = overlay.querySelector(".cropper-zoom-slider");
    const saveBtn = overlay.querySelector(".cropper-save");
    const cancelBtn = overlay.querySelector(".cropper-cancel");

    let viewportSize = 0;
    let baseScale = 1;   // scale at which the image just covers the viewport
    let zoom = MIN_ZOOM;  // user zoom multiplier on top of baseScale
    let offsetX = 0, offsetY = 0; // pan, in viewport px, relative to center
    let naturalW = 0, naturalH = 0;
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      overlay.removeEventListener("click", onStageClickGuard);
      overlay.remove();
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    }
    // Swallow a tap that lands on the overlay's own bare backdrop (so it
    // doesn't leak through to whatever's behind it) — but ONLY when the
    // click's target IS the overlay itself, and only in the bubble phase
    // (default, no capture). The previous version ran in the capture
    // phase and called stopPropagation() unconditionally for every click
    // anywhere inside the overlay; stopping propagation during capture
    // halts the event before it ever reaches a descendant's own listener,
    // which silently broke both "Use Photo" and "Cancel" (their click
    // handlers, below, never fired).
    function onStageClickGuard(e) { if (e.target === overlay) e.stopPropagation(); }
    overlay.addEventListener("click", onStageClickGuard);

    cancelBtn.addEventListener("click", () => finish(null));

    img.onload = () => {
      naturalW = img.naturalWidth;
      naturalH = img.naturalHeight;
      imgEl.src = objectUrl;

      sizeViewport();
      baseScale = Math.max(viewportSize / naturalW, viewportSize / naturalH);
      zoom = MIN_ZOOM;
      offsetX = 0;
      offsetY = 0;
      slider.disabled = false;
      saveBtn.disabled = false;
      applyTransform();
    };
    img.onerror = () => {
      finish(null);
    };
    img.src = objectUrl;

    function sizeViewport() {
      const available = Math.min(window.innerWidth, window.innerHeight - 190);
      viewportSize = Math.max(200, Math.min(340, available * 0.86));
      viewport.style.width = viewportSize + "px";
      viewport.style.height = viewportSize + "px";
    }

    function displayedSize() {
      const s = baseScale * zoom;
      return { w: naturalW * s, h: naturalH * s };
    }

    function clampOffsets() {
      const { w, h } = displayedSize();
      const maxX = Math.max(0, (w - viewportSize) / 2);
      const maxY = Math.max(0, (h - viewportSize) / 2);
      offsetX = Math.min(maxX, Math.max(-maxX, offsetX));
      offsetY = Math.min(maxY, Math.max(-maxY, offsetY));
    }

    function applyTransform() {
      clampOffsets();
      const { w, h } = displayedSize();
      const left = viewportSize / 2 - w / 2 + offsetX;
      const top = viewportSize / 2 - h / 2 + offsetY;
      imgEl.style.width = w + "px";
      imgEl.style.height = h + "px";
      imgEl.style.transform = `translate(${left}px, ${top}px)`;
      slider.value = String((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM));
    }

    function setZoom(nextZoom, aroundCenter = true) {
      const prev = zoom;
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
      if (aroundCenter && prev !== 0) {
        // Keep the same image point under the viewport center while zooming.
        const ratio = zoom / prev;
        offsetX *= ratio;
        offsetY *= ratio;
      }
      applyTransform();
    }

    slider.addEventListener("input", () => {
      const t = Number(slider.value);
      setZoom(MIN_ZOOM + t * (MAX_ZOOM - MIN_ZOOM));
    });

    // ---------- Drag to pan (mouse / touch / pen, via Pointer Events) + pinch to zoom ----------
    const pointers = new Map(); // pointerId -> {x, y}
    let dragLast = null;        // {x, y} of the single active pointer
    let pinchStartDist = null;
    let pinchStartZoom = 1;

    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

    stage.addEventListener("pointerdown", (e) => {
      if (!naturalW) return;
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        dragLast = { x: e.clientX, y: e.clientY };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStartDist = dist(a, b);
        pinchStartZoom = zoom;
        dragLast = null;
      }
    });

    stage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (pinchStartDist) {
          const scale = dist(a, b) / pinchStartDist;
          setZoom(pinchStartZoom * scale);
        }
      } else if (pointers.size === 1 && dragLast) {
        offsetX += e.clientX - dragLast.x;
        offsetY += e.clientY - dragLast.y;
        dragLast = { x: e.clientX, y: e.clientY };
        applyTransform();
      }
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size === 1) {
        const [only] = [...pointers.values()];
        dragLast = only;
        pinchStartDist = null;
      } else if (pointers.size === 0) {
        dragLast = null;
        pinchStartDist = null;
      }
    }
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);
    stage.addEventListener("pointerleave", (e) => { if (pointers.size < 2) endPointer(e); });

    // ---------- Desktop mouse wheel to zoom ----------
    stage.addEventListener("wheel", (e) => {
      if (!naturalW) return;
      e.preventDefault();
      setZoom(zoom - e.deltaY * 0.0018);
    }, { passive: false });

    window.addEventListener("resize", () => {
      if (!naturalW) return;
      const prevSize = viewportSize;
      sizeViewport();
      const newBase = Math.max(viewportSize / naturalW, viewportSize / naturalH);
      const ratio = (viewportSize / prevSize);
      offsetX *= ratio;
      offsetY *= ratio;
      baseScale = newBase;
      applyTransform();
    }, { once: false, passive: true });

    saveBtn.addEventListener("click", () => {
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext("2d");
      const k = OUTPUT_SIZE / viewportSize;
      const { w, h } = displayedSize();
      const left = (viewportSize / 2 - w / 2 + offsetX) * k;
      const top = (viewportSize / 2 - h / 2 + offsetY) * k;
      ctx.drawImage(img, left, top, w * k, h * k);
      canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.9);
    });
  });
}
