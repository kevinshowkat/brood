#!/usr/bin/env python3
"""
Generate a Sora video using an image reference extracted from mother.mp4.

This script:
  1) Extracts a single PNG frame from a reference video (default: ./mother.mp4).
  2) Uses that frame as Sora's `input_reference` (first frame) for stronger character consistency.
  3) Creates a video job via POST /v1/videos (multipart form).
  4) Polls GET /v1/videos/{id} until completed/failed.
  5) Downloads bytes via GET /v1/videos/{id}/content to an .mp4.
  6) Optionally crops to square and/or trims/loops to a target duration (ffmpeg).

Environment:
  - OPENAI_API_KEY (required) or OPENAI_API_KEY_BACKUP
  - Optional: OPENAI_PROJECT_ID, OPENAI_ORG_ID

Examples:
  # Generate an 8s portrait clip with a reference frame extracted at 0.6s.
  python scripts/sora_generate_mother_from_reference.py --seconds 8 --size 720x1280 --ref-time 0.6

  # Use the source video's native resolution (via ffprobe) for both size and reference image.
  python scripts/sora_generate_mother_from_reference.py --size auto

  # Make a 15s looping square clip for the UI (API max is 12s; this loops+trims locally).
  python scripts/sora_generate_mother_from_reference.py --seconds 12 --size 720x1280 --crop-square --target-seconds 15 --mute
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
import mimetypes
import os
import re
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_API_BASE = "https://api.openai.com/v1"


DEFAULT_PROMPT_PREFIX = (
    # Keep the prompt narrow-ish: reference frame already sets most style/identity.
    "Continue from the reference frame with the same character, costume, materials, lighting, and framing. "
    "Single continuous shot, no cuts. No readable text, no logos, no watermarks. "
    "Perfect loop: last frame == first frame (pose, tools, lighting, background match)."
)

DEFAULT_ACTION_TEXT = (
    "A perfect loop of her leaning back into this gnarly biomechanical harness that clamps around her "
    "shoulders, four extra jointed arms unfolding behind her like a spider rig, each one reaching down in "
    "front of her just below frame doing something different \u2014 one running a fine laser that cuts with "
    "gorgeous amber light, another stitching with surgical precision trailing tiny glowing threads, a third "
    "grinding with a whirring bone-drill throwing sparks up into her face, the last one welding resin seams "
    "that glow like liquid gold \u2014 all working in perfect rhythm while her body sways gently side to side "
    "and her head dips and tilts tracking each arm's progress on whatever she's building, then the arms fold "
    "back in and the harness releases and she settles center and still again"
)

DEFAULT_PROMPT = f"{DEFAULT_PROMPT_PREFIX} {DEFAULT_ACTION_TEXT}"


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
        "User-Agent": "brood-sora-mother-from-reference/1.0",
    }
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


def _ensure_ffmpeg(exe: str = "ffmpeg") -> str:
    from shutil import which

    found = which(exe)
    if not found:
        raise RuntimeError(f"{exe} not found on PATH.")
    return found


def _ensure_ffprobe() -> str:
    return _ensure_ffmpeg("ffprobe")


def _parse_size(size: str) -> tuple[int, int]:
    s = str(size or "").strip().lower()
    m = re.match(r"^(\d{2,5})x(\d{2,5})$", s)
    if not m:
        raise ValueError(f"Invalid --size '{size}'. Expected WxH like 720x1280 or 'auto'.")
    w = int(m.group(1))
    h = int(m.group(2))
    if w <= 0 or h <= 0:
        raise ValueError(f"Invalid --size '{size}'.")
    return w, h


def probe_video_size(video_path: Path) -> tuple[int, int]:
    ffprobe = _ensure_ffprobe()
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode("utf-8", errors="replace").strip()
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffprobe failed extracting video size. Output:\n{exc.output.decode('utf-8', 'replace')}") from exc
    parts = [p.strip() for p in out.splitlines() if p.strip()]
    if len(parts) < 2:
        raise RuntimeError(f"Unexpected ffprobe output for size:\n{out}")
    w = int(parts[0])
    h = int(parts[1])
    if w <= 0 or h <= 0:
        raise RuntimeError(f"Invalid probed size: {w}x{h}")
    return w, h


def extract_reference_frame(
    *,
    video_path: Path,
    out_png: Path,
    at_seconds: float,
    size: tuple[int, int] | None,
    fit: str,
) -> None:
    ffmpeg = _ensure_ffmpeg()

    vf = None
    if size is not None:
        w, h = size
        if fit == "stretch":
            vf = f"scale={w}:{h}"
        elif fit == "pad":
            # Preserve AR; pad (fills with a solid color).
            vf = (
                f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,"
                "setsar=1"
            )
        elif fit == "crop":
            # Preserve AR; fill and crop to exact size.
            vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
        else:
            raise ValueError(f"Unknown --ref-fit '{fit}'. Expected crop|pad|stretch.")

    cmd: list[str] = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        str(float(at_seconds)),
        "-i",
        str(video_path),
        "-frames:v",
        "1",
    ]
    if vf:
        cmd += ["-vf", vf]
    cmd += [str(out_png)]

    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as exc:
        pretty = " ".join(cmd)
        raise RuntimeError(f"ffmpeg failed extracting reference frame (exit={exc.returncode}). Command:\n{pretty}") from exc


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
        vf_filters.append("crop=min(iw\\,ih):min(iw\\,ih)")

    cmd: list[str] = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]

    if target_seconds is not None:
        loops = max(0, int(math.ceil(float(target_seconds) / max(loop_input_seconds, 0.001)) - 1))
        if loops > 0:
            cmd += ["-stream_loop", str(loops)]

    cmd += ["-i", str(in_path)]

    if target_seconds is not None:
        cmd += ["-t", str(float(target_seconds))]

    if vf_filters:
        cmd += ["-vf", ",".join(vf_filters)]

    cmd += [
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(int(crf)),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
    ]

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
    parser.add_argument("--out", default="outputs/sora_mother", help="Output directory (default: outputs/sora_mother)")
    parser.add_argument(
        "--n",
        type=int,
        default=1,
        help="How many independent video jobs to create (default: 1).",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=1,
        help="Max concurrent video jobs to run (default: 1).",
    )
    parser.add_argument(
        "--reference-video",
        default="mother.mp4",
        help="Reference video path used only to extract a still frame (default: mother.mp4).",
    )
    parser.add_argument(
        "--ref-time",
        type=float,
        default=0.6,
        help="Timestamp (seconds) to grab the reference frame from the video (default: 0.6).",
    )
    parser.add_argument(
        "--ref-fit",
        default="crop",
        choices=["crop", "pad", "stretch"],
        help="How to fit the extracted reference frame to --size when needed (default: crop).",
    )
    parser.add_argument(
        "--prompt",
        default="",
        help="Full Sora prompt override. If set, it replaces --prompt-prefix + --action.",
    )
    parser.add_argument("--prompt-prefix", default=DEFAULT_PROMPT_PREFIX, help="Prompt prefix used with --action.")
    parser.add_argument("--action", default=DEFAULT_ACTION_TEXT, help="Action text appended to --prompt-prefix.")
    parser.add_argument("--model", default="sora-2", help="Video model (e.g. sora-2, sora-2-pro).")
    parser.add_argument(
        "--seconds",
        type=int,
        default=8,
        choices=[4, 8, 12],
        help="Clip duration seconds for the API (allowed: 4, 8, 12).",
    )
    parser.add_argument(
        "--size",
        default="720x1280",
        help=(
            "Output resolution (widthxheight), or 'auto' to use the reference video's native size via ffprobe "
            "(the extracted reference image will be made to match)."
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

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't call the API; just write the extracted reference frame and print the prompt/params.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    if int(args.n) <= 0:
        print("--n must be >= 1.", file=sys.stderr)
        return 2
    if int(args.parallel) <= 0:
        print("--parallel must be >= 1.", file=sys.stderr)
        return 2

    ref_video = Path(args.reference_video).expanduser()
    if not ref_video.exists():
        print(f"Reference video not found: {ref_video}", file=sys.stderr)
        return 2

    size_arg = str(args.size or "").strip().lower()
    if size_arg == "auto":
        w, h = probe_video_size(ref_video)
        size_str = f"{w}x{h}"
        size = (w, h)
    else:
        w, h = _parse_size(size_arg)
        size_str = f"{w}x{h}"
        size = (w, h)

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    run_stamp = time.strftime("%Y%m%d_%H%M%S")
    run_base = f"mother_working_{_slug(args.model)}_{size_str}_{int(args.seconds)}s_{run_stamp}"

    ref_png = out_dir / f"{run_base}.reference.png"
    extract_reference_frame(
        video_path=ref_video,
        out_png=ref_png,
        at_seconds=float(args.ref_time),
        size=size,
        fit=str(args.ref_fit),
    )

    full_prompt = str(args.prompt or "").strip()
    if full_prompt:
        prompt = full_prompt
    else:
        prefix = str(args.prompt_prefix or "").strip()
        action = str(args.action or "").strip()
        prompt = f"{prefix} {action}".strip()
    if not prompt:
        print("Empty --prompt.", file=sys.stderr)
        return 2
    if int(args.seconds) <= 0:
        print("--seconds must be > 0.", file=sys.stderr)
        return 2
    if args.target_seconds is not None and float(args.target_seconds) <= 0:
        print("--target-seconds must be > 0.", file=sys.stderr)
        return 2

    if args.dry_run:
        print("DRY RUN (no API call)\n", file=sys.stderr)
        print(f"reference_png: {ref_png}", file=sys.stderr)
        print(f"model: {args.model}", file=sys.stderr)
        print(f"size: {size_str}", file=sys.stderr)
        print(f"seconds: {args.seconds}", file=sys.stderr)
        print(f"n: {int(args.n)}", file=sys.stderr)
        print(f"parallel: {int(args.parallel)}", file=sys.stderr)
        print("\nPROMPT:\n", file=sys.stderr)
        print(prompt, file=sys.stderr)
        return 0

    api_key = _get_api_key()
    if not api_key:
        print("Missing OPENAI_API_KEY (or OPENAI_API_KEY_BACKUP).", file=sys.stderr)
        return 2

    final_suffix: list[str] = []
    if args.crop_square:
        final_suffix.append("sq")
    if args.target_seconds is not None:
        t = int(args.target_seconds) if float(args.target_seconds).is_integer() else args.target_seconds
        final_suffix.append(f"t{t}")
    if args.mute:
        final_suffix.append("mute")
    final_suffix_str = ("." + ".".join(final_suffix)) if final_suffix else ""

    def run_one(idx: int) -> Path:
        base = f"{run_base}_v{idx:02d}"
        raw_path = out_dir / f"{base}.raw.mp4"
        final_path = out_dir / f"{base}{final_suffix_str}.mp4"
        meta_path = out_dir / (final_path.stem + ".json")
        label = f"mother[{idx:02d}]"

        print(f"== {label} -> {final_path.name}", file=sys.stderr)
        created = create_video_job(
            api_base=args.api_base,
            api_key=api_key,
            model=str(args.model),
            prompt=prompt,
            seconds=int(args.seconds),
            size=size_str,
            reference_path=ref_png,
            timeout_s=float(args.request_timeout),
        )

        meta: dict[str, Any] = {
            "agent": "mother",
            "state": "working",
            "index": idx,
            "prompt": prompt,
            "prompt_prefix": str(args.prompt_prefix or "").strip() if not full_prompt else None,
            "action": str(args.action or "").strip() if not full_prompt else None,
            "reference_video": str(ref_video),
            "reference_png": str(ref_png),
            "requested": {
                "model": str(args.model),
                "seconds": int(args.seconds),
                "size": size_str,
                "ref_time": float(args.ref_time),
                "ref_fit": str(args.ref_fit),
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

        print(f"Wrote: {final_path}", file=sys.stderr)
        return final_path

    n = int(args.n)
    parallel = min(max(1, int(args.parallel)), n)
    if parallel <= 1 or n <= 1:
        for i in range(1, n + 1):
            run_one(i)
        return 0

    failures: list[tuple[int, Exception]] = []
    with ThreadPoolExecutor(max_workers=parallel) as pool:
        future_map = {pool.submit(run_one, i): i for i in range(1, n + 1)}
        for future in as_completed(future_map):
            idx = future_map[future]
            try:
                future.result()
            except Exception as exc:
                failures.append((idx, exc))
                print(f"!! mother[{idx:02d}] failed: {exc}", file=sys.stderr)
    if failures:
        print(f"{len(failures)} job(s) failed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
