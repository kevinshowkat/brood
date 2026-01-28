# Param Forge Prompt Catalog

This file centralizes the core prompt templates used by Param Forge. It is intended to make it easy for independent model tinkerers to audit and tune prompt behavior.

All prompt templates live in `scripts/param_forge.py` unless otherwise noted.

## Default generation prompt
Source: `FIXED_PROMPT` (`scripts/param_forge.py`)

```
Generate an image of a California brown pelican riding a bicycle. The bicycle must have spokes and a correctly shaped bicycle frame. The pelican must have its characteristic large pouch, and there should be a clear indication of feathers. The pelican must clearly be pedaling the bicycle. The image should show the full breeding plumage of the Californian brown pelican.
```

## Receipt analysis prompt (full ADH/UNSET/COST/REC)
Source: `_build_receipt_analysis_prompt`

Template (with placeholders):

```
Simulate many runs of this prompt given the image attached with bleeding-edge vision analysis. Respond with EXACTLY four lines labeled ADH, UNSET, COST, REC, then a <setting_json> block. No tables, no markdown, no bullet points.
ADH: brief prompt adherence summary (1 sentence), comparing the image to the prompt as written.
UNSET: list 2–4 most important unset params, given the user's selected goals.
COST: estimated USD cost per 1K images for this provider/model (short).
REC: 1–3 unconventional recommendations aligned to user goals. If speed is a priority, you may suggest unconventional levers (e.g., output format/filetype, compression, or size tradeoffs) in addition to standard settings. Prefer changes likely to result in a 10x improvement to the metrics attached to the user's stated goals (avoid tiny deltas like steps 20→30); think big and unconventional when it helps meet the goals.
You have at most {max_rounds} total rounds. This is round {current_round}; {remaining_rounds} round(s) remain after this. Plan a coherent testing path and avoid flip-flopping settings (e.g., jpeg→png→jpeg) unless there's a strong reason.

Target prompt:
{target_prompt}

Explicitly set in the flow:
{explicit_lines}

User goals (multi-select): {goals_line}
If the user selected 'maximize quality of render', treat this as an optimization problem: prioritize maximizing prompt adherence and LLM-rated image quality, even if it increases cost/time. However, if the user also selected 'minimize cost of render' or 'minimize time to render', those goals take precedence and quality becomes secondary.
If the user selected 'maximize LLM retrieval score', prioritize legibility, captionability, and retrieval-focused clarity even if aesthetic quality softens, unless cost/time goals are selected.
User notes: {notes_line}

{web_search_text}{call_path_text}{history_block}{model_block}
Allowed settings for recommendations (API settings for this model): {allowed_line}
Do NOT recommend or list settings outside the allowed list.
Model changes must stay within the same provider and use the listed model options.
Use setting_target='provider_options' for provider-specific options, and setting_target='request' for top-level settings like {top_level_hint}.

At the end, output a JSON array (max 3 items) wrapped in <setting_json>...</setting_json> with objects that include keys: setting_name, setting_value, setting_target, rationale. If no safe recommendation, output an empty array.

Receipt summary JSON:
{summary_json}
```

Notes on dynamic inserts:
- `{web_search_text}` is included only when web search is enabled.
- `{call_path_text}` is included only for OpenAI providers (explains `use_responses`).
- `{history_block}` and `{model_block}` are optional, based on prior rounds and model list.

## Recommendation-only prompt (JSON only)
Source: `_build_recommendation_only_prompt`

Template (with placeholders):

```
Simulate many runs of this prompt given the image attached with bleeding-edge vision analysis. Based on the receipt summary, recommend 1–3 API setting changes to improve prompt adherence. Only choose from the allowed settings list. Output ONLY a JSON array wrapped in <setting_json>...</setting_json> with objects that include keys: setting_name, setting_value, setting_target, rationale. If no safe recommendation, output an empty array.

Provider: {provider}
Model: {model_label}
User goals (multi-select): {goals_line}
If the user selected 'maximize quality of render', treat this as an optimization problem: prioritize maximizing prompt adherence and LLM-rated image quality, even if it increases cost/time. However, if the user also selected 'minimize cost of render' or 'minimize time to render', those goals take precedence and quality becomes secondary.
If the user selected 'maximize LLM retrieval score', prioritize legibility, captionability, and retrieval-focused clarity even if aesthetic quality softens, unless cost/time goals are selected.
User notes: {notes_line}
{web_search_text}{call_path_text}{history_block}{model_block}
If speed is a priority, consider unconventional levers (e.g., output format/filetype, compression, or size tradeoffs) but still choose from the allowed list. Prefer changes likely to result in a 10x improvement to the metrics attached to the user's stated goals (avoid tiny deltas like steps 20→30); think big and unconventional when it helps meet the goals.
If cost/time goals are selected, treat them as primary and only pursue quality improvements that do not materially worsen cost/time.
You have at most {max_rounds} total rounds. This is round {current_round}; {remaining_rounds} round(s) remain after this. Plan a coherent testing path and avoid flip-flopping settings unless there's a strong reason.
Model changes must stay within the same provider and use the listed model options.
Use setting_target='provider_options' for provider-specific options, and setting_target='request' for top-level settings like {top_level_hint}.
Allowed settings: {allowed_line}
Do NOT recommend or list settings outside the allowed list.

Receipt summary JSON:
{summary_json}
```

## Council chair synthesis instructions
Source: `_call_council` (default chair instructions)

- You are the council chair. Synthesize the best final response.
- Follow the original instructions EXACTLY: output ONLY the final response in the required 4-line format plus <setting_json>.
- Prefer changes likely to result in a 10x improvement to the metrics attached to the user's stated goals.
- Avoid tiny deltas (e.g., steps 20→30) unless they unlock a major improvement.
- Honor the user goals.

## Adherence/quality scoring prompt
Source: `_score_image_with_council`

```
Given the prompt and the generated image, evaluate how a group of appropriate judges would rate the adherence of the generated image to the given prompt and the quality of the image. Return ONLY JSON like: {"adherence": 0-100, "quality": 0-100}. Use integers. No extra text.

Prompt:
{prompt}
```

## Retrieval scoring prompt
Source: `_build_retrieval_prompt`

```
You are evaluating an image for LLM-mediated retrieval and summarization. Do NOT judge beauty. Focus on clarity, extractability, and usefulness.

Score each axis 0-100 (integers):
- text_legibility
- captionability
- entity_richness
- information_density
- semantic_novelty
- trust_signals
- platform_fitness

Then compute retrieval_score as a weighted average using weights:
text_legibility 0.20, captionability 0.15, entity_richness 0.15, information_density 0.15, semantic_novelty 0.10, trust_signals 0.15, platform_fitness 0.10.

Return JSON with keys: retrieval_score (int), axes (object with axis scores), alt_text_120, caption_280, ocr_text, entities, claims, questions_answered, flags.
Axes object keys: text_legibility, captionability, entity_richness, information_density, semantic_novelty, trust_signals, platform_fitness.

Also output a consumption packet:
- alt_text_120 (<=120 chars)
- caption_280 (<=280 chars)
- ocr_text (best effort; empty if none)
- entities (<=12 items)
- claims (<=5 objects {text, confidence 0-1})
- questions_answered (<=5 items)
- flags (<=6 items from: unreadable_text, low_contrast_text, ambiguous_subject, cluttered_layout, artifacted_content, low_trust_layout, thumbnail_failure)

Return ONLY JSON wrapped in <retrieval_json>...</retrieval_json>.

Prompt:
{prompt}
```

Retrieval chair instructions (only for retrieval scoring):
- You are the council chair. Synthesize a single JSON response.
- Output ONLY <retrieval_json>...</retrieval_json>. No extra text.

## Analysis compression prompt
Source: `_compress_analysis_to_limit`

```
Shorten the content to <= {limit} characters total, preserving the four lines labeled ADH/UNSET/COST/REC and the <setting_json>...</setting_json> block. Do not add new content. Keep the JSON valid and unchanged if possible.
```

Second pass (if still too long):

```
Tighten to <= {limit} chars total. Preserve ADH/UNSET/COST/REC labels and <setting_json> block.
```
