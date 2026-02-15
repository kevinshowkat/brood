export function registerDiagnosticsEventHandlers(map, types, handlers) {
  map.set(types.IMAGE_DESCRIPTION, handlers.onDiagnostics);
  map.set(types.IMAGE_DIAGNOSIS, handlers.onDiagnostics);
  map.set(types.IMAGE_DIAGNOSIS_FAILED, handlers.onDiagnostics);
  map.set(types.IMAGE_ARGUMENT, handlers.onDiagnostics);
  map.set(types.IMAGE_ARGUMENT_FAILED, handlers.onDiagnostics);
  map.set(types.IMAGE_DNA_EXTRACTED, handlers.onDiagnostics);
  map.set(types.IMAGE_DNA_EXTRACTED_FAILED, handlers.onDiagnostics);
  map.set(types.IMAGE_SOUL_EXTRACTED, handlers.onDiagnostics);
  map.set(types.IMAGE_SOUL_EXTRACTED_FAILED, handlers.onDiagnostics);
  map.set(types.TRIPLET_RULE, handlers.onDiagnostics);
  map.set(types.TRIPLET_RULE_FAILED, handlers.onDiagnostics);
  map.set(types.TRIPLET_ODD_ONE_OUT, handlers.onDiagnostics);
  map.set(types.TRIPLET_ODD_ONE_OUT_FAILED, handlers.onDiagnostics);
}
