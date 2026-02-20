const RETRYABLE_TRANSPORT_ERROR_FRAGMENTS = Object.freeze([
  "realtime socket closed",
  "failed to send realtime payload",
  "realtime read failed",
  "failed to connect realtime websocket",
  "broken pipe",
  "connection reset",
]);

export function isRetryableRealtimeTransportFailureEvent(event = {}) {
  if (!event || typeof event !== "object") return false;
  if (event.retryable === true) return true;
  if (event.fatal === true) return false;
  if (event.transport_error === true) return true;
  const errLower = String(event.error || "").trim().toLowerCase();
  if (!errLower) return false;
  return RETRYABLE_TRANSPORT_ERROR_FRAGMENTS.some((fragment) => errLower.includes(fragment));
}

export function nextMotherRealtimeIntentFailureAction({
  event = {},
  matchMother = false,
  pendingIntent = false,
  phase = "",
  actionVersion = 0,
  pendingActionVersion = 0,
  retryCount = 0,
  maxRetries = 0,
} = {}) {
  if (!matchMother || !pendingIntent) {
    return { action: "ignore", retryable: false, reason: "not_pending_mother" };
  }
  if (String(phase || "") !== "intent_hypothesizing") {
    return { action: "ignore", retryable: false, reason: "phase_mismatch" };
  }
  const retryable = isRetryableRealtimeTransportFailureEvent(event);
  if (!retryable) {
    return { action: "fail", retryable: false, reason: "non_retryable" };
  }
  const action = Number(actionVersion) || 0;
  const pending = Number(pendingActionVersion) || 0;
  if (!action || action !== pending) {
    return { action: "fail", retryable: true, reason: "action_version_mismatch" };
  }
  const retries = Math.max(0, Number(retryCount) || 0);
  const max = Math.max(0, Number(maxRetries) || 0);
  if (retries >= max) {
    return {
      action: "fail",
      retryable: true,
      reason: "retry_exhausted",
      nextRetryCount: retries,
    };
  }
  return {
    action: "retry",
    retryable: true,
    reason: "transport",
    nextRetryCount: retries + 1,
  };
}
