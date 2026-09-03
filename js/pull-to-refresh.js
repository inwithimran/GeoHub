const PULL_THRESHOLD = 64;
const MAX_PULL = 110;

export function initPullToRefresh({ indicatorId, isActive, onRefresh }) {
  const indicator = document.getElementById(indicatorId);
  if (!indicator) return;

  let startY = 0;
  let pulling = false;
  let refreshing = false;
  let armed = false;

  function reset() {
    pulling = false;
    armed = false;
    indicator.style.transform = "translate(-50%, -60px)";
    indicator.classList.remove("visible");
  }

  document.addEventListener("touchstart", (e) => {
    if (refreshing || !isActive()) return;
    if ((window.scrollY || document.scrollingElement.scrollTop) > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
    armed = false;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling || refreshing) return;
    const diff = e.touches[0].clientY - startY;
    if (diff <= 0) {
      reset();
      return;
    }
    armed = diff > PULL_THRESHOLD;
    const clamped = Math.min(diff, MAX_PULL);
    indicator.style.transform = `translate(-50%, ${clamped - 60}px)`;
    indicator.classList.add("visible");
  }, { passive: true });

  document.addEventListener("touchend", async () => {
    if (!pulling || refreshing) return;
    pulling = false;
    if (!armed) {
      reset();
      return;
    }
    refreshing = true;
    indicator.style.transform = "translate(-50%, 14px)";
    try {
      await onRefresh();
    } finally {
      refreshing = false;
      reset();
    }
  }, { passive: true });
}