"""Shared utilities for Brood engine."""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
try:  # py>=3.11
    import tomllib  # type: ignore
except Exception:  # pragma: no cover
    tomllib = None  # type: ignore
from typing import Any, Mapping


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def stable_hash(payload: Mapping[str, Any]) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


def serialize(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"
    if is_dataclass(value):
        return {k: serialize(v) for k, v in asdict(value).items()}
    if isinstance(value, Mapping):
        return {str(k): serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serialize(item) for item in value]
    return str(value)


def sanitize_payload(payload: Any) -> Any:
    if payload is None:
        return None
    if isinstance(payload, (str, int, float, bool)):
        return payload
    if isinstance(payload, bytes):
        return f"<bytes:{len(payload)}>"
    if isinstance(payload, Mapping):
        sanitized: dict[str, Any] = {}
        for key, value in payload.items():
            lowered = str(key).lower()
            if lowered in {"b64_json", "image", "image_bytes", "data"}:
                sanitized[str(key)] = "<omitted>"
                continue
            sanitized[str(key)] = sanitize_payload(value)
        return sanitized
    if isinstance(payload, (list, tuple)):
        return [sanitize_payload(item) for item in payload]
    return str(payload)


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def getenv_flag(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def has_flux_key() -> bool:
    return bool(os.getenv("BFL_API_KEY") or os.getenv("FLUX_API_KEY"))


def is_flux_model(model: str | None) -> bool:
    return bool(model and model.strip().lower().startswith("flux"))


def load_dotenv(path: Path | None = None, override: bool = False) -> bool:
    env_path = path or _default_env_path()
    if not env_path.exists():
        return False
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if value and value[0] == value[-1] and value.startswith(("\"", "'")):
            value = value[1:-1]
        if not override and key in os.environ:
            continue
        os.environ[key] = value
    return True


def _default_env_path() -> Path:
    cwd = Path.cwd()
    repo_root = _find_repo_root(cwd)
    if repo_root:
        env_path = repo_root / ".env"
        if env_path.exists():
            return env_path
    module_root = _find_repo_root(Path(__file__).resolve().parent)
    if module_root:
        env_path = module_root / ".env"
        if env_path.exists():
            return env_path
    return cwd / ".env"


def _find_repo_root(start: Path) -> Path | None:
    for current in (start,) + tuple(start.parents):
        if (current / "brood_engine").is_dir():
            return current
        pyproject = current / "pyproject.toml"
        if pyproject.exists():
            text = ""
            try:
                text = pyproject.read_text(encoding="utf-8")
            except Exception:
                continue
            if tomllib is not None:
                try:
                    data = tomllib.loads(text)
                except Exception:
                    continue
                if data.get("project", {}).get("name") == "brood":
                    return current
            else:
                # Lightweight fallback for environments still on Python < 3.11.
                if 'name = "brood"' in text or "name = 'brood'" in text:
                    return current
    return None


def monotonic_ms() -> int:
    return int(time.monotonic() * 1000)


def format_cost_generation_cents(cost_usd: float | None) -> str | None:
    if cost_usd is None:
        return None
    cents = int(round(cost_usd * 100))
    return f"{cents} cents"


def format_latency_seconds(latency_per_image_s: float | None) -> str | None:
    if latency_per_image_s is None:
        return None
    return f"{latency_per_image_s:.1f}s"


def ansi_bold(text: str) -> str:
    return f"\x1b[1m{text}\x1b[22m"


def ansi_highlight(text: str) -> str:
    return f"\x1b[1m\x1b[38;2;107;214;255m{text}\x1b[39m\x1b[22m"
