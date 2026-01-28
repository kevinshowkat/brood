# Brood

Brood is a desktop "creative IDE" for image generation with a terminal-like command experience and a live canvas.

## Quickstart (engine)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .[dev]

# Chat loop
brood chat --out /tmp/brood-run --events /tmp/brood-run/events.jsonl

# Single run
brood run --prompt "hero image for Series A" --out /tmp/brood-run

# Recreate flow
brood recreate --reference path/to/image.png --out /tmp/brood-recreate
```

## Desktop app (Tauri)

```bash
cd desktop
npm install
npm run tauri dev
```

Build:

```bash
cd desktop
npm install
npm run tauri build
```

### Desktop usage
- Type commands in the **input field at the bottom of the left pane** and press **Enter** or **Send**.
- Example: `Generate an image of a boat`
- Use the “Try” chips for common prompts and `/help` for slash commands.

## Memory

Enable local memory:

```bash
export BROOD_MEMORY=1
```

## Pricing overrides

Edit `~/.brood/pricing_overrides.json` to override pricing or latency values.

## API keys
- Copy `.env.example` to `.env` and fill in provider keys.
- Supported keys mirror Param Forge: OpenAI, Anthropic, Gemini/Google, Imagen/Vertex, Flux/BFL.
- For OpenAI images, set `OPENAI_API_KEY` (or `OPENAI_API_KEY_BACKUP`).
  Use `/image_model gpt-image-1` in chat or `--image-model gpt-image-1` on the CLI to target OpenAI image models.
  Optional toggles: `OPENAI_IMAGE_USE_RESPONSES=1` (Responses API) and `OPENAI_IMAGE_STREAM=1` (streaming; falls back to non-streaming with a warning).

## Troubleshooting (Desktop)
- **App failed to initialize: Importing binding name ... not found**  
  Ensure Tauri v1 APIs are used. This repo expects `@tauri-apps/api` v1 and the v1 CLI.
- **Images not rendering**  
  Tauri must allow file access under `$HOME/**` (see `desktop/src-tauri/tauri.conf.json`).

## Project layout

- `brood_engine/` core engine and CLI
- `desktop/` Tauri desktop app
- `tests/` pytest suite
- `docs/param_forge_reference.md` Param Forge reference notes
