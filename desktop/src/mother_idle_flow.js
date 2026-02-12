export const MOTHER_IDLE_STATES = Object.freeze({
  SETUP_ARMING: "setup_arming",
  IDLE_REALTIME_ACTIVE: "idle_realtime_active",
  GENERATION_DISPATCHED: "generation_dispatched",
  WAITING_FOR_USER: "waiting_for_user",
  TAKEOVER: "takeover",
});

export const MOTHER_IDLE_EVENTS = Object.freeze({
  IDLE_WINDOW_ELAPSED: "idle_window_elapsed",
  GENERATION_DISPATCHED: "generation_dispatched",
  GENERATION_INSERTED: "generation_inserted",
  GENERATION_FAILED: "generation_failed",
  USER_RESPONSE_TIMEOUT: "user_response_timeout",
  USER_INTERACTION: "user_interaction",
  DISQUALIFY: "disqualify",
  RESET: "reset",
});

const STATE_VALUES = new Set(Object.values(MOTHER_IDLE_STATES));

const TRANSITIONS = Object.freeze({
  [MOTHER_IDLE_STATES.SETUP_ARMING]: Object.freeze({
    [MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED]: MOTHER_IDLE_STATES.IDLE_REALTIME_ACTIVE,
  }),
  [MOTHER_IDLE_STATES.IDLE_REALTIME_ACTIVE]: Object.freeze({
    [MOTHER_IDLE_EVENTS.GENERATION_DISPATCHED]: MOTHER_IDLE_STATES.GENERATION_DISPATCHED,
    [MOTHER_IDLE_EVENTS.GENERATION_FAILED]: MOTHER_IDLE_STATES.SETUP_ARMING,
  }),
  [MOTHER_IDLE_STATES.GENERATION_DISPATCHED]: Object.freeze({
    [MOTHER_IDLE_EVENTS.GENERATION_INSERTED]: MOTHER_IDLE_STATES.WAITING_FOR_USER,
    [MOTHER_IDLE_EVENTS.GENERATION_FAILED]: MOTHER_IDLE_STATES.SETUP_ARMING,
  }),
  [MOTHER_IDLE_STATES.WAITING_FOR_USER]: Object.freeze({
    [MOTHER_IDLE_EVENTS.USER_RESPONSE_TIMEOUT]: MOTHER_IDLE_STATES.TAKEOVER,
  }),
  [MOTHER_IDLE_STATES.TAKEOVER]: Object.freeze({}),
});

const RESET_EVENTS = new Set([
  MOTHER_IDLE_EVENTS.USER_INTERACTION,
  MOTHER_IDLE_EVENTS.DISQUALIFY,
  MOTHER_IDLE_EVENTS.RESET,
]);

export function motherIdleInitialState() {
  return MOTHER_IDLE_STATES.SETUP_ARMING;
}

export function isMotherIdleState(value) {
  return STATE_VALUES.has(String(value || ""));
}

export function motherIdleTransition(currentState, eventName) {
  const current = isMotherIdleState(currentState) ? currentState : motherIdleInitialState();
  const event = String(eventName || "").trim();
  if (!event) return current;
  if (RESET_EVENTS.has(event)) return MOTHER_IDLE_STATES.SETUP_ARMING;
  const next = TRANSITIONS[current]?.[event];
  return next || current;
}

export function motherIdleUsesRealtimeVisual(stateName) {
  return (
    stateName === MOTHER_IDLE_STATES.IDLE_REALTIME_ACTIVE ||
    stateName === MOTHER_IDLE_STATES.GENERATION_DISPATCHED
  );
}
