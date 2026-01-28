#!/usr/bin/env bash
set -euo pipefail

python -m pip install --upgrade pyinstaller
pyinstaller -F -n brood brood_engine/cli.py
