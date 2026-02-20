import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isRetryableRealtimeTransportFailureEvent,
  nextMotherRealtimeIntentFailureAction,
} from "../src/realtime_intent_recovery.js";

test("Realtime intent recovery: explicit retryable metadata wins", () => {
  assert.equal(
    isRetryableRealtimeTransportFailureEvent({
      error: "something else",
      retryable: true,
      fatal: false,
    }),
    true
  );
  assert.equal(
    isRetryableRealtimeTransportFailureEvent({
      error: "realtime socket closed",
      retryable: false,
      fatal: true,
    }),
    false
  );
});

test("Realtime intent recovery: transport error text fallback remains compatible", () => {
  assert.equal(
    isRetryableRealtimeTransportFailureEvent({ error: "failed to send realtime payload" }),
    true
  );
  assert.equal(
    isRetryableRealtimeTransportFailureEvent({ error: "realtime read failed: connection reset by peer" }),
    true
  );
  assert.equal(
    isRetryableRealtimeTransportFailureEvent({ error: "Mother realtime intent parse failed." }),
    false
  );
});

test("Realtime intent recovery: mother flow retries transient failures while pending", () => {
  const decision = nextMotherRealtimeIntentFailureAction({
    event: { error: "realtime socket closed", fatal: false, retryable: true },
    matchMother: true,
    pendingIntent: true,
    phase: "intent_hypothesizing",
    actionVersion: 955,
    pendingActionVersion: 955,
    retryCount: 0,
    maxRetries: 2,
  });
  assert.equal(decision.action, "retry");
  assert.equal(decision.nextRetryCount, 1);
});

test("Realtime intent recovery: retries are bounded and then fail cleanly", () => {
  const decision = nextMotherRealtimeIntentFailureAction({
    event: { error: "failed to send realtime payload", fatal: false, transport_error: true },
    matchMother: true,
    pendingIntent: true,
    phase: "intent_hypothesizing",
    actionVersion: 955,
    pendingActionVersion: 955,
    retryCount: 2,
    maxRetries: 2,
  });
  assert.equal(decision.action, "fail");
  assert.equal(decision.retryable, true);
  assert.equal(decision.reason, "retry_exhausted");
});

test("Realtime intent recovery: non-retryable failures still fail immediately", () => {
  const decision = nextMotherRealtimeIntentFailureAction({
    event: { error: "Mother realtime intent parse failed.", fatal: false },
    matchMother: true,
    pendingIntent: true,
    phase: "intent_hypothesizing",
    actionVersion: 955,
    pendingActionVersion: 955,
    retryCount: 0,
    maxRetries: 2,
  });
  assert.equal(decision.action, "fail");
  assert.equal(decision.retryable, false);
  assert.equal(decision.reason, "non_retryable");
});

