export function registerArtifactEventHandlers(map, types, handlers) {
  map.set(types.ARTIFACT_CREATED, handlers.onArtifact);
  map.set(types.GENERATION_FAILED, handlers.onArtifact);
}
