#!/usr/bin/env python3
"""Compute discoverability KPIs from AI visibility probe outputs."""

from __future__ import annotations

import argparse
import glob
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BROOD_WORD_RE_TEMPLATE = r"\b{}\b"


def _expand_paths(values: list[str]) -> list[Path]:
    out: list[Path] = []
    for value in values:
        matches = glob.glob(value)
        if matches:
            out.extend(Path(m) for m in matches)
        else:
            out.append(Path(value))
    deduped: list[Path] = []
    seen: set[str] = set()
    for path in out:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(path)
    return deduped


def _parse_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists() or not path.is_file():
        return rows
    with path.open("r", encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                rows.append(payload)
    return rows


def _parse_json(path: Path) -> dict[str, Any] | None:
    if not path.exists() or not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _mentioned(record: dict[str, Any], brood_re: re.Pattern[str]) -> bool:
    mention = record.get("mention")
    if isinstance(mention, dict):
        flagged = mention.get("mentioned")
        if isinstance(flagged, bool):
            return flagged
    text = str(record.get("response_text", "") or "")
    return bool(brood_re.search(text))


def _safe_rate(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def _select_latest_traffic(traffic_payloads: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not traffic_payloads:
        return None

    def key_fn(payload: dict[str, Any]) -> tuple[str, str]:
        ts = str(payload.get("timestamp_utc", "") or "")
        run_id = str(payload.get("run_id", "") or "")
        return (ts, run_id)

    return sorted(traffic_payloads, key=key_fn)[-1]


def compute_kpis(
    result_paths: list[Path],
    traffic_paths: list[Path],
    brand_token: str,
) -> dict[str, Any]:
    brand_re = re.compile(BROOD_WORD_RE_TEMPLATE.format(re.escape(brand_token)), re.IGNORECASE)
    probe_records: list[dict[str, Any]] = []
    for path in result_paths:
        for row in _parse_jsonl(path):
            if str(row.get("record_type", "")).strip() == "probe_result":
                probe_records.append(row)

    total = 0
    prompted_total = 0
    prompted_mentions = 0
    unprompted_total = 0
    unprompted_mentions = 0
    mention_by_provider: dict[str, dict[str, int]] = defaultdict(lambda: {"mentions": 0, "total": 0})

    for row in probe_records:
        query_text = str(row.get("query_text", "") or "")
        is_prompted = bool(brand_re.search(query_text))
        is_mentioned = _mentioned(row, brand_re)
        provider = str(row.get("provider", "") or "unknown").strip() or "unknown"

        total += 1
        mention_by_provider[provider]["total"] += 1
        if is_mentioned:
            mention_by_provider[provider]["mentions"] += 1

        if is_prompted:
            prompted_total += 1
            if is_mentioned:
                prompted_mentions += 1
        else:
            unprompted_total += 1
            if is_mentioned:
                unprompted_mentions += 1

    traffic_payloads: list[dict[str, Any]] = []
    for path in traffic_paths:
        payload = _parse_json(path)
        if payload and str(payload.get("record_type", "")).strip() == "github_traffic_snapshot":
            traffic_payloads.append(payload)

    latest_traffic = _select_latest_traffic(traffic_payloads)

    traffic_summary: dict[str, Any] = {
        "available": bool(latest_traffic),
    }
    if latest_traffic:
        metrics = latest_traffic.get("metrics") if isinstance(latest_traffic.get("metrics"), dict) else {}
        referrers = latest_traffic.get("referrers") if isinstance(latest_traffic.get("referrers"), dict) else {}
        rows = referrers.get("rows") if isinstance(referrers.get("rows"), list) else []
        external_unique_total = 0
        channel_uniques: dict[str, int] = defaultdict(int)
        for row in rows:
            if not isinstance(row, dict):
                continue
            channel = str(row.get("channel", "") or "unknown").strip() or "unknown"
            referrer = str(row.get("referrer", "") or "").strip().lower()
            uniques = int(row.get("uniques", 0) or 0)
            is_internal = channel == "github_internal" or referrer == "github.com"
            if is_internal:
                continue
            external_unique_total += uniques
            channel_uniques[channel] += uniques

        traffic_summary.update(
            {
                "run_id": latest_traffic.get("run_id"),
                "timestamp_utc": latest_traffic.get("timestamp_utc"),
                "views_count": ((metrics.get("views") or {}).get("count") if isinstance(metrics.get("views"), dict) else None),
                "views_uniques": ((metrics.get("views") or {}).get("uniques") if isinstance(metrics.get("views"), dict) else None),
                "clones_count": ((metrics.get("clones") or {}).get("count") if isinstance(metrics.get("clones"), dict) else None),
                "clones_uniques": ((metrics.get("clones") or {}).get("uniques") if isinstance(metrics.get("clones"), dict) else None),
                "clone_to_view_ratio": metrics.get("clone_to_view_ratio"),
                "unique_clone_to_unique_view_ratio": metrics.get("unique_clone_to_unique_view_ratio"),
                "external_unique_referrers_total": external_unique_total,
                "external_channel_uniques": dict(sorted(channel_uniques.items(), key=lambda kv: (-kv[1], kv[0]))),
            }
        )

    by_provider = {
        provider: {
            "mentions": values["mentions"],
            "total": values["total"],
            "mention_rate": round(_safe_rate(values["mentions"], values["total"]), 4),
        }
        for provider, values in sorted(mention_by_provider.items())
    }

    return {
        "schema_version": "brood-visibility-kpis-v1",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "inputs": {
            "result_files": [str(p) for p in result_paths],
            "traffic_files": [str(p) for p in traffic_paths],
            "brand_token": brand_token,
        },
        "kpis": {
            "total_probes": total,
            "prompted_probes": prompted_total,
            "prompted_mentions": prompted_mentions,
            "prompted_mention_rate": round(_safe_rate(prompted_mentions, prompted_total), 4),
            "unprompted_probes": unprompted_total,
            "unprompted_mentions": unprompted_mentions,
            "unprompted_mention_rate": round(_safe_rate(unprompted_mentions, unprompted_total), 4),
            "overall_mention_rate": round(_safe_rate(prompted_mentions + unprompted_mentions, total), 4),
            "by_provider": by_provider,
        },
        "traffic": traffic_summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compute AI visibility discoverability KPIs.")
    parser.add_argument(
        "--results",
        nargs="+",
        required=True,
        help="One or more results.jsonl paths or glob patterns.",
    )
    parser.add_argument(
        "--traffic",
        nargs="*",
        default=[],
        help="Optional github_traffic.json paths or glob patterns.",
    )
    parser.add_argument(
        "--brand-token",
        default="brood",
        help="Token used to determine prompted vs unprompted queries (default: brood).",
    )
    parser.add_argument(
        "--json-out",
        default="",
        help="Optional output path for JSON report.",
    )
    args = parser.parse_args()

    result_paths = [p for p in _expand_paths(args.results) if p.exists()]
    traffic_paths = [p for p in _expand_paths(args.traffic) if p.exists()]
    if not result_paths:
        print("No result files found. Pass at least one valid results.jsonl path.")
        return 1

    report = compute_kpis(result_paths, traffic_paths, args.brand_token)
    print(json.dumps(report, indent=2))

    json_out = str(args.json_out or "").strip()
    if json_out:
        out_path = Path(json_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote KPI report to {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
