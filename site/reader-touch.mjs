// Keep one-finger scrolling native; only a PDF pinch takes over the gesture.
export function installPDFTouchGestures(container, getViewer) {
  let pinch = null, remainingTouch = null, pending = null, frame = 0;
  const clamp = value => Math.max(.1, Math.min(4, value));
  const point = touch => [touch.clientX, touch.clientY];
  const sample = touches => {
    const [a, b] = touches;
    return {
      ids: [a.identifier, b.identifier],
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      center: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2],
    };
  };
  const prevent = event => { if (event.cancelable) event.preventDefault(); };

  function apply() {
    frame = 0;
    const viewer = getViewer(), next = pending;
    pending = null;
    if (!pinch || !next || !viewer?.pdfDocument) return;
    const scale = clamp(pinch.scale * next.distance / pinch.distance);
    viewer.updateScale({
      scaleFactor: scale / viewer.currentScale,
      origin: pinch.center,
      pan: [next.center[0] - pinch.center[0], next.center[1] - pinch.center[1]],
      // PDF.js scales existing canvases now and redraws after movement settles.
      drawingDelay: 200,
    });
    pinch.center = next.center;
  }
  function flush() {
    if (frame) cancelAnimationFrame(frame);
    apply();
  }
  function reset() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pinch = remainingTouch = pending = null;
  }
  function start(event) {
    const viewer = getViewer();
    if (!viewer?.pdfDocument) return;
    if (event.touches.length < 2) { reset(); return; }
    prevent(event);
    flush();
    const next = sample(event.touches);
    pinch = { ...next, distance: Math.max(1, next.distance), scale: viewer.currentScale };
    remainingTouch = null;
  }
  function move(event) {
    const viewer = getViewer();
    if (!viewer?.pdfDocument) { reset(); return; }
    if (event.touches.length >= 2) {
      prevent(event);
      const next = sample(event.touches);
      if (!pinch || next.ids.some((id, index) => id !== pinch.ids[index])) {
        start(event);
        return;
      }
      pending = next;
      if (!frame) frame = requestAnimationFrame(apply);
    } else if (remainingTouch && event.touches.length === 1) {
      // The browser cannot resume native scrolling within a cancelled pinch.
      // Let the finger still on the screen continue panning until it is lifted.
      prevent(event);
      const next = point(event.touches[0]);
      viewer.panBy(next[0] - remainingTouch[0], next[1] - remainingTouch[1]);
      remainingTouch = next;
    }
  }
  function end(event) {
    const wasPinching = !!pinch || !!remainingTouch;
    flush();
    pinch = null;
    remainingTouch = wasPinching && event.touches.length === 1 ? point(event.touches[0]) : null;
    if (event.touches.length >= 2) start(event);
  }

  container.addEventListener('touchstart', start, { passive: false });
  container.addEventListener('touchmove', move, { passive: false });
  container.addEventListener('touchend', end, { passive: true });
  container.addEventListener('touchcancel', reset, { passive: true });
  // Safari also emits these proprietary events alongside touch events.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    container.addEventListener(type, event => {
      if (getViewer()?.pdfDocument) prevent(event);
    }, { passive: false });
  }
  return reset;
}

// Ctrl+wheel (including trackpad pinch events) zooms the document under the
// cursor. Ordinary wheel scrolling and browser zoom in the library stay native.
export function installPDFWheelZoom(target, getViewer) {
  let frame = 0, pending = null, targetScale = 0, expectedScale = 0, lastWheelAt = 0;
  const clamp = value => Math.max(.1, Math.min(4, value));

  function reset() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    targetScale = expectedScale = lastWheelAt = 0;
  }
  function apply() {
    frame = 0;
    const viewer = getViewer(), origin = pending;
    pending = null;
    if (!origin || !viewer?.pdfDocument) { reset(); return; }
    viewer.updateScale({
      scaleFactor: targetScale / viewer.currentScale,
      origin,
      drawingDelay: 150,
    });
    expectedScale = viewer.currentScale;
  }
  target.addEventListener('wheel', event => {
    const viewer = getViewer();
    if (!(event.ctrlKey || event.metaKey) || !viewer?.pdfDocument ||
        !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    if (event.cancelable) event.preventDefault();
    const container = viewer.container || target;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 30 : event.deltaMode === 2 ? container.clientHeight : 1);
    const now = performance.now();
    if (now - lastWheelAt > 300 || viewer.currentScale !== expectedScale) {
      targetScale = viewer.currentScale;
    }
    // Accumulate small trackpad deltas even when PDF.js rounds a scale update.
    targetScale = clamp(targetScale * Math.exp(-Math.max(-150, Math.min(150, pixels)) / 600));
    expectedScale = viewer.currentScale;
    lastWheelAt = now;
    const bounds = container.getBoundingClientRect();
    pending = [
      Math.max(bounds.left, Math.min(bounds.right, event.clientX)),
      Math.max(bounds.top, Math.min(bounds.bottom, event.clientY)),
    ];
    if (!frame) frame = requestAnimationFrame(apply);
  }, { passive: false });
  return reset;
}
