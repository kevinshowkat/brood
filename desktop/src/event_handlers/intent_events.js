export function registerIntentEventHandlers(map, types, handlers) {
  map.set(types.COST_LATENCY_UPDATE, handlers.onIntent);
  map.set(types.CANVAS_CONTEXT, handlers.onIntent);
  map.set(types.CANVAS_CONTEXT_FAILED, handlers.onIntent);
  map.set(types.INTENT_ICONS, handlers.onIntent);
  map.set(types.INTENT_ICONS_FAILED, handlers.onIntent);
}
