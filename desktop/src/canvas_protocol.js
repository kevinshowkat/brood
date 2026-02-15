export const DESKTOP_EVENT_TYPES = Object.freeze({
  PLAN_PREVIEW: "plan_preview",
  VERSION_CREATED: "version_created",
  MOTHER_INTENT_INFERRED: "mother_intent_inferred",
  MOTHER_INTENT_INFER_FAILED: "mother_intent_infer_failed",
  MOTHER_PROMPT_COMPILED: "mother_prompt_compiled",
  MOTHER_PROMPT_COMPILE_FAILED: "mother_prompt_compile_failed",
  ARTIFACT_CREATED: "artifact_created",
  GENERATION_FAILED: "generation_failed",
  COST_LATENCY_UPDATE: "cost_latency_update",
  CANVAS_CONTEXT: "canvas_context",
  CANVAS_CONTEXT_FAILED: "canvas_context_failed",
  INTENT_ICONS: "intent_icons",
  INTENT_ICONS_FAILED: "intent_icons_failed",
  IMAGE_DESCRIPTION: "image_description",
  IMAGE_DIAGNOSIS: "image_diagnosis",
  IMAGE_DIAGNOSIS_FAILED: "image_diagnosis_failed",
  IMAGE_ARGUMENT: "image_argument",
  IMAGE_ARGUMENT_FAILED: "image_argument_failed",
  IMAGE_DNA_EXTRACTED: "image_dna_extracted",
  IMAGE_DNA_EXTRACTED_FAILED: "image_dna_extracted_failed",
  IMAGE_SOUL_EXTRACTED: "image_soul_extracted",
  IMAGE_SOUL_EXTRACTED_FAILED: "image_soul_extracted_failed",
  TRIPLET_RULE: "triplet_rule",
  TRIPLET_RULE_FAILED: "triplet_rule_failed",
  TRIPLET_ODD_ONE_OUT: "triplet_odd_one_out",
  TRIPLET_ODD_ONE_OUT_FAILED: "triplet_odd_one_out_failed",
  RECREATE_PROMPT_INFERRED: "recreate_prompt_inferred",
  RECREATE_ITERATION_UPDATE: "recreate_iteration_update",
  RECREATE_DONE: "recreate_done",
});

export const PTY_COMMANDS = Object.freeze({
  TEXT_MODEL: "/text_model",
  IMAGE_MODEL: "/image_model",
  DESCRIBE: "/describe",
  USE: "/use",
  CANVAS_CONTEXT_RT_START: "/canvas_context_rt_start",
  CANVAS_CONTEXT_RT_STOP: "/canvas_context_rt_stop",
  CANVAS_CONTEXT_RT: "/canvas_context_rt",
  INTENT_RT_START: "/intent_rt_start",
  INTENT_RT_STOP: "/intent_rt_stop",
  INTENT_RT: "/intent_rt",
  INTENT_RT_MOTHER_START: "/intent_rt_mother_start",
  INTENT_RT_MOTHER: "/intent_rt_mother",
  INTENT_INFER: "/intent_infer",
  PROMPT_COMPILE: "/prompt_compile",
  MOTHER_GENERATE: "/mother_generate",
  DIAGNOSE: "/diagnose",
  RECAST: "/recast",
  RECREATE: "/recreate",
  BLEND: "/blend",
  SWAP_DNA: "/swap_dna",
  BRIDGE: "/bridge",
  ARGUE: "/argue",
  EXTRACT_DNA: "/extract_dna",
  SOUL_LEECH: "/soul_leech",
  EXTRACT_RULE: "/extract_rule",
  ODD_ONE_OUT: "/odd_one_out",
  TRIFORCE: "/triforce",
});

export function quoteForPtyArg(value) {
  const raw = String(value || "");
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function buildPtyCommand(command, argsText = "") {
  const cmd = String(command || "").trim();
  const args = String(argsText || "");
  return `${cmd}${args ? ` ${args}` : ""}\n`;
}

export function writePty(invokeFn, data) {
  return invokeFn("write_pty", { data });
}

export function sendPtyCommand(invokeFn, command, argsText = "") {
  return writePty(invokeFn, buildPtyCommand(command, argsText));
}
