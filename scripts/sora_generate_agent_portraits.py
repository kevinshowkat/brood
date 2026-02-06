#!/usr/bin/env python3
"""
Generate StarCraft-1-like "agent portrait" videos using the OpenAI Sora 2 API.

This script:
  1) Creates a video job via POST /v1/videos (multipart form).
  2) Polls GET /v1/videos/{id} until completed/failed.
  3) Downloads bytes via GET /v1/videos/{id}/content to an .mp4.
  4) Optionally crops portrait output to a square and/or trims/loops to a target duration (ffmpeg).

Environment:
  - OPENAI_API_KEY (required) or OPENAI_API_KEY_BACKUP
  - Optional: OPENAI_PROJECT_ID, OPENAI_ORG_ID

Examples:
  # Generate both idle+working agent portraits (12s portrait) and crop to square for the UI.
  python scripts/sora_generate_agent_portraits.py --agents all --states both --seconds 12 --crop-square

  # Speed it up by running a few jobs concurrently (watch rate limits / cost).
  python scripts/sora_generate_agent_portraits.py --agents all --states both --parallel 3 --seconds 12 --crop-square --mute

  # Target a 15s looping square clip (API max is 12s, so we loop+trim locally).
  python scripts/sora_generate_agent_portraits.py --agents openai,gemini --states working --seconds 12 --target-seconds 15 --crop-square --mute
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
MOOD_PHRASE = "stunningly awe-inspiring and tearfully joyous"
MOOD_LINE = f"Mood: {MOOD_PHRASE}."

BASE_STYLE_LINE = (
    "Late-90s RTS unit-portrait aesthetic, low-res pre-rendered 3D, chunky pixels, dithering, CRT scanlines, "
    "subtle VHS noise, slight chromatic aberration, 15 fps feel. Head-and-shoulders portrait centered with "
    "generous safe margins, keep all important motion in the center 60% so a square crop still works. "
    "Exaggerated character design with clearly pseudo-human proportions: larger-than-life facial features, strong "
    "silhouettes, heroic jawlines, slightly uncanny 90s CGI vibe, gritty armor and gear. "
    "Single continuous shot, no cuts. Seamless loop (end pose matches start). Cockpit/console background with "
    "blinking lights and abstract HUD shapes, but no readable text. No logos, no watermarks, no subtitles. "
    "Original character design only; do not mimic any specific movie/game character. "
    "No recognizable StarCraft characters/factions. No spoken words; optional "
    f"faint radio static only. {MOOD_LINE}"
)

IDLE_STATE_LINE = (
    "IDLE state: subtle breathing, blinking, tiny eye saccades, micro head movement. Console lights flicker but "
    "no big hologram transformations; nothing dramatic changes in the scene."
)

WORKING_STATE_LINE = (
    "WORKING state: the unit is clearly doing hands-on work with visible tooling (wrench, screwdriver, diagnostic "
    "probe, soldering iron, micro blowtorch, cable crimper). Small readable motions near the center of frame; "
    "occasional controlled sparks or vapor allowed. Keep the action loopable so the end matches the start."
)

AGENT_PROMPTS_BY_STATE: dict[str, dict[str, str]] = {
    "idle": {
        "dryrun": (
            f"{BASE_STYLE_LINE} {IDLE_STATE_LINE} "
            "A swarm-born bio-synthetic test-range operator (adult): pseudo-human silhouette with chitin shoulder "
            "plates and a simple visor, expressive human eyes, exaggerated heroic facial features (bold brows, strong "
            "jaw). A dim wireframe calibration grid sits behind them, barely pulsing. "
            "The unit rests fingertips on three chunky switches without toggling them; subtle servo breathing, a slow "
            "blink, and a tiny head tilt."
        ),
        "openai": (
            f"{BASE_STYLE_LINE} {IDLE_STATE_LINE} "
            "A Persian commando tactician (adult) with black-and-ivory armor plates and amber accent lights, "
            "caricatured but respectful facial features. Coolly smokes a cigarette: takes one slow drag, exhales a "
            "thin smoke ribbon, flicks ash into a small tray. A stable holographic plane floats faintly and does not "
            "change. The unit holds a stylus near the console, makes a tiny micro-adjustment, then returns to "
            "neutral; slow breathing and eye saccades."
        ),
        "gemini": (
            f"{BASE_STYLE_LINE} {IDLE_STATE_LINE} "
            "An East Asian analyst (adult) with a split-color visor (cool cyan on one side, deep blue on the other) "
            "and two asymmetrical ocular modules. Two small holograms remain steady and quiet. The unit alternates "
            "gaze left/right, gentle breathing, one blink; no major scene changes."
        ),
        "imagen": (
            f"{BASE_STYLE_LINE} {IDLE_STATE_LINE} "
            "A white field photographer-mechanic (adult) wearing a camera-rig helmet with green accent LEDs and a "
            "rugged utility vest. Coolly smokes a cigarette: ember glow reflected on the visor, a slow exhale, then "
            "a gentle ash tap. A lens spanner tool rests on the console. The unit lightly turns a focus ring a few "
            "millimeters, then returns to the starting position; warm practical lights and drifting dust motes."
        ),
        "flux": (
            f"{BASE_STYLE_LINE} {IDLE_STATE_LINE} "
            "A psionic, crystalline alien (classic RTS 'high-tech psychic' vibe): tall posture, "
            "curved plated armor with glowing seams, faint magenta coil glow at the collar. A powered-down micro "
            "blowtorch is holstered; coils hum softly (visual only). The unit breathes, blinks once, and makes a "
            "tiny head movement; no sparks."
        ),
        "stability": (
            f"{BASE_STYLE_LINE} {IDLE_STATE_LINE} "
            "A Hispanic reactor engineer (adult) with a chunky helmet, red-blue stabilizer diodes, and grease-stained "
            "armor. Coolly smokes a cigarette clamped at the corner of the mouth; ember glow and a thin smoke curl. "
            "A noise meter sits steady at center. The unit rests one hand on a dial, makes a tiny corrective nudge, "
            "then returns to the exact starting pose; diode lights gently breathe."
        ),
    },
    "working": {
        "dryrun": (
            f"{BASE_STYLE_LINE} {WORKING_STATE_LINE} "
            "A swarm-born bio-synthetic test-range operator (adult) with chitin shoulder plates and a simple visor. "
            "Action: "
            "uses a diagnostic probe in one hand and toggles one chunky switch with the other. A wireframe hologram "
            "preview flickers on, jitters, then snaps back to the blank calibration grid. Tiny controlled sparks when "
            "the probe touches a contact; end pose matches the starting pose."
        ),
        "openai": (
            f"{BASE_STYLE_LINE} {WORKING_STATE_LINE} "
            "A Persian commando tactician (adult) with amber accent lights and a battle-worn look. Action: tightens a tiny knurled "
            "thumbwheel with a precision screwdriver while the other hand drags a holographic lattice into alignment. "
            "A clean holographic image plane resolves, then dissolves back into particles as the screwdriver returns "
            "to its starting position."
        ),
        "gemini": (
            f"{BASE_STYLE_LINE} {WORKING_STATE_LINE} "
            "An East Asian analyst (adult) with a split-color visor. Action: plugs two diagnostic probes into two ports "
            "simultaneously (one per hand), then swaps them in a quick, deliberate motion. Two holograms pulse in sync, "
            "merge into one unified plane, then split back into two as the probes return to their original ports."
        ),
        "imagen": (
            f"{BASE_STYLE_LINE} {WORKING_STATE_LINE} "
            "A white field photographer-mechanic (adult) with green accent LEDs. Action: uses a lens spanner wrench to loosen and "
            "re-seat a camera mount, then uses a tiny air duster to clear dust. A controlled shutter-like flash reveals "
            "a holographic photo panel that develops from blurry to sharp, then fades back as the wrench returns to "
            "the exact start position."
        ),
        "flux": (
            f"{BASE_STYLE_LINE} {WORKING_STATE_LINE} "
            "A psionic, crystalline alien with an energy collar and magenta coil glow. Action: ignites a micro blowtorch and "
            "briefly fuses a small energy conduit in front of the console; bright but controlled sparks and a curl of "
            "vapor. The unit shuts off the torch and returns it to the holster; a flux vortex hologram swirls, resolves "
            "into a clean plane, then collapses back to the vortex at the end of the loop."
        ),
        "stability": (
            f"{BASE_STYLE_LINE} {WORKING_STATE_LINE} "
            "A Hispanic reactor engineer (adult) with red-blue stabilizer diodes. Action: uses a heavy wrench to tighten a "
            "stabilizer ring while briefly spot-welding a seam with an arc welder; small controlled sparks near center "
            "frame. A chaotic noise hologram dampens into a stable plane, then re-noises as the wrench and welder "
            "return to their initial positions."
        ),
    },
}

AVAILABLE_STATES = ("idle", "working")
_idle_agents = set(AGENT_PROMPTS_BY_STATE["idle"].keys())
_working_agents = set(AGENT_PROMPTS_BY_STATE["working"].keys())
if _idle_agents != _working_agents:
    raise RuntimeError(
        "Agent prompt sets mismatch between idle and working states. "
        f"idle-only={sorted(_idle_agents - _working_agents)}, working-only={sorted(_working_agents - _idle_agents)}"
    )
AVAILABLE_AGENTS = tuple(sorted(_idle_agents))


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
        default="all",
        help=f"Comma-separated list or 'all' (available: {', '.join(AVAILABLE_AGENTS)})",
    )
    parser.add_argument(
        "--states",
        default="both",
        help="Comma-separated list: idle, working, or 'both' (default: both).",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=1,
        help="Max concurrent video jobs (default: 1). Use 2-4 to speed up generation.",
    )
    parser.add_argument(
        "--model",
        default="sora-2",
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
    parser.add_argument("--reference", type=str, default=None, help="Optional image reference path (input_reference).")
    parser.add_argument(
        "--prompt-suffix",
        default="",
        help="Extra text appended to every prompt (useful for tightening safe-zone/loop constraints).",
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

    tasks: list[tuple[str, str]] = []
    for agent in agents:
        for state in states:
            tasks.append((agent, state))

    def run_one(agent: str, state: str) -> Path:
        prompt = AGENT_PROMPTS_BY_STATE[state][agent]
        if args.prompt_suffix.strip():
            prompt = f"{prompt}\n{args.prompt_suffix.strip()}"

        # Conservative filenames that are easy to diff/replace in UI assets.
        base = f"{_slug(agent)}_{_slug(state)}_{_slug(model)}_{args.size}_{args.seconds}s_{run_stamp}"
        raw_path = out_dir / f"{base}.raw.mp4"
        final_suffix: list[str] = []
        if args.crop_square:
            final_suffix.append("sq")
        if args.target_seconds is not None:
            # Keep filenames stable for integer durations like 10/15.
            t = int(args.target_seconds) if float(args.target_seconds).is_integer() else args.target_seconds
            final_suffix.append(f"t{t}")
        if args.mute:
            final_suffix.append("mute")
        final_name = base + (("." + ".".join(final_suffix)) if final_suffix else "") + ".mp4"
        final_path = out_dir / final_name
        meta_path = out_dir / (final_path.stem + ".json")

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
            },
            "create_response": dict(created.raw),
        }
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")

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
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        download_video_content(
            api_base=args.api_base,
            api_key=api_key,
            video_id=created.id,
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

        meta["output_mp4"] = str(final_path)
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return final_path

    parallel = max(1, int(args.parallel))
    if parallel <= 1 or len(tasks) <= 1:
        for agent, state in tasks:
            run_one(agent, state)
    else:
        max_workers = min(parallel, len(tasks))
        failures: list[tuple[str, str, Exception]] = []
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_map = {pool.submit(run_one, agent, state): (agent, state) for agent, state in tasks}
            for future in as_completed(future_map):
                agent, state = future_map[future]
                try:
                    future.result()
                except Exception as exc:
                    failures.append((agent, state, exc))
                    print(f"!! {agent}/{state} failed: {exc}", file=sys.stderr)
        if failures:
            print(f"{len(failures)} job(s) failed.", file=sys.stderr)
            return 1

    print(f"Wrote videos to {out_dir}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
