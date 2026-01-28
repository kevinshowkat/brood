Image Generation Harness: Project Context
You are being given access to a codebase for an agentic image generation system. This document explains the vision, what currently exists, and what we need help building toward.

The Vision
A Claude Code / Codex-style harness for image generation. Natural language interface. The user describes what they want; an agent figures out how to achieve it—selecting models, tuning parameters, iterating on results, and learning the user's aesthetic preferences over time.

Three Core Capabilities
1. Agent Loop for API Optimization ✅ (Current Implementation)
What it does: Autonomously adjusts API parameters and model selection to hit user goals like cost, quality, and speed.
The loop:
1. Parse user intent and goal constraints
2. Select model(s) and initial parameters
3. Generate
4. Evaluate result against intent
5. Adjust parameters / model / prompt
6. Repeat until satisfied or budget exhausted
7. Surface best candidates
This is what the attached codebase implements. Review it to understand our current approach, architecture patterns, and how we've structured the agent loop.

2. Aesthetic Memory 🎯 (Goal)
What we want: The system remembers the user's aesthetic preferences across sessions.
Not just "Sarah likes blue"—a rich understanding of:

Color palettes and how they use them (vibrant vs muted, warm vs cool)
Style affinities (photorealistic vs illustrated, clean vs textured)
What they've rejected and why ("too corporate," "too playful")

When the user says "make another one like before" or "you know what I like," the system actually knows.
Key questions we need help with:

How should we represent aesthetic preferences? (embeddings? structured attributes? example-based?)
How do we extract preferences from user feedback and past generations?
How do we inject learned preferences into the generation loop without over-constraining?
How does this integrate with the existing agent loop architecture?
How do we handle preference evolution over time?


3. Natural Language UX 🎯 (Goal)
What we want: A Claude Code / Codex-style interface where users interact via natural language, not parameter forms or prompt templates.
Examples of the UX we're targeting:
> something for the blog post about our Series A, celebratory but not cheesy

> make it warmer, and can we try a version without people?

> actually go back to v2 but with the color palette from v5

> this is just for a slack message, keep it cheap and fast

> remember how we did the Q3 campaign? like that but for winter
The system should:

Understand intent from casual language
Handle iterative refinement ("make it warmer")
Support references to prior work ("like v2," "like the Q3 campaign")
Infer constraints from context ("for a slack message" → low cost, fast)
Feel like talking to a creative collaborator, not operating a tool

Key questions we need help with:

How do we structure the conversational flow and state management?
How do we parse vague creative direction into actionable generation parameters?
How do we handle references to prior versions and sessions?
What's the right feedback loop? (showing candidates, getting reactions, refining)
How does this layer on top of the existing agent loop?


What We Need From You

Review the codebase to understand our current agent loop implementation—its structure, patterns, strengths, and limitations.
Advise on Aesthetic Memory:

How would you extend this architecture to support persistent aesthetic preferences?
What representation/storage approach fits best with what we've built?
Where does preference learning plug into the existing loop?


Advise on Natural Language UX:

What conversational/interface layer would you add on top of this?
How do we bridge casual language to the structured API optimization loop?
What patterns from Claude Code / Codex / similar tools apply here?


Integration Strategy:

How do all three capabilities compose together?
What architectural changes (if any) are needed to support the full vision?
What's the right build order? What depends on what?


Focus on concrete, actionable guidance given what exists in the codebase. We want to extend what we've built, not rebuild from scratch.
