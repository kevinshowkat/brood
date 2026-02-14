# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog (https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
- TBD

## [0.1.2] - 2026-02-14
- Fix single-canvas pan tap detection so tap-to-open Mother wheel remains reliable after bridge output flows.
- Restore add-photo visibility after single-view bridge flows by returning to multi canvas when multiple images are present.
- Ensure Mother draft acceptance dispatches only through structured payloads so full canvas image context is included.
- Improve clean-machine smoke DMG selection by choosing the newest artifact by modification time.

## [0.1.1] - 2026-02-13
- Polish Mother proposal/readout UI with panel-native icon states and smoother transitions.
- Fix Mother proposal cycling and intent inference races (including late-event request matching).
- Improve proposal tooltip accuracy by using full intent context.

## [0.1.0] - 2026-02-12
- Initial version.
