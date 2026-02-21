const DEFAULT_TRANSFORMATION_MODES = new Set([
  "amplify",
  "transcend",
  "destabilize",
  "purify",
  "hybridize",
  "mythologize",
  "monumentalize",
  "fracture",
  "romanticize",
  "alienate",
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAweJoyScore(rawScore, rawConfidence = null) {
  if (typeof rawScore === "number" && Number.isFinite(rawScore)) {
    return clamp(Number(rawScore) || 0, 0, 100);
  }
  if (typeof rawConfidence === "number" && Number.isFinite(rawConfidence)) {
    return clamp((Number(rawConfidence) || 0) * 100, 0, 100);
  }
  return null;
}

function clampText(text, maxLen) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

function defaultNormalizeTransformationMode(rawMode) {
  const mode = String(rawMode || "").trim().toLowerCase();
  return DEFAULT_TRANSFORMATION_MODES.has(mode) ? mode : null;
}

function _stripJsonFences(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?/i, "").trim();
    text = text.replace(/```$/i, "").trim();
  }
  return text.trim();
}

function _extractFencedJsonBlocks(raw) {
  const text = String(raw || "");
  if (!text.includes("```")) return [];
  const out = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = null;
  while ((match = re.exec(text)) !== null) {
    const body = String(match?.[1] || "").trim();
    if (body) out.push(body);
  }
  return out;
}

function _extractBalancedJsonBlocks(raw) {
  const text = String(raw || "");
  if (!text) return [];
  const out = [];
  const stack = [];
  let start = -1;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (stack.length === 0) start = i;
      stack.push(ch);
      continue;
    }
    if (ch !== "}" && ch !== "]") continue;
    if (!stack.length) continue;
    const open = stack[stack.length - 1];
    const pairOk = (open === "{" && ch === "}") || (open === "[" && ch === "]");
    if (!pairOk) {
      stack.length = 0;
      start = -1;
      continue;
    }
    stack.pop();
    if (!stack.length && start >= 0) {
      const snippet = text.slice(start, i + 1).trim();
      if (snippet) out.push(snippet);
      start = -1;
    }
  }
  return out;
}

function _tryParseJsonLooseDetailed(raw) {
  const text = String(raw || "").trim();
  if (!text) return { value: null, mode: "empty", error: "empty_text" };
  const attempts = [{ mode: "strict", text }];
  const noTrailingCommas = text.replace(/,\s*([}\]])/g, "$1");
  if (noTrailingCommas !== text) attempts.push({ mode: "trailing_commas_removed", text: noTrailingCommas });
  let lastError = "";
  for (const attempt of attempts) {
    try {
      return { value: JSON.parse(attempt.text), mode: attempt.mode, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err || "json_parse_error");
    }
  }
  return { value: null, mode: "none", error: lastError || "json_parse_error" };
}

function _looksLikeIntentIconsPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schemaRaw = value.schema ? String(value.schema).trim().toLowerCase() : "";
  if (schemaRaw === "brood.intent_icons") return true;
  if (schemaRaw && schemaRaw.includes("intent") && schemaRaw.includes("icon")) return true;
  if (Array.isArray(value.intent_icons)) return true;
  if (Array.isArray(value.branches)) return true;
  if (Array.isArray(value.image_descriptions)) return true;
  if (typeof value.transformation_mode === "string" && value.transformation_mode.trim()) return true;
  if (Array.isArray(value.transformation_mode_candidates)) return true;
  return false;
}

function _unwrapIntentIconsPayload(value, depth = 0, seen = null, path = "root") {
  if (depth > 6 || value == null) return null;
  const visited = seen || new Set();
  if (typeof value === "string") {
    const parsed = _tryParseJsonLooseDetailed(value);
    if (!parsed.value) return null;
    return _unwrapIntentIconsPayload(parsed.value, depth + 1, visited, `${path}#string(${parsed.mode})`);
  }
  if (Array.isArray(value)) {
    for (let idx = 0; idx < value.length; idx += 1) {
      const found = _unwrapIntentIconsPayload(value[idx], depth + 1, visited, `${path}[${idx}]`);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (visited.has(value)) return null;
  visited.add(value);
  if (_looksLikeIntentIconsPayload(value)) return { payload: value, path };
  const preferredKeys = [
    "intent_icons_payload",
    "payload",
    "data",
    "result",
    "output",
    "response",
    "intent",
    "analysis",
    "message",
  ];
  for (const key of preferredKeys) {
    if (!(key in value)) continue;
    const found = _unwrapIntentIconsPayload(value[key], depth + 1, visited, `${path}.${key}`);
    if (found) return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!nested || (typeof nested !== "object" && typeof nested !== "string")) continue;
    const found = _unwrapIntentIconsPayload(nested, depth + 1, visited, `${path}.${String(key || "")}`);
    if (found) return found;
  }
  return null;
}

function _looksLikeTruncatedJsonText(raw) {
  const text = String(raw || "").trim();
  if (!text) return false;
  const startsJson = text.startsWith("{") || text.startsWith("[");
  const endsJson = text.endsWith("}") || text.endsWith("]");
  return startsJson && !endsJson;
}

export function intentIconsPayloadChecksum(raw) {
  const text = String(raw || "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

export function intentIconsPayloadSafeSnippet(raw, { head = 220, tail = 180 } = {}) {
  const normalized = String(raw || "")
    .replace(/[\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return { head: "", tail: "" };
  if (normalized.length <= head + tail + 8) return { head: normalized, tail: "" };
  return {
    head: normalized.slice(0, Math.max(0, head)),
    tail: normalized.slice(Math.max(0, normalized.length - Math.max(0, tail))),
  };
}

export function parseIntentIconsJsonDetailed(raw, { normalizeTransformationMode = defaultNormalizeTransformationMode } = {}) {
  const rawText = String(raw || "").trim();
  if (!rawText) {
    return {
      ok: false,
      value: null,
      strategy: "none",
      reason: "empty_text",
      error: "empty_text",
      candidate_count: 0,
      parseable_candidates: 0,
    };
  }
  const candidates = [];
  const seen = new Set();
  const addCandidate = (value, source) => {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    candidates.push({ text, source });
  };
  addCandidate(rawText, "raw");
  addCandidate(_stripJsonFences(rawText), "raw_unfenced");
  for (const block of _extractFencedJsonBlocks(rawText)) {
    addCandidate(block, "fenced_block");
    addCandidate(_stripJsonFences(block), "fenced_block_unfenced");
  }
  for (const block of _extractBalancedJsonBlocks(rawText)) addCandidate(block, "balanced_block");

  let obj = null;
  let parseStrategy = "none";
  let parseError = "";
  let parseableCandidates = 0;
  for (const candidate of candidates) {
    const parsed = _tryParseJsonLooseDetailed(candidate.text);
    if (!parsed.value) {
      if (parsed.error) parseError = parsed.error;
      continue;
    }
    parseableCandidates += 1;
    const unwrapped = _unwrapIntentIconsPayload(parsed.value);
    const payload = unwrapped?.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      obj = payload;
      parseStrategy = `${candidate.source}:${parsed.mode}:${String(unwrapped?.path || "root")}`;
      break;
    }
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    const truncated = _looksLikeTruncatedJsonText(rawText);
    return {
      ok: false,
      value: null,
      strategy: parseStrategy,
      reason: truncated ? "truncated_json" : parseableCandidates > 0 ? "no_intent_payload_found" : "invalid_json",
      error: parseError || null,
      candidate_count: candidates.length,
      parseable_candidates: parseableCandidates,
    };
  }
  const schemaRaw = obj.schema ? String(obj.schema).trim() : "";
  if (schemaRaw) {
    const schemaNorm = schemaRaw.toLowerCase().replace(/[.\s-]+/g, "_");
    if (!schemaNorm.includes("intent") || !schemaNorm.includes("icon")) {
      return {
        ok: false,
        value: null,
        strategy: parseStrategy,
        reason: "schema_mismatch",
        error: `unexpected_schema:${schemaRaw}`,
        candidate_count: candidates.length,
        parseable_candidates: parseableCandidates,
      };
    }
    obj.schema = "brood.intent_icons";
  }
  const hasIntentShape = Boolean(
    Array.isArray(obj.intent_icons) ||
      Array.isArray(obj.branches) ||
      Array.isArray(obj.image_descriptions) ||
      Array.isArray(obj.transformation_mode_candidates) ||
      (typeof obj.transformation_mode === "string" && obj.transformation_mode.trim())
  );
  if (!hasIntentShape && !schemaRaw) {
    return {
      ok: false,
      value: null,
      strategy: parseStrategy,
      reason: "no_intent_shape",
      error: "missing intent_icons/branches/image_descriptions/transformation_mode",
      candidate_count: candidates.length,
      parseable_candidates: parseableCandidates,
    };
  }

  if (!Array.isArray(obj.intent_icons)) obj.intent_icons = [];
  if (!Array.isArray(obj.branches)) obj.branches = [];
  if (!Array.isArray(obj.relations)) obj.relations = [];
  if (obj.checkpoint && typeof obj.checkpoint !== "object") obj.checkpoint = null;

  obj.intent_icons = obj.intent_icons
    .filter((it) => it && typeof it === "object")
    .map((it) => ({
      icon_id: it.icon_id ? String(it.icon_id) : "",
      confidence: typeof it.confidence === "number" ? it.confidence : 0,
      position_hint: it.position_hint ? String(it.position_hint) : "secondary",
    }))
    .filter((it) => Boolean(it.icon_id));

  obj.branches = obj.branches
    .filter((b) => b && typeof b === "object")
    .map((b, idx) => {
      const c = typeof b.confidence === "number" ? clamp(Number(b.confidence) || 0, 0, 1) : null;
      const evidence = Array.isArray(b.evidence_image_ids)
        ? b.evidence_image_ids.map((v) => String(v || "").trim()).filter(Boolean)
        : [];
      return {
        _idx: idx,
        confidence: c,
        evidence_image_ids: evidence.length ? evidence.slice(0, 3) : [],
        branch_id: b.branch_id ? String(b.branch_id) : "",
        icons: Array.isArray(b.icons) ? b.icons.map((v) => String(v || "").trim()).filter(Boolean) : [],
        lane_position: b.lane_position ? String(b.lane_position) : "left",
      };
    })
    .filter((b) => Boolean(b.branch_id) && b.icons.length > 0);

  const anyBranchConf = obj.branches.some((b) => typeof b?.confidence === "number" && Number.isFinite(b.confidence));
  if (anyBranchConf) {
    obj.branches.sort((a, b) => {
      const ac = typeof a?.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : -1;
      const bc = typeof b?.confidence === "number" && Number.isFinite(b.confidence) ? b.confidence : -1;
      if (bc !== ac) return bc - ac;
      return (Number(a?._idx) || 0) - (Number(b?._idx) || 0);
    });
  }

  obj.branches = obj.branches
    .map((b) => ({
      branch_id: b.branch_id ? String(b.branch_id) : "",
      confidence: typeof b.confidence === "number" && Number.isFinite(b.confidence) ? clamp(Number(b.confidence) || 0, 0, 1) : null,
      evidence_image_ids: Array.isArray(b.evidence_image_ids)
        ? b.evidence_image_ids.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 3)
        : [],
      icons: Array.isArray(b.icons) ? b.icons.map((v) => String(v || "").trim()).filter(Boolean) : [],
      lane_position: b.lane_position ? String(b.lane_position) : "left",
    }))
    .filter((b) => Boolean(b.branch_id) && b.icons.length > 0);

  obj.relations = obj.relations
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      from_icon: r.from_icon ? String(r.from_icon) : "",
      to_icon: r.to_icon ? String(r.to_icon) : "",
      relation_type: r.relation_type ? String(r.relation_type) : "FLOW",
    }))
    .filter((r) => r.from_icon && r.to_icon);

  if (obj.checkpoint) {
    const icons = Array.isArray(obj.checkpoint.icons) ? obj.checkpoint.icons : [];
    obj.checkpoint = {
      icons: icons.map((v) => String(v || "").trim()).filter(Boolean),
      applies_to: obj.checkpoint.applies_to ? String(obj.checkpoint.applies_to) : null,
    };
  }

  const parsedMode = normalizeTransformationMode(obj.transformation_mode);
  obj.transformation_mode = parsedMode || null;
  const rawModeCandidates = Array.isArray(obj.transformation_mode_candidates)
    ? obj.transformation_mode_candidates
    : [];
  const modeCandidates = rawModeCandidates
    .map((entry, idx) => {
      if (!entry || typeof entry !== "object") return null;
      const mode = normalizeTransformationMode(entry.mode || entry.transformation_mode);
      if (!mode) return null;
      const confidence = typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
        ? clamp(Number(entry.confidence) || 0, 0, 1)
        : null;
      const aweJoyScore = normalizeAweJoyScore(entry.awe_joy_score, confidence);
      return { _idx: idx, mode, confidence, awe_joy_score: aweJoyScore };
    })
    .filter(Boolean);
  if (modeCandidates.length) {
    modeCandidates.sort((a, b) => {
      const as = typeof a.awe_joy_score === "number" ? a.awe_joy_score : -1;
      const bs = typeof b.awe_joy_score === "number" ? b.awe_joy_score : -1;
      if (bs !== as) return bs - as;
      const ac = typeof a.confidence === "number" ? a.confidence : -1;
      const bc = typeof b.confidence === "number" ? b.confidence : -1;
      if (bc !== ac) return bc - ac;
      return Number(a._idx) - Number(b._idx);
    });
  }
  obj.transformation_mode_candidates = modeCandidates.map((entry) => ({
    mode: entry.mode,
    awe_joy_score: typeof entry.awe_joy_score === "number" ? entry.awe_joy_score : null,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
  }));
  if (!obj.transformation_mode && obj.transformation_mode_candidates.length) {
    obj.transformation_mode = String(obj.transformation_mode_candidates[0].mode || "").trim() || null;
  }

  if (!obj.frame_id) obj.frame_id = "";
  if (!obj.schema) obj.schema = "brood.intent_icons";
  if (!obj.schema_version) obj.schema_version = 1;
  return {
    ok: true,
    value: obj,
    strategy: parseStrategy || "unknown",
    reason: null,
    error: null,
    candidate_count: candidates.length,
    parseable_candidates: parseableCandidates,
  };
}

export function parseIntentIconsJson(raw, options = {}) {
  const parsed = parseIntentIconsJsonDetailed(raw, options);
  return parsed?.ok ? parsed.value : null;
}

export function classifyIntentIconsRouting({
  path = "",
  intentPendingPath = "",
  ambientPendingPath = "",
  motherCanAcceptRealtime = false,
  motherRealtimePath = "",
  motherActionVersion = 0,
  eventActionVersion = null,
  eventIntentScope = "",
} = {}) {
  const normalizedPath = String(path || "");
  const normalizedIntentPath = String(intentPendingPath || "");
  const normalizedAmbientPath = String(ambientPendingPath || "");
  const normalizedMotherPath = String(motherRealtimePath || "");
  const normalizedScope = String(eventIntentScope || "").trim().toLowerCase();
  const scopeIsAmbient = normalizedScope === "ambient";
  const scopeIsMother = normalizedScope === "mother";
  const scopeAllowsAmbient = !normalizedScope || scopeIsAmbient;
  const scopeAllowsMother = !normalizedScope || scopeIsMother;
  const actionVersion = Number(motherActionVersion) || 0;
  const eventVersion = Number(eventActionVersion);

  const matchIntent = Boolean(
    scopeAllowsAmbient &&
    normalizedIntentPath &&
    normalizedIntentPath === normalizedPath
  );
  const matchAmbient = Boolean(
    scopeAllowsAmbient &&
    normalizedAmbientPath &&
    normalizedAmbientPath === normalizedPath
  );
  const matchMother = Boolean(
    scopeAllowsMother &&
    motherCanAcceptRealtime &&
    normalizedMotherPath &&
    normalizedMotherPath === normalizedPath
  );

  let ignoreReason = null;
  if (!matchIntent && !matchAmbient && !matchMother) {
    if (motherCanAcceptRealtime && normalizedMotherPath && scopeIsAmbient) {
      ignoreReason = "scope_mismatch";
    } else {
      ignoreReason = motherCanAcceptRealtime && normalizedMotherPath ? "snapshot_path_mismatch" : "path_mismatch";
    }
  } else if (
    matchMother &&
    Number.isFinite(eventVersion) &&
    eventVersion > 0 &&
    eventVersion !== actionVersion
  ) {
    ignoreReason = "event_action_version_mismatch";
  }
  return { matchIntent, matchAmbient, matchMother, ignoreReason };
}
