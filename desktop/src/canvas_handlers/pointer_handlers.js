export function installCanvasPointerHandlers(target, handlers) {
  target.addEventListener("pointerenter", handlers.onPointerEnter);
  target.addEventListener("pointerleave", handlers.onPointerLeave);
  target.addEventListener("contextmenu", handlers.onContextMenu);
  target.addEventListener("pointerdown", handlers.onPointerDown);
  target.addEventListener("pointermove", handlers.onPointerMove);
  target.addEventListener("pointerup", handlers.onPointerUp);
  target.addEventListener("pointercancel", handlers.onPointerCancel);
}
