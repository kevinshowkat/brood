export function installCanvasGestureHandlers(target, handlers) {
  target.addEventListener("gesturestart", handlers.onGestureStart, { passive: false });
  target.addEventListener("gesturechange", handlers.onGestureChange, { passive: false });
  target.addEventListener("gestureend", handlers.onGestureEnd, { passive: false });
}
