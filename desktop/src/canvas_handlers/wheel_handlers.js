export function installCanvasWheelHandlers(target, handlers) {
  target.addEventListener("wheel", handlers.onWheel, { passive: false });
}
