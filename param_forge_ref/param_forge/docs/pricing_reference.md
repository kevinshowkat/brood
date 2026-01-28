# Image Pricing Reference (PARAM FORGE)

Last verified: 2026-01-04

This file summarizes current per-image pricing for providers/models used by PARAM FORGE, so experimenters can budget sweeps without guesswork.
Pricing can change; re-verify before production billing.

## OpenAI (GPT Image)
Sources:
- https://platform.openai.com/docs/models/gpt-image-1
- https://platform.openai.com/docs/models/gpt-image-1.5
- https://platform.openai.com/docs/models/gpt-image-1-mini

GPT Image 1 (per image, USD)
- 1024x1024: Low $0.011, Medium $0.042, High $0.167
- 1024x1536: Low $0.016, Medium $0.063, High $0.25
- 1536x1024: Low $0.016, Medium $0.063, High $0.25

GPT Image 1.5 (per image, USD)
- 1024x1024: Low $0.009, Medium $0.034, High $0.133
- 1024x1536: Low $0.013, Medium $0.05, High $0.20
- 1536x1024: Low $0.013, Medium $0.05, High $0.20

GPT Image 1 Mini (per image, USD)
- 1024x1024: Low $0.005, Medium $0.011, High $0.036
- 1024x1536: Low $0.006, Medium $0.015, High $0.052
- 1536x1024: Low $0.006, Medium $0.015, High $0.052

## Google Gemini / Imagen
Source: https://ai.google.dev/pricing

Gemini 2.5 Flash Image (gemini-2.5-flash-image)
- Standard: $0.039 per image
- Batch: $0.0195 per image

Gemini 3 Pro Image Preview (gemini-3-pro-image-preview)
- Standard: $0.134 per 1K/2K image, $0.24 per 4K image
- Batch: $0.067 per 1K/2K image, $0.12 per 4K image

Imagen 4
- Fast: $0.02 per image
- Standard: $0.04 per image
- Ultra: $0.06 per image

Imagen 3
- $0.03 per image

## Black Forest Labs (FLUX)
Source: https://docs.bfl.ai/quick_start/pricing

Pricing uses credits: 1 credit = $0.01 USD.

FLUX.2 (megapixel-based pricing, varies by resolution)
- FLUX.2 [pro]: from $0.03 (text-to-image), from $0.045 (image editing)
- FLUX.2 [flex]: from $0.06 (text-to-image), from $0.12 (image editing)
- FLUX.2 [dev]: free (non-commercial)

FLUX.1 models (per image)
- FLUX.1 Kontext [pro]: 4 credits ($0.04)
- FLUX.1 Kontext [max]: 8 credits ($0.08)
- FLUX1.1 [pro]: 4 credits ($0.04)
- FLUX1.1 [pro] Ultra: 6 credits ($0.06)
- FLUX1.1 [pro] Raw: 6 credits ($0.06)
- FLUX.1 Fill [pro]: 5 credits ($0.05)
