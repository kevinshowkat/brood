import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MOTHER_IDLE_EVENTS,
  MOTHER_IDLE_STATES,
  motherIdleInitialState,
  motherIdleTransition,
  motherIdleUsesRealtimeVisual,
} from "../src/mother_idle_flow.js";

test("Mother idle state machine: starts in setup/arming", () => {
  assert.equal(motherIdleInitialState(), MOTHER_IDLE_STATES.SETUP_ARMING);
});

test("Mother idle state machine: follows the requested deterministic flow", () => {
  let phase = motherIdleInitialState();

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED);
  assert.equal(phase, MOTHER_IDLE_STATES.IDLE_REALTIME_ACTIVE);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.GENERATION_DISPATCHED);
  assert.equal(phase, MOTHER_IDLE_STATES.GENERATION_DISPATCHED);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.GENERATION_INSERTED);
  assert.equal(phase, MOTHER_IDLE_STATES.WAITING_FOR_USER);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.USER_RESPONSE_TIMEOUT);
  assert.equal(phase, MOTHER_IDLE_STATES.TAKEOVER);
});

test("Mother idle state machine: user interaction always resets to setup/arming", () => {
  for (const phase of Object.values(MOTHER_IDLE_STATES)) {
    const next = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.USER_INTERACTION);
    assert.equal(next, MOTHER_IDLE_STATES.SETUP_ARMING);
  }
});

test("Mother idle state machine: realtime visual only appears in active dispatch window", () => {
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.SETUP_ARMING), false);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.IDLE_REALTIME_ACTIVE), true);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.GENERATION_DISPATCHED), true);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.WAITING_FOR_USER), false);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.TAKEOVER), false);
});
