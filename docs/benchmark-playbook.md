# Benchmark Playbook

Use this playbook when comparing Brood runs in a repeatable way.

## Keep the same things fixed

- the task or scenario
- the input images
- the model or provider settings
- the success checks you care about

## Record for each run

| Run ID | Scenario | Inputs | Tools used | Model(s) | Latency | Notes |
|---|---|---|---|---|---|---|
| `run-...` | `two-image-dna-apply` | 2 images | `Extract DNA`, `Apply DNA` | `...` | `...` | `...` |

## Keep these files

- `events.jsonl`
- key payload files such as `mother_intent_infer-*.json`, `mother_prompt_compile-*.json`, and `mother_generate-*.json`
- output images
- a short summary of what worked and what did not

## Simple review loop

1. Run the same scenario.
2. Save the run ID and artifact links.
3. Compare outputs and timing.
4. Note regressions before changing the baseline.
