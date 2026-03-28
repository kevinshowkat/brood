# Releasing Brood (macOS)

Brood ships through GitHub Releases.

When a tag such as `v0.1.0` is pushed, GitHub Actions:
- runs the macOS smoke install workflow
- builds the universal macOS app
- stages the native Rust engine binary at `desktop/src-tauri/resources/brood-rs`
- signs and notarizes the app
- uploads a DMG to a draft GitHub Release
- updates `kevinshowkat/homebrew-brood` after the release is published

## Required repo secrets

Set these in the GitHub repository before cutting releases:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`
- `BROOD_RELEASE_TOKEN`
- `BROOD_HOMEBREW_TAP_TOKEN`

## Release steps

1. Update the version in:
   - `desktop/package.json`
   - `desktop/src-tauri/tauri.conf.json`
   - `desktop/src-tauri/Cargo.toml`
2. Update `CHANGELOG.md`.
3. Commit the release changes.
4. Create and push a tag:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
5. Wait for the `publish` workflow to finish.
6. Publish the draft release on GitHub.
7. Confirm the Homebrew tap update completed.

## Checks

- The release workflow expects the tag to match the desktop app version.
- `main` requires the `smoke-install` status check.
- The smoke workflow lives in `.github/workflows/desktop-clean-machine-smoke.yml`.

## Troubleshooting

If notarization fails for `resources/brood-rs`, confirm:
- the signing identity was detected
- `scripts/stage_rust_engine_binary.sh` ran
- the release commit includes the binary signing step
