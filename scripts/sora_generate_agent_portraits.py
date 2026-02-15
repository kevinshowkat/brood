#!/usr/bin/env python3
"""
Generate StarCraft-1-like "agent portrait" videos using the OpenAI Sora API (Sora 2 / Sora 2 Pro).

This script:
  1) Creates a video job via POST /v1/videos (multipart form).
  2) Polls GET /v1/videos/{id} until completed/failed.
  3) Downloads bytes via GET /v1/videos/{id}/content to an .mp4.
  4) Optionally remixes a completed video via POST /v1/videos/{id}/remix to keep character consistency
     between states.
  5) Optionally crops portrait output to a square and/or trims/loops to a target duration (ffmpeg).

Environment:
  - OPENAI_API_KEY (required) or OPENAI_API_KEY_BACKUP
  - Optional: OPENAI_PROJECT_ID, OPENAI_ORG_ID

Examples:
  # Generate both idle+working agent portraits (12s portrait) and crop to square for the UI.
  python scripts/sora_generate_agent_portraits.py --agents all --states both --seconds 12 --crop-square

  # Speed it up by running a few jobs concurrently (watch rate limits / cost).
  python scripts/sora_generate_agent_portraits.py --agents all --states both --parallel 3 --seconds 12 --crop-square --mute

  # Target a 15s looping square clip (API max is 12s, so we loop+trim locally).
  python scripts/sora_generate_agent_portraits.py --agents providers --states both --seconds 12 --target-seconds 15 --crop-square --mute
"""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import re
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_API_BASE = "https://api.openai.com/v1"

# Prompts are designed for portrait output that will often be center-cropped to square in the UI.
MOOD_PHRASE = "stunningly awe-inspiring and joyous"
MOOD_LINE = f"Mood: {MOOD_PHRASE}."
LOOP_LINE = (
    "Perfect loop: last frame == first frame (pose, tools, lighting, background match)."
)

BASE_STYLE_LINE = (
    "Scene: a late-90s RTS unit portrait video, low-res pre-rendered 3D (N64 crunchy), 224x240 feel, dithering, CRT scanlines + VHS noise, 15 fps. "
    "Design: subtle Guillermo del Toro biomech touch (light). "
    "Camera: tight near-square close-up; head+shoulders fill frame; a little negative space on screen-left; a hand/tool may enter at lower-left; single shot. "
    "Pose: camera-facing 3/4 left profile; head+eyes turned to their right (viewer-left/screen-left) the whole time. "
    "Lighting: warm amber from upper-left + cool cyan from lower-left LEDs; glossy highlights; faint cyan HUD reflections. "
    "Background: cockpit console with abstract HUD glow shapes (unreadable) and a clean, unbranded frame. "
    "Character is original. "
    f"{LOOP_LINE} {MOOD_LINE}"
)

IDLE_STATE_LINE = (
    "Action (idle, bored): alive breathing/shoulders; slow blinks; tiny head tilt/nod; in-frame hand/tendril fidget; returns to the start pose."
)

WORKING_STATE_LINE = (
    "Action (working): a looped 2-3 beat work cycle using species-native tools/holograms to build/repair just off-screen to their right "
    "(viewer-left/screen-left); visible hand/tool near lower-left; rhythmic sparks/pulses; returns to the start pose."
)

REMIX_DIRECTIVE_LINE = (
    "Remix from source video: keep the same character, pose, framing, lighting, background, and style. Only change the action below."
)

# Keep remix prompts narrow: one change, same character + framing.
REMIX_GUARDRAILS_LINE = "Keep the HUD glow abstract (unreadable) and the frame clean/unbranded; silent."

# Keep these identity lines exactly reused across states to reduce drift.
AGENT_IDENTITY_LINE: dict[str, str] = {
    "openai": (
        "OpenAI: human commando technician in bulky olive power armor with amber LEDs; grimy heroic face; cigarette at mouth corner."
    ),
    "gemini": (
        "Gemini: noble psionic alien analyst; sleek gold+cobalt armor; luminous eyes; two hovering ocular drones."
    ),
    "flux": (
        "Flux: swarm-grown bioengineer; chitin ridges; tendrils into organic console; biolum sacs; subtle mandibles."
    ),
    "mother": (
        "Mother: broodmother queen; chitin crown/carapace; pulsing sacs; glossy eyes; mandibles; resin/bone console."
    ),
}

AGENT_IDLE_ACTION_LINE: dict[str, str] = {
    "openai": (
        "Bored: slouch+breathe; slow drag+smoke exhale; ash tap; finger drum; tiny head tilt."
    ),
    "gemini": (
        "Bored: blink, micro-sigh, tiny eye-roll; lazy hand trace; idle hologram panes shimmer in Google colors."
    ),
    "flux": (
        "Bored: blink; tendrils coil; mandible click; claw tap leaves faint resin smear."
    ),
    "mother": (
        "Bored regal: slow breath; sacs pulse; mandible click; slight head cant."
    ),
}

AGENT_WORKING_ACTION_LINE: dict[str, str] = {
    "openai": (
        "Weld off-screen to their right: torch/forearm lower-left; bright arc flashes + controlled sparks. Cig stays; quick drag + thin exhale."
    ),
    "gemini": (
        "Psychic hologram work (Google colors: blue/red/yellow/green): projects hard-light planes + abstract glyph-shapes (unreadable) "
        "off-screen to their right. Hands in-frame; holograms brighten, align/merge, resolve, fracture back."
    ),
    "flux": (
        "Alien surgical work off-screen to their right: living micro-scalpel+clamp; precise suture; hands/tools lower-left; antiseptic mist; tiny biolum drip; clinical, bloodless."
    ),
    "mother": (
        "Brood construction off-screen to her right: lays resin ribbon; sacs pulse; seals seam; retracts."
    ),
}


def build_prompt(*, agent: str, state: str, prompt_suffix: str = "") -> str:
    agent = str(agent or "").strip().lower()
    state = str(state or "").strip().lower()
    if agent not in AGENT_IDENTITY_LINE:
        raise KeyError(f"Unknown agent for prompt: {agent}")
    if state not in {"idle", "working"}:
        raise KeyError(f"Unknown state for prompt: {state}")

    identity = AGENT_IDENTITY_LINE[agent]
    if state == "idle":
        action = AGENT_IDLE_ACTION_LINE[agent]
        prompt = f"{BASE_STYLE_LINE} {IDLE_STATE_LINE} {identity} {action}"
    else:
        action = AGENT_WORKING_ACTION_LINE[agent]
        prompt = f"{BASE_STYLE_LINE} {WORKING_STATE_LINE} {identity} {action}"

    suffix = str(prompt_suffix or "").strip()
    if suffix:
        prompt = f"{prompt}\n{suffix}"
    return prompt


def build_remix_prompt(*, agent: str, state: str, prompt_suffix: str = "") -> str:
    # Keep remix prompts narrow: per OpenAI guidance, smaller edits preserve more fidelity/continuity.
    agent = str(agent or "").strip().lower()
    state = str(state or "").strip().lower()
    if state == "idle":
        action = AGENT_IDLE_ACTION_LINE[agent]
        state_line = IDLE_STATE_LINE
    else:
        action = AGENT_WORKING_ACTION_LINE[agent]
        state_line = WORKING_STATE_LINE
    prompt = (
        f"{REMIX_DIRECTIVE_LINE} {REMIX_GUARDRAILS_LINE} "
        f"{state_line} {action} {LOOP_LINE} {MOOD_LINE}"
    )

    suffix = str(prompt_suffix or "").strip()
    if suffix:
        prompt = f"{prompt}\n{suffix}"
    return prompt

AVAILABLE_STATES = ("idle", "working")
PROVIDER_AGENTS = ("openai", "gemini", "flux")
_agents = set(AGENT_IDENTITY_LINE.keys())
if set(AGENT_IDLE_ACTION_LINE.keys()) != _agents or set(AGENT_WORKING_ACTION_LINE.keys()) != _agents:
    raise RuntimeError("Agent prompt sets mismatch between identity/idle/working definitions.")
AVAILABLE_AGENTS = tuple(sorted(_agents))


@dataclass(frozen=True)
class VideoJob:
    id: str
    status: str
    raw: Mapping[str, Any]


def _get_env(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _get_api_key() -> str | None:
    return _get_env("OPENAI_API_KEY") or _get_env("OPENAI_API_KEY_BACKUP")


def _headers(api_key: str) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "brood-sora-agent-portraits/1.0",
    }
    # Optional project/org scoping.
    project = _get_env("OPENAI_PROJECT_ID")
    org = _get_env("OPENAI_ORG_ID")
    if project:
        headers["OpenAI-Project"] = project
    if org:
        headers["OpenAI-Organization"] = org
    return headers


def _read_http_error(exc: HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", errors="replace")
    except Exception:
        raw = str(exc)
    return raw


def _request_json(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: bytes | None = None,
    timeout_s: float = 90.0,
) -> dict[str, Any]:
    req = Request(url, data=body, headers=dict(headers), method=method.upper())
    try:
        with urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        raise RuntimeError(f"OpenAI API error ({exc.code}): {_read_http_error(exc)}") from exc
    except URLError as exc:
        raise RuntimeError(f"OpenAI API request failed: {exc}") from exc
    try:
        return json.loads(raw)
    except Exception:
        return {"raw": raw}


def _request_bytes(
    method: str,
    url: str,
    headers: Mapping[str, str],
    timeout_s: float = 120.0,
) -> bytes:
    req = Request(url, headers=dict(headers), method=method.upper())
    try:
        with urlopen(req, timeout=timeout_s) as resp:
            return resp.read()
    except HTTPError as exc:
        raise RuntimeError(f"OpenAI API error ({exc.code}): {_read_http_error(exc)}") from exc
    except URLError as exc:
        raise RuntimeError(f"OpenAI API request failed: {exc}") from exc


def _mime_from_path(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    return mime or "application/octet-stream"


def _multipart_form(
    fields: Mapping[str, str],
    files: Mapping[str, tuple[str, bytes, str]],
) -> tuple[str, bytes]:
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []

    for name, value in fields.items():
        parts.append(f"--{boundary}\r\n".encode("utf-8"))
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        parts.append(str(value).encode("utf-8"))
        parts.append(b"\r\n")

    for name, (filename, data, content_type) in files.items():
        parts.append(f"--{boundary}\r\n".encode("utf-8"))
        parts.append(
            (
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
        )
        parts.append(data)
        parts.append(b"\r\n")

    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)
    content_type = f"multipart/form-data; boundary={boundary}"
    return content_type, body


def create_video_job(
    *,
    api_base: str,
    api_key: str,
    model: str,
    prompt: str,
    seconds: int,
    size: str,
    reference_path: Path | None,
    timeout_s: float,
) -> VideoJob:
    fields: dict[str, str] = {
        "model": model,
        "prompt": prompt,
        "seconds": str(seconds),
        "size": size,
    }
    files: dict[str, tuple[str, bytes, str]] = {}
    if reference_path is not None:
        files["input_reference"] = (
            reference_path.name,
            reference_path.read_bytes(),
            _mime_from_path(reference_path),
        )

    content_type, body = _multipart_form(fields, files)
    headers = _headers(api_key)
    headers["Content-Type"] = content_type
    resp = _request_json(
        "POST",
        f"{api_base.rstrip('/')}/videos",
        headers,
        body=body,
        timeout_s=timeout_s,
    )
    vid = str(resp.get("id") or "")
    if not vid:
        raise RuntimeError(f"Video create response missing id: {resp}")
    return VideoJob(id=vid, status=str(resp.get("status") or "unknown"), raw=resp)


def remix_video_job(
    *,
    api_base: str,
    api_key: str,
    source_video_id: str,
    prompt: str,
    timeout_s: float,
) -> VideoJob:
    headers = _headers(api_key)
    headers["Content-Type"] = "application/json"
    body = json.dumps({"prompt": prompt}).encode("utf-8")
    resp = _request_json(
        "POST",
        f"{api_base.rstrip('/')}/videos/{source_video_id}/remix",
        headers,
        body=body,
        timeout_s=timeout_s,
    )
    vid = str(resp.get("id") or "")
    if not vid:
        raise RuntimeError(f"Video remix response missing id: {resp}")
    return VideoJob(id=vid, status=str(resp.get("status") or "unknown"), raw=resp)


def retrieve_video_job(*, api_base: str, api_key: str, video_id: str, timeout_s: float) -> VideoJob:
    resp = _request_json(
        "GET",
        f"{api_base.rstrip('/')}/videos/{video_id}",
        _headers(api_key),
        timeout_s=timeout_s,
    )
    return VideoJob(id=str(resp.get("id") or video_id), status=str(resp.get("status") or "unknown"), raw=resp)


def wait_for_completion(
    *,
    api_base: str,
    api_key: str,
    video_id: str,
    poll_s: float,
    timeout_s: float,
    request_timeout_s: float,
    label: str | None = None,
) -> VideoJob:
    deadline = time.time() + timeout_s
    last_status: str | None = None
    while True:
        if time.time() > deadline:
            raise RuntimeError(f"Timed out waiting for video {video_id} after {timeout_s}s")
        job = retrieve_video_job(
            api_base=api_base, api_key=api_key, video_id=video_id, timeout_s=request_timeout_s
        )
        status = job.status
        if status != last_status:
            progress = job.raw.get("progress")
            prefix = label or video_id
            msg = f"{prefix}: {status}"
            if isinstance(progress, (int, float)):
                msg += f" ({progress}%)"
            print(msg, file=sys.stderr)
            last_status = status
        if status in {"completed", "failed", "canceled"}:
            if status != "completed":
                err = job.raw.get("error")
                raise RuntimeError(f"Video job {video_id} ended with status={status}: {err}")
            return job
        time.sleep(max(0.2, float(poll_s)))


def download_video_content(
    *,
    api_base: str,
    api_key: str,
    video_id: str,
    out_path: Path,
    variant: str | None,
    timeout_s: float,
) -> None:
    query = f"?{urlencode({'variant': variant})}" if variant else ""
    data = _request_bytes(
        "GET",
        f"{api_base.rstrip('/')}/videos/{video_id}/content{query}",
        _headers(api_key),
        timeout_s=timeout_s,
    )
    out_path.write_bytes(data)


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "video"


def _ensure_ffmpeg() -> str:
    # We assume ffmpeg exists on dev machines; fail with a crisp message otherwise.
    from shutil import which

    exe = which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found on PATH (needed for --crop-square/--target-seconds/--mute).")
    return exe


def postprocess_with_ffmpeg(
    *,
    in_path: Path,
    out_path: Path,
    crop_square: bool,
    target_seconds: float | None,
    loop_input_seconds: float,
    mute: bool,
    crf: int,
    preset: str,
) -> None:
    ffmpeg = _ensure_ffmpeg()

    vf_filters: list[str] = []
    if crop_square:
        # Keep the center square (works well with portrait output and our "center-safe" prompts).
        vf_filters.append("crop=min(iw\\,ih):min(iw\\,ih)")

    cmd: list[str] = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]

    # If we need to extend/trim to a specific length, loop the input enough times then cut.
    if target_seconds is not None:
        loops = max(0, int(math.ceil(float(target_seconds) / max(loop_input_seconds, 0.001)) - 1))
        if loops > 0:
            cmd += ["-stream_loop", str(loops)]

    cmd += ["-i", str(in_path)]

    if target_seconds is not None:
        cmd += ["-t", str(float(target_seconds))]

    if vf_filters:
        cmd += ["-vf", ",".join(vf_filters)]

    # Re-encode for deterministic trims/crops and broad compatibility.
    cmd += ["-c:v", "libx264", "-preset", preset, "-crf", str(int(crf)), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]

    if mute:
        cmd += ["-an"]
    else:
        cmd += ["-c:a", "aac", "-b:a", "128k"]

    cmd += [str(out_path)]

    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as exc:
        pretty = " ".join(cmd)
        raise RuntimeError(f"ffmpeg failed (exit={exc.returncode}). Command:\n{pretty}") from exc


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="outputs/sora_portraits", help="Output directory (default: outputs/sora_portraits)")
    parser.add_argument(
        "--agents",
        default="providers",
        help=(
            "Comma-separated list, or 'providers' (openai, gemini, flux), or 'all' "
            f"(available: {', '.join(AVAILABLE_AGENTS)})"
        ),
    )
    parser.add_argument(
        "--states",
        default="both",
        help="Comma-separated list: idle, working (aka active), or 'both' (default: both).",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=1,
        help="Max concurrent video jobs (default: 1). Use 2-4 to speed up generation.",
    )
    parser.add_argument(
        "--model",
        default="sora-2-pro",
        help="Video model (e.g. sora-2, sora-2-pro, or a snapshot like sora-2-pro-2025-10-06).",
    )
    parser.add_argument(
        "--seconds",
        type=int,
        default=12,
        choices=[4, 8, 12],
        help="Clip duration seconds for the API (allowed: 4, 8, 12).",
    )
    parser.add_argument(
        "--size",
        default="720x1280",
        choices=["720x1280", "1280x720", "1024x1792", "1792x1024"],
        help="Output resolution (widthxheight).",
    )
    parser.add_argument(
        "--reference",
        type=str,
        default=None,
        help=(
            "Optional image reference path (input_reference). Used as the first frame for stronger consistency; "
            "must match --size."
        ),
    )
    parser.add_argument(
        "--prompt-suffix",
        default="",
        help="Extra text appended to every prompt (useful for tightening safe-zone/loop constraints).",
    )
    parser.add_argument(
        "--pair-strategy",
        default="remix",
        choices=["remix", "independent"],
        help=(
            "How to generate idle+working pairs. 'remix' generates idle, then remixes it into working to preserve "
            "character consistency. 'independent' generates both states independently (can drift)."
        ),
    )
    parser.add_argument(
        "--remix-from-video-id",
        default=None,
        help=(
            "Advanced: generate WORKING by remixing an existing completed video id (skips creating IDLE). "
            "Requires exactly one agent and --states working."
        ),
    )
    parser.add_argument("--api-base", default=DEFAULT_API_BASE, help=f"API base URL (default: {DEFAULT_API_BASE})")
    parser.add_argument("--poll", type=float, default=2.5, help="Poll interval seconds (default: 2.5)")
    parser.add_argument("--timeout", type=float, default=900.0, help="Per-video job timeout seconds (default: 900)")
    parser.add_argument("--request-timeout", type=float, default=90.0, help="HTTP request timeout seconds (default: 90)")
    parser.add_argument("--download-timeout", type=float, default=180.0, help="Download timeout seconds (default: 180)")
    parser.add_argument("--variant", default=None, help="Optional content variant for /content (default: mp4)")

    parser.add_argument("--crop-square", action="store_true", help="Center-crop the video to 1:1 square using ffmpeg.")
    parser.add_argument(
        "--target-seconds",
        type=float,
        default=None,
        help="Optional target duration; will loop+trim locally using ffmpeg (e.g. 10 or 15).",
    )
    parser.add_argument("--mute", action="store_true", help="Strip audio track during ffmpeg postprocess.")
    parser.add_argument("--keep-raw", action="store_true", help="Keep the downloaded raw MP4 alongside processed output.")
    parser.add_argument("--crf", type=int, default=18, help="ffmpeg x264 CRF (default: 18; lower is higher quality)")
    parser.add_argument("--preset", default="medium", help="ffmpeg x264 preset (default: medium)")

    return parser.parse_args(argv)


def resolve_agents(spec: str, available_agents: set[str]) -> list[str]:
    spec = (spec or "").strip()
    if not spec or spec.lower() == "all":
        return sorted(available_agents)
    if spec.lower() == "providers":
        providers = [a for a in PROVIDER_AGENTS if a in available_agents]
        if not providers:
            raise SystemExit("No provider agents are available in this script.")
        return providers
    parts = [p.strip().lower() for p in spec.split(",") if p.strip()]
    unknown = [p for p in parts if p not in available_agents]
    if unknown:
        raise SystemExit(f"Unknown agent(s): {', '.join(unknown)}. Available: {', '.join(sorted(available_agents))}")
    # Deduplicate while preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        if p in seen:
            continue
        out.append(p)
        seen.add(p)
    return out


def resolve_states(spec: str) -> list[str]:
    spec = (spec or "").strip().lower()
    if not spec:
        return ["working"]
    if spec in {"both", "all"}:
        return list(AVAILABLE_STATES)
    parts = [p.strip().lower() for p in spec.split(",") if p.strip()]
    parts = ["working" if p == "active" else p for p in parts]
    unknown = [p for p in parts if p not in AVAILABLE_STATES]
    if unknown:
        raise SystemExit(f"Unknown state(s): {', '.join(unknown)}. Available: {', '.join(AVAILABLE_STATES)}")
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        if p in seen:
            continue
        out.append(p)
        seen.add(p)
    return out


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    api_key = _get_api_key()
    if not api_key:
        print("Missing OPENAI_API_KEY (or OPENAI_API_KEY_BACKUP).", file=sys.stderr)
        return 2

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    model = str(args.model or "").strip()
    if not model:
        print("Missing --model.", file=sys.stderr)
        return 2
    remix_from_video_id = str(args.remix_from_video_id or "").strip()
    if not remix_from_video_id:
        if args.size in {"1024x1792", "1792x1024"} and not model.startswith("sora-2-pro"):
            print(f"Size {args.size} typically requires sora-2-pro; rerun with --model sora-2-pro.", file=sys.stderr)
            return 2

    reference_path = Path(args.reference).expanduser() if args.reference else None
    if reference_path is not None and not reference_path.exists():
        print(f"Reference path does not exist: {reference_path}", file=sys.stderr)
        return 2

    agents = resolve_agents(args.agents, set(AVAILABLE_AGENTS))
    states = resolve_states(args.states)
    run_stamp = time.strftime("%Y%m%d_%H%M%S")

    # Stable processing order for per-agent sequencing.
    states = [s for s in AVAILABLE_STATES if s in set(states)]

    def build_paths(agent: str, state: str) -> tuple[Path, Path, Path]:
        base = f"{_slug(agent)}_{_slug(state)}_{_slug(model)}_{args.size}_{args.seconds}s_{run_stamp}"
        raw_path = out_dir / f"{base}.raw.mp4"
        final_suffix: list[str] = []
        if args.crop_square:
            final_suffix.append("sq")
        if args.target_seconds is not None:
            t = int(args.target_seconds) if float(args.target_seconds).is_integer() else args.target_seconds
            final_suffix.append(f"t{t}")
        if args.mute:
            final_suffix.append("mute")
        final_name = base + (("." + ".".join(final_suffix)) if final_suffix else "") + ".mp4"
        final_path = out_dir / final_name
        meta_path = out_dir / (final_path.stem + ".json")
        return raw_path, final_path, meta_path

    def write_meta(path: Path, meta: Mapping[str, Any]) -> None:
        path.write_text(json.dumps(dict(meta), indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def download_and_finalize(*, video_id: str, raw_path: Path, final_path: Path) -> None:
        download_video_content(
            api_base=args.api_base,
            api_key=api_key,
            video_id=video_id,
            out_path=raw_path,
            variant=args.variant,
            timeout_s=float(args.download_timeout),
        )

        needs_post = bool(args.crop_square or args.target_seconds is not None or args.mute)
        if needs_post:
            postprocess_with_ffmpeg(
                in_path=raw_path,
                out_path=final_path,
                crop_square=bool(args.crop_square),
                target_seconds=args.target_seconds,
                loop_input_seconds=float(args.seconds),
                mute=bool(args.mute),
                crf=int(args.crf),
                preset=str(args.preset),
            )
            if not args.keep_raw:
                try:
                    raw_path.unlink()
                except FileNotFoundError:
                    pass
        else:
            raw_path.rename(final_path)

    def run_create(agent: str, state: str) -> tuple[str, Path]:
        prompt = build_prompt(agent=agent, state=state, prompt_suffix=args.prompt_suffix)

        raw_path, final_path, meta_path = build_paths(agent, state)
        label = f"{agent}/{state}"
        print(f"== {label} -> {final_path.name}", file=sys.stderr)

        created = create_video_job(
            api_base=args.api_base,
            api_key=api_key,
            model=model,
            prompt=prompt,
            seconds=int(args.seconds),
            size=args.size,
            reference_path=reference_path,
            timeout_s=float(args.request_timeout),
        )

        meta: dict[str, Any] = {
            "agent": agent,
            "state": state,
            "prompt": prompt,
            "requested": {
                "model": model,
                "seconds": int(args.seconds),
                "size": args.size,
                "crop_square": bool(args.crop_square),
                "target_seconds": args.target_seconds,
                "mute": bool(args.mute),
                "variant": args.variant,
                "pair_strategy": args.pair_strategy,
            },
            "create_response": dict(created.raw),
        }
        write_meta(meta_path, meta)

        completed = wait_for_completion(
            api_base=args.api_base,
            api_key=api_key,
            video_id=created.id,
            poll_s=float(args.poll),
            timeout_s=float(args.timeout),
            request_timeout_s=float(args.request_timeout),
            label=label,
        )
        meta["final_response"] = dict(completed.raw)
        write_meta(meta_path, meta)

        download_and_finalize(video_id=created.id, raw_path=raw_path, final_path=final_path)
        meta["output_mp4"] = str(final_path)
        write_meta(meta_path, meta)
        return created.id, final_path

    def run_remix(agent: str, state: str, *, source_video_id: str) -> tuple[str, Path]:
        prompt = build_remix_prompt(agent=agent, state=state, prompt_suffix=args.prompt_suffix)

        raw_path, final_path, meta_path = build_paths(agent, state)
        label = f"{agent}/{state}"
        print(f"== {label} (remix of {source_video_id}) -> {final_path.name}", file=sys.stderr)

        created = remix_video_job(
            api_base=args.api_base,
            api_key=api_key,
            source_video_id=source_video_id,
            prompt=prompt,
            timeout_s=float(args.request_timeout),
        )

        meta: dict[str, Any] = {
            "agent": agent,
            "state": state,
            "prompt": prompt,
            "requested": {
                "model": model,
                "seconds": int(args.seconds),
                "size": args.size,
                "crop_square": bool(args.crop_square),
                "target_seconds": args.target_seconds,
                "mute": bool(args.mute),
                "variant": args.variant,
                "pair_strategy": args.pair_strategy,
            },
            "remix_from_video_id": source_video_id,
            "create_response": dict(created.raw),
        }
        write_meta(meta_path, meta)

        completed = wait_for_completion(
            api_base=args.api_base,
            api_key=api_key,
            video_id=created.id,
            poll_s=float(args.poll),
            timeout_s=float(args.timeout),
            request_timeout_s=float(args.request_timeout),
            label=label,
        )
        meta["final_response"] = dict(completed.raw)
        write_meta(meta_path, meta)

        download_and_finalize(video_id=created.id, raw_path=raw_path, final_path=final_path)
        meta["output_mp4"] = str(final_path)
        write_meta(meta_path, meta)
        return created.id, final_path

    def run_agent(agent: str) -> None:
        agent = str(agent or "").strip().lower()
        if agent not in AVAILABLE_AGENTS:
            raise RuntimeError(f"Unknown agent: {agent}")

        want_remix_pair = (
            str(args.pair_strategy or "").strip().lower() == "remix"
            and "idle" in states
            and "working" in states
        )

        if want_remix_pair:
            idle_id, _ = run_create(agent, "idle")
            run_remix(agent, "working", source_video_id=idle_id)
            return

        for state in states:
            run_create(agent, state)

    if remix_from_video_id:
        if len(agents) != 1:
            raise SystemExit("--remix-from-video-id requires exactly one agent (e.g. --agents openai).")
        if states != ["working"]:
            raise SystemExit("--remix-from-video-id requires --states working (only).")

        # Sync naming/meta to the source video so outputs are labeled correctly.
        source = retrieve_video_job(
            api_base=args.api_base,
            api_key=api_key,
            video_id=remix_from_video_id,
            timeout_s=float(args.request_timeout),
        )
        if source.status != "completed":
            source = wait_for_completion(
                api_base=args.api_base,
                api_key=api_key,
                video_id=remix_from_video_id,
                poll_s=float(args.poll),
                timeout_s=float(args.timeout),
                request_timeout_s=float(args.request_timeout),
                label="source",
            )

        src_model = str(source.raw.get("model") or "").strip()
        if src_model:
            model = src_model
        src_size = str(source.raw.get("size") or "").strip()
        if src_size:
            args.size = src_size
        src_seconds = str(source.raw.get("seconds") or "").strip()
        if src_seconds.isdigit():
            args.seconds = int(src_seconds)

        run_remix(agents[0], "working", source_video_id=remix_from_video_id)
        print(f"Wrote videos to {out_dir}", file=sys.stderr)
        return 0

    parallel = max(1, int(args.parallel))
    if parallel <= 1 or len(agents) <= 1:
        for agent in agents:
            run_agent(agent)
    else:
        max_workers = min(parallel, len(agents))
        failures: list[tuple[str, Exception]] = []
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_map = {pool.submit(run_agent, agent): agent for agent in agents}
            for future in as_completed(future_map):
                agent = future_map[future]
                try:
                    future.result()
                except Exception as exc:
                    failures.append((agent, exc))
                    print(f"!! {agent} failed: {exc}", file=sys.stderr)
        if failures:
            print(f"{len(failures)} agent(s) failed.", file=sys.stderr)
            return 1

    print(f"Wrote videos to {out_dir}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
