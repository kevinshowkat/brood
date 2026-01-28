#!/usr/bin/env bash
set -euo pipefail

cd desktop
npm install
npm run tauri build
