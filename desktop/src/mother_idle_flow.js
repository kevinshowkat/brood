export const MOTHER_IDLE_STATES = Object.freeze({
  OBSERVING: "observing",
  WATCHING: "watching",
  INTENT_HYPOTHESIZING: "intent_hypothesizing",
  DRAFTING: "drafting",
  OFFERING: "offering",
  COMMITTING: "committing",
  COOLDOWN: "cooldown",
  // Legacy aliases kept so old call sites do not crash during migration.
  SETUP_ARMING: "observing",
  IDLE_REALTIME_ACTIVE: "watching",
  GENERATION_DISPATCHED: "drafting",
  WAITING_FOR_USER: "offering",
  TAKEOVER: "committing",
});

export const MOTHER_IDLE_EVENTS = Object.freeze({
  IDLE_WINDOW_ELAPSED: "idle_window_elapsed",
  INTENT_INFERRED: "intent_inferred",
  CONFIRM: "confirm",
  REJECT: "reject",
  GENERATION_DISPATCHED: "generation_dispatched",
  DRAFT_READY: "draft_ready",
  DEPLOY: "deploy",
  COMMIT_DONE: "commit_done",
  COOLDOWN_DONE: "cooldown_done",
  USER_INTERACTION: "user_interaction",
  DISQUALIFY: "disqualify",
  RESET: "reset",
  // Legacy aliases.
  GENERATION_INSERTED: "draft_ready",
  GENERATION_FAILED: "reject",
  USER_RESPONSE_TIMEOUT: "deploy",
});

const STATE_VALUES = new Set(Object.values(MOTHER_IDLE_STATES));

const TRANSITIONS = Object.freeze({
  [MOTHER_IDLE_STATES.OBSERVING]: Object.freeze({
    [MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED]: MOTHER_IDLE_STATES.WATCHING,
  }),
  [MOTHER_IDLE_STATES.WATCHING]: Object.freeze({
    [MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED]: MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING,
  }),
  [MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING]: Object.freeze({
    [MOTHER_IDLE_EVENTS.INTENT_INFERRED]: MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING,
    [MOTHER_IDLE_EVENTS.CONFIRM]: MOTHER_IDLE_STATES.DRAFTING,
    [MOTHER_IDLE_EVENTS.REJECT]: MOTHER_IDLE_STATES.COOLDOWN,
    [MOTHER_IDLE_EVENTS.GENERATION_DISPATCHED]: MOTHER_IDLE_STATES.DRAFTING,
  }),
  [MOTHER_IDLE_STATES.DRAFTING]: Object.freeze({
    [MOTHER_IDLE_EVENTS.DRAFT_READY]: MOTHER_IDLE_STATES.OFFERING,
    [MOTHER_IDLE_EVENTS.REJECT]: MOTHER_IDLE_STATES.COOLDOWN,
  }),
  [MOTHER_IDLE_STATES.OFFERING]: Object.freeze({
    [MOTHER_IDLE_EVENTS.DEPLOY]: MOTHER_IDLE_STATES.COMMITTING,
    [MOTHER_IDLE_EVENTS.REJECT]: MOTHER_IDLE_STATES.COOLDOWN,
  }),
  [MOTHER_IDLE_STATES.COMMITTING]: Object.freeze({
    [MOTHER_IDLE_EVENTS.COMMIT_DONE]: MOTHER_IDLE_STATES.COOLDOWN,
  }),
  [MOTHER_IDLE_STATES.COOLDOWN]: Object.freeze({
    [MOTHER_IDLE_EVENTS.COOLDOWN_DONE]: MOTHER_IDLE_STATES.OBSERVING,
  }),
});

const RESET_EVENTS = new Set([
  MOTHER_IDLE_EVENTS.USER_INTERACTION,
  MOTHER_IDLE_EVENTS.DISQUALIFY,
  MOTHER_IDLE_EVENTS.RESET,
]);

export function motherIdleInitialState() {
  return MOTHER_IDLE_STATES.OBSERVING;
}

export function isMotherIdleState(value) {
  return STATE_VALUES.has(String(value || ""));
}

export function motherIdleTransition(currentState, eventName) {
  const current = isMotherIdleState(currentState) ? currentState : motherIdleInitialState();
  const event = String(eventName || "").trim();
  if (!event) return current;
  if (RESET_EVENTS.has(event)) return MOTHER_IDLE_STATES.OBSERVING;
  const next = TRANSITIONS[current]?.[event];
  return next || current;
}

export function motherIdleUsesRealtimeVisual(stateName) {
  // Realtime pulse only during watching.
  return stateName === MOTHER_IDLE_STATES.WATCHING;
}
