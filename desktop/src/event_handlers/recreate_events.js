export function registerRecreateEventHandlers(map, types, handlers) {
  map.set(types.RECREATE_PROMPT_INFERRED, handlers.onRecreate);
  map.set(types.RECREATE_ITERATION_UPDATE, handlers.onRecreate);
  map.set(types.RECREATE_DONE, handlers.onRecreate);
}
