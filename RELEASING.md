# Releasing Brood (macOS)

This repo ships via GitHub Releases.

When you push a tag like `v0.1.0`, GitHub Actions will:
- run a remote macOS **clean-machine smoke install** (build DMG, install, launch)
- build a universal macOS app bundle
- code sign it (Developer ID Application)
- notarize it
- attach the signed/notarized `.dmg` to a draft GitHub Release for that tag

Smoke details:
- Workflow: `.github/workflows/desktop-clean-machine-smoke.yml`
- Script: `scripts/macos_clean_machine_smoke.sh`

## One-Time Setup (GitHub Repo Secrets)

Set these secrets in your GitHub repository:

- `APPLE_CERTIFICATE`: Base64-encoded `.p12` containing your **Developer ID Application** certificate.
- `APPLE_CERTIFICATE_PASSWORD`: Password for the `.p12`.
- `APPLE_ID`: Apple ID email used for notarization.
- `APPLE_PASSWORD`: App-specific password (or notarization password) for `APPLE_ID`.
- `APPLE_TEAM_ID`: Your Apple Team ID (example: `JU3DQ69K6R`).

Notes:
- The workflow imports the certificate into a temporary build keychain and auto-detects the `Developer ID Application` identity to use.
- The workflow enforces `tag == v${tauri.conf.json package.version}` to avoid accidental mismatches.

## Cut A Release

1. Update versions (must match):
   - `desktop/package.json` `version`
   - `desktop/src-tauri/tauri.conf.json` `package.version`
   - `desktop/src-tauri/Cargo.toml` `[package].version`
2. Update `CHANGELOG.md`.
3. Commit the changes.
4. Tag and push:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
5. Wait for the `publish` workflow to finish.
6. Publish the draft release on GitHub (or change `releaseDraft` to `false` in the workflow once you're confident).

## Optional: Disposable Remote Mac Snapshot Run

If you use a cloud Mac provider, keep one machine snapshot in a clean state and run:

```bash
git clone <repo-url>
cd brood
npm --prefix desktop ci
npm --prefix desktop run tauri build -- --bundles dmg --ci -v
scripts/macos_clean_machine_smoke.sh
```

Then discard/revert the snapshot. This gives repeatable install confidence without using multiple physical Macs.
