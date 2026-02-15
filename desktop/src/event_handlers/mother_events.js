export function registerMotherEventHandlers(map, types, handlers) {
  map.set(types.PLAN_PREVIEW, handlers.onMother);
  map.set(types.VERSION_CREATED, handlers.onMother);
  map.set(types.MOTHER_INTENT_INFERRED, handlers.onMother);
  map.set(types.MOTHER_INTENT_INFER_FAILED, handlers.onMother);
  map.set(types.MOTHER_PROMPT_COMPILED, handlers.onMother);
  map.set(types.MOTHER_PROMPT_COMPILE_FAILED, handlers.onMother);
}
