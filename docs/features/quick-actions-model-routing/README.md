# Abilities Model Routing

This note describes how Brood can choose a model per action instead of relying only on the global image model setting.

## User view

- Some actions can temporarily switch to a better-suited model.
- The global setting is restored after the action.

## Current defaults

- fast edit actions prefer `gemini-2.5-flash-image`
- harder edits and multi-image actions prefer `gemini-3-pro-image-preview`

## Main file

- `desktop/src/canvas_app.js`
