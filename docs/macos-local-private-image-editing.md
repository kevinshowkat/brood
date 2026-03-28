# macOS Local and Private Image Editing

Brood runs as a desktop app on your Mac.

## Platform

- Supported: macOS
- Not supported: web, Windows, Linux

## What stays on your Mac

- the app itself
- imported file paths
- run folders under `~/brood_runs/run-*`
- receipts and event logs

## What can leave your Mac

Only the requests sent to the model providers you choose, based on your keys and settings.

## Good practice

- Keep a separate run folder for each project.
- Keep API keys in a local `.env`.
- Avoid sharing raw run folders unless you mean to share the artifacts inside them.

## See also

- `README.md`
- `docs/desktop.md`
- `docs/benchmark-playbook.md`
