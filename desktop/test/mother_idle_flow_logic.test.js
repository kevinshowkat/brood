import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MOTHER_IDLE_EVENTS,
  MOTHER_IDLE_STATES,
  motherIdleInitialState,
  motherIdleTransition,
  motherIdleUsesRealtimeVisual,
} from "../src/mother_idle_flow.js";

test("Mother idle state machine: starts in observing", () => {
  assert.equal(motherIdleInitialState(), MOTHER_IDLE_STATES.OBSERVING);
});

test("Mother idle state machine: follows the Mother v2 deterministic flow", () => {
  let phase = motherIdleInitialState();

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED);
  assert.equal(phase, MOTHER_IDLE_STATES.WATCHING);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED);
  assert.equal(phase, MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.CONFIRM);
  assert.equal(phase, MOTHER_IDLE_STATES.DRAFTING);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.DRAFT_READY);
  assert.equal(phase, MOTHER_IDLE_STATES.OFFERING);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.DEPLOY);
  assert.equal(phase, MOTHER_IDLE_STATES.COMMITTING);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.COMMIT_DONE);
  assert.equal(phase, MOTHER_IDLE_STATES.COOLDOWN);

  phase = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.COOLDOWN_DONE);
  assert.equal(phase, MOTHER_IDLE_STATES.OBSERVING);
});

test("Mother idle state machine: user interaction always resets to observing", () => {
  for (const phase of Object.values(MOTHER_IDLE_STATES)) {
    const next = motherIdleTransition(phase, MOTHER_IDLE_EVENTS.USER_INTERACTION);
    assert.equal(next, MOTHER_IDLE_STATES.OBSERVING);
  }
});

test("Mother idle state machine: realtime visual appears only during watching", () => {
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.OBSERVING), false);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.WATCHING), true);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING), false);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.DRAFTING), false);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.OFFERING), false);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.COMMITTING), false);
  assert.equal(motherIdleUsesRealtimeVisual(MOTHER_IDLE_STATES.COOLDOWN), false);
});
