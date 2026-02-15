export function installCanvasKeyboardHandlers(target, handlers) {
  target.addEventListener("keydown", handlers.onKeyDown);
}
