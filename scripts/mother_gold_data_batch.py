#!/usr/bin/env python3
"""Generate Mother proposal outcomes and capture qualitative gold-data scores.

Expected seed image layout:
  images/gold_data_seed/people
  images/gold_data_seed/objects
  images/gold_data_seed/places
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import random
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TARGET_PHRASE = "stunningly awe-inspiring and tearfully joyous"
DEFAULT_DATASET_ROOT = "images/gold_data_seed"
DEFAULT_OUTPUT_ROOT = "outputs/mother_gold_data"
DEFAULT_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
DEFAULT_MODES = ["hybridize", "mythologize", "transcend"]

MODE_TO_SUMMARY: dict[str, str] = {
    "amplify": "Fuse motion and comfort into something cinematic.",
    "transcend": "Turn momentum into a sculptural interior moment.",
    "destabilize": "Bend familiar structure into a charged visual tension.",
    "purify": "Dissolve room geometry into fluid light and calm.",
    "hybridize": "Fuse all references into one striking visual world.",
    "mythologize": "Recast the scene as mythic visual storytelling.",
    "monumentalize": "Elevate the composition into a monumental hero frame.",
    "fracture": "Split form and light into a deliberate expressive fracture.",
    "romanticize": "Soften the scene into intimate emotional warmth.",
    "alienate": "Shift the familiar into a precise uncanny atmosphere.",
}


@dataclass(frozen=True)
class Triplet:
    people: Path
    objects: Path
    places: Path

    def as_paths(self) -> list[Path]:
        return [self.people, self.objects, self.places]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Batch-generate proposal outcomes for Mother and write a CSV that can be used "
            "as qualitative gold data."
        )
    )
    parser.add_argument(
        "--dataset-root",
        default=DEFAULT_DATASET_ROOT,
        help=f"Dataset root (default: {DEFAULT_DATASET_ROOT}).",
    )
    parser.add_argument(
        "--out-root",
        default=DEFAULT_OUTPUT_ROOT,
        help=f"Output root (default: {DEFAULT_OUTPUT_ROOT}).",
    )
    parser.add_argument(
        "--sets",
        type=int,
        default=8,
        help="How many triplets to sample (default: 8).",
    )
    parser.add_argument(
        "--modes",
        default=",".join(DEFAULT_MODES),
        help=(
            "Comma-separated transformation modes to evaluate per triplet "
            f"(default: {','.join(DEFAULT_MODES)})."
        ),
    )
    parser.add_argument(
        "--image-model",
        default="",
        help=(
            "Optional image model override passed to brood-rs chat "
            "(example: gpt-image-1, gemini-2.5-flash-image)."
        ),
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=7,
        help="Random seed for repeatable triplet sampling (default: 7).",
    )
    parser.add_argument(
        "--interactive-score",
        action="store_true",
        help="Prompt for score + notes after each generated outcome.",
    )
    parser.add_argument(
        "--open-preview",
        action="store_true",
        help="On macOS, open each generated image before score prompt.",
    )
    parser.add_argument(
        "--init-dirs",
        action="store_true",
        help="Create expected dataset directories and exit.",
    )
    parser.add_argument(
        "--brood-bin",
        default="",
        help=(
            "Optional path to brood-rs binary. "
            "If omitted, script uses cargo run -p brood-cli."
        ),
    )
    return parser.parse_args()


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return (root / path).resolve()


def collect_images(path: Path) -> list[Path]:
    if not path.exists():
        return []
    images: list[Path] = []
    for child in sorted(path.iterdir()):
        if not child.is_file():
            continue
        if child.suffix.lower() not in DEFAULT_IMAGE_EXTS:
            continue
        images.append(child.resolve())
    return images


def ensure_dataset_dirs(dataset_root: Path) -> None:
    for name in ("people", "objects", "places"):
        (dataset_root / name).mkdir(parents=True, exist_ok=True)


def load_category_pool(dataset_root: Path) -> dict[str, list[Path]]:
    pool = {
        "people": collect_images(dataset_root / "people"),
        "objects": collect_images(dataset_root / "objects"),
        "places": collect_images(dataset_root / "places"),
    }
    missing = [name for name, rows in pool.items() if not rows]
    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(
            f"Missing images for category: {joined}. "
            f"Put files under {dataset_root}/people, {dataset_root}/objects, {dataset_root}/places."
        )
    return pool


def sample_triplets(pool: dict[str, list[Path]], count: int, seed: int) -> list[Triplet]:
    rng = random.Random(seed)
    out: list[Triplet] = []
    for _ in range(count):
        pick = None
        for _attempt in range(24):
            people = rng.choice(pool["people"])
            objects = rng.choice(pool["objects"])
            places = rng.choice(pool["places"])
            candidate = Triplet(people=people, objects=objects, places=places)
            if len({str(path) for path in candidate.as_paths()}) == 3:
                pick = candidate
                break
        if pick is None:
            pick = Triplet(
                people=rng.choice(pool["people"]),
                objects=rng.choice(pool["objects"]),
                places=rng.choice(pool["places"]),
            )
        out.append(pick)
    return out


def parse_modes(raw: str) -> list[str]:
    modes: list[str] = []
    for chunk in raw.split(","):
        mode = chunk.strip().lower()
        if not mode:
            continue
        if mode not in MODE_TO_SUMMARY:
            valid = ", ".join(sorted(MODE_TO_SUMMARY.keys()))
            raise RuntimeError(f"Unknown mode '{mode}'. Valid modes: {valid}")
        if mode not in modes:
            modes.append(mode)
    if not modes:
        raise RuntimeError("At least one transformation mode is required.")
    return modes


def build_prompt(mode: str, proposal_summary: str) -> str:
    return (
        f"Create one {TARGET_PHRASE} image. "
        f"Proposal mode: {mode}. "
        f"Proposal summary: {proposal_summary} "
        "Fuse the references into an intentional, surprising single image. "
        "No split-screen collage. No text overlays."
    )


def build_payload(
    triplet: Triplet,
    mode: str,
    proposal_summary: str,
    set_id: str,
    run_idx: int,
) -> dict[str, Any]:
    source_images = [str(path) for path in triplet.as_paths()]
    prompt = build_prompt(mode, proposal_summary)
    return {
        "schema": "brood.mother.generate.v2",
        "action_version": run_idx,
        "intent_id": f"gold-{set_id}-{mode}",
        "creative_directive": TARGET_PHRASE,
        "transformation_mode": mode,
        "prompt": prompt,
        "positive_prompt": prompt,
        "negative_prompt": (
            "No split-screen collage. No text overlays. No watermark. "
            "No accidental double exposure."
        ),
        "init_image": source_images[0],
        "reference_images": source_images[1:],
        "source_images": source_images,
        "generation_params": {
            "seed_strategy": "random",
            "transformation_mode": mode,
        },
        "intent": {
            "intent_id": f"gold-{set_id}-{mode}",
            "transformation_mode": mode,
            "summary": proposal_summary,
            "target_ids": ["people"],
            "reference_ids": ["objects", "places"],
        },
    }


def parse_last_artifact(events_path: Path, run_dir: Path) -> Path | None:
    if events_path.exists():
        last_path: Path | None = None
        for raw in events_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if str(row.get("type", "")).strip() != "artifact_created":
                continue
            image_path = str(row.get("image_path", "")).strip()
            if not image_path:
                continue
            candidate = Path(image_path)
            if candidate.exists():
                last_path = candidate.resolve()
        if last_path is not None:
            return last_path
    artifacts = sorted(run_dir.glob("artifact-*"))
    if artifacts:
        return artifacts[-1].resolve()
    return None


def run_generation(
    repo_root: Path,
    run_dir: Path,
    payload_path: Path,
    image_model: str,
    brood_bin: Path,
) -> tuple[int, str, str]:
    run_dir.mkdir(parents=True, exist_ok=True)
    events_path = run_dir / "events.jsonl"

    cmd = [
        str(brood_bin),
        "chat",
        "--out",
        str(run_dir),
        "--events",
        str(events_path),
    ]
    if image_model.strip():
        cmd.extend(["--image-model", image_model.strip()])

    command_line = f"/mother_generate {shlex.quote(str(payload_path))}\n"
    result = subprocess.run(
        cmd,
        cwd=repo_root / "rust_engine",
        input=command_line,
        text=True,
        capture_output=True,
        check=False,
    )
    return result.returncode, result.stdout, result.stderr


def maybe_open_preview(path: Path, enabled: bool) -> None:
    if not enabled:
        return
    if sys.platform != "darwin":
        return
    subprocess.run(["open", str(path)], check=False)


def prompt_for_score(image_path: Path, mode: str, set_id: str) -> tuple[str, str]:
    print("")
    print(f"[RATE] {set_id} / {mode}")
    print(f"image: {image_path}")
    print(f"Question: How {TARGET_PHRASE} does this feel? (0-10)")
    score = input("score (blank=skip): ").strip()
    notes = input("notes (optional): ").strip()
    return score, notes


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def ensure_csv_header(path: Path) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "batch_id",
                "set_id",
                "proposal_mode",
                "proposal_summary",
                "image_people",
                "image_object",
                "image_place",
                "payload_path",
                "run_dir",
                "outcome_path",
                "status",
                "score_0_10",
                "notes",
                "created_at_utc",
            ]
        )


def append_csv_row(path: Path, row: list[str]) -> None:
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(row)


def prepare_brood_bin(repo_root: Path, raw: str) -> Path:
    if raw.strip():
        path = Path(raw).expanduser().resolve()
        if not path.exists():
            raise RuntimeError(f"--brood-bin not found: {path}")
        return path
    rust_engine_dir = repo_root / "rust_engine"
    build_cmd = ["cargo", "build", "-p", "brood-cli"]
    build = subprocess.run(
        build_cmd,
        cwd=rust_engine_dir,
        text=True,
        capture_output=True,
        check=False,
    )
    if build.returncode != 0:
        raise RuntimeError(
            "Failed to build brood-rs.\n"
            f"stdout:\n{build.stdout}\n"
            f"stderr:\n{build.stderr}"
        )
    binary = rust_engine_dir / "target" / "debug" / "brood-rs"
    if not binary.exists():
        raise RuntimeError(f"Expected binary not found after build: {binary}")
    return binary


def main() -> int:
    args = parse_args()
    repo_root = repo_root_from_script()
    dataset_root = resolve_path(repo_root, args.dataset_root)
    out_root = resolve_path(repo_root, args.out_root)

    if args.init_dirs:
        ensure_dataset_dirs(dataset_root)
        print(f"Created dataset directories under: {dataset_root}")
        print(f"- {dataset_root / 'people'}")
        print(f"- {dataset_root / 'objects'}")
        print(f"- {dataset_root / 'places'}")
        return 0

    ensure_dataset_dirs(dataset_root)
    modes = parse_modes(args.modes)
    pool = load_category_pool(dataset_root)
    triplets = sample_triplets(pool, max(1, int(args.sets)), seed=int(args.seed))
    brood_bin = prepare_brood_bin(repo_root, args.brood_bin)

    batch_id = utc_now().strftime("%Y%m%d_%H%M%S_gold")
    batch_dir = out_root / batch_id
    payload_dir = batch_dir / "payloads"
    runs_dir = batch_dir / "runs"
    logs_dir = batch_dir / "logs"
    csv_path = batch_dir / "gold_scores.csv"
    ensure_csv_header(csv_path)

    write_json(
        batch_dir / "batch_manifest.json",
        {
            "schema": "brood.mother.gold_data_batch.v1",
            "batch_id": batch_id,
            "target_phrase": TARGET_PHRASE,
            "dataset_root": str(dataset_root),
            "modes": modes,
            "sets": len(triplets),
            "image_model": args.image_model.strip() or None,
            "seed": int(args.seed),
            "created_at_utc": utc_now().isoformat(),
        },
    )

    total = len(triplets) * len(modes)
    current = 0
    for idx, triplet in enumerate(triplets, start=1):
        set_id = f"set-{idx:03d}"
        for mode in modes:
            current += 1
            proposal_summary = MODE_TO_SUMMARY[mode]
            run_key = f"{set_id}--{mode}"
            run_dir = runs_dir / run_key
            payload_path = payload_dir / f"{run_key}.json"
            payload = build_payload(triplet, mode, proposal_summary, set_id, run_idx=current)
            write_json(payload_path, payload)

            print(f"[{current}/{total}] generating {run_key}")
            code, stdout, stderr = run_generation(
                repo_root=repo_root,
                run_dir=run_dir,
                payload_path=payload_path,
                image_model=args.image_model,
                brood_bin=brood_bin,
            )
            logs_dir.mkdir(parents=True, exist_ok=True)
            (logs_dir / f"{run_key}.stdout.log").write_text(stdout or "", encoding="utf-8")
            (logs_dir / f"{run_key}.stderr.log").write_text(stderr or "", encoding="utf-8")

            artifact = parse_last_artifact(run_dir / "events.jsonl", run_dir)
            status = "ok" if code == 0 and artifact is not None else "failed"
            score = ""
            notes = ""
            if status == "ok" and args.interactive_score and artifact is not None:
                maybe_open_preview(artifact, enabled=bool(args.open_preview))
                score, notes = prompt_for_score(artifact, mode=mode, set_id=set_id)

            append_csv_row(
                csv_path,
                [
                    batch_id,
                    set_id,
                    mode,
                    proposal_summary,
                    str(triplet.people),
                    str(triplet.objects),
                    str(triplet.places),
                    str(payload_path),
                    str(run_dir),
                    str(artifact) if artifact is not None else "",
                    status,
                    score,
                    notes,
                    utc_now().isoformat(),
                ],
            )

            if status != "ok":
                print(f"  failed: check {logs_dir / f'{run_key}.stderr.log'}")

    print("")
    print(f"Done. Batch: {batch_id}")
    print(f"Scores CSV: {csv_path}")
    print(f"Batch manifest: {batch_dir / 'batch_manifest.json'}")
    print(f"Run logs: {logs_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
