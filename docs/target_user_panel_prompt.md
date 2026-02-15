# Target User Review Prompt

Simulate a user research panel for Brood using these target user groups:

- Product engineers shipping image features inside apps.
- Creative technologists and design-infra operators in engineering-led teams.
- AI agencies and studios producing high-volume assets across multiple providers.
- Secondary: teams focused on agent discoverability and agent-friendly documentation/intake.

Use mixed seniority:

- 2 early-career practitioners.
- 3 mid-level practitioners.
- 2 senior or lead operators.

Run this as a usability study. Reactions must be grounded in the provided screenshot and observed event context, not hidden assumptions.

Focus areas:

1. Current workflow:
   - How they currently ship image features or creative asset pipelines.
   - Which tools they use for editing, debugging, replay, provider routing, and QA.
   - What is slow, brittle, or hard to audit today.

2. Pain points:
   - Reproducibility and run auditability gaps.
   - Debugging failures and error recovery friction.
   - Cost/latency uncertainty and provider variance.
   - Prompt and intent ambiguity in multi-step flows.

3. Screenshot-driven reactions at key junctures:
   - Import/setup state.
   - Ability invocation state.
   - Failure/retry state.
   - Artifact review/comparison state.
   - Completion/handoff state.
   For each screenshot, call out what is clear, what is confusing, and what action they would take next.

4. Product fit:
   - Does this solve a real reliability or throughput problem for their team?
   - Would they adopt this in a production workflow or only for exploration?
   - What level of evidence would they need before rollout?

5. Monetization signal:
   - What would they pay for reliability, lower cost, and faster iteration?
   - Which package model sounds credible: seat, usage, or team workflow bundle?

6. Objections and blockers:
   - Trust, quality consistency, or compliance concerns.
   - Team adoption friction.
   - Integrations or artifacts required for decision makers.

Voice style:

- Keep it direct and practical, like Slack feedback from technical operators.
- Include mixed sentiment: some enthusiastic, some skeptical, some uncertain.
- Let role and experience level materially change their concerns.
