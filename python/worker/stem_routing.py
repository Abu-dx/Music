"""
Stem-level routing planner (Phase 2.5 prep, base-only execution).

This module is intentionally pure-data:
- no subprocess
- no filesystem access
- no protocol changes

It reserves a stable routing location for future per-stem specialized runners/models,
while keeping current execution in base-only mode.
"""

import json
from typing import Dict, List, Optional, Tuple

ROUTING_VERSION = "stem-routing-v1"
ROUTING_MODE_BASE_ONLY = "base_only"

STEM_KEYS = ("vocals", "drums", "bass", "piano", "guitar", "other")
STEM_TYPE_BY_KEY = {
    "vocals": "vocal",
    "drums": "drums",
    "bass": "bass",
    "piano": "keyboard",
    "guitar": "guitar",
    "other": "other",
}

# Reserve explicit capability location. Only active runners can be executed.
# Future specialized runners should be added here before enabling execution.
RUNNER_CAPABILITIES = {
    "demucs": {"availability": "active"},
    "bs_roformer_sw": {"availability": "experimental"},
}


def _normalize_text(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized or None


def _parse_requested_overrides(
    request_id: str,
    requested_config_json: str,
) -> Tuple[Dict[str, Dict[str, str]], List[str]]:
    overrides: Dict[str, Dict[str, str]] = {}
    warnings: List[str] = []

    raw = (requested_config_json or "").strip()
    if not raw:
        return overrides, warnings

    try:
        parsed = json.loads(raw)
    except Exception as exc:
        warnings.append(
            f"request_id={request_id} invalid STEM_ROUTING_CONFIG_JSON: {exc}"
        )
        return overrides, warnings

    if not isinstance(parsed, dict):
        warnings.append(
            f"request_id={request_id} STEM_ROUTING_CONFIG_JSON must be an object"
        )
        return overrides, warnings

    for stem_key, value in parsed.items():
        normalized_stem = _normalize_text(stem_key)
        if not normalized_stem or normalized_stem not in STEM_KEYS:
            warnings.append(
                f"request_id={request_id} ignored unknown stem key: {stem_key}"
            )
            continue
        if not isinstance(value, dict):
            warnings.append(
                f"request_id={request_id} stem override must be object: {stem_key}"
            )
            continue

        runner = _normalize_text(value.get("runner"))
        model = _normalize_text(value.get("model"))
        if not runner and not model:
            continue

        override_payload: Dict[str, str] = {}
        if runner:
            override_payload["runner"] = runner
        if model:
            override_payload["model"] = model
        overrides[normalized_stem] = override_payload

    return overrides, warnings


def build_stem_routing_plan(
    request_id: str,
    base_runner: str,
    base_model: str,
    base_supported_stems: List[str],
    requested_config_json: str = "",
) -> dict:
    """
    Build per-stem route plan in base-only mode.
    Execution remains on base runner/model this round.
    """
    normalized_base_runner = _normalize_text(base_runner) or "demucs"
    normalized_base_model = _normalize_text(base_model) or "htdemucs"
    supported = {
        stem.strip().lower()
        for stem in (base_supported_stems or [])
        if isinstance(stem, str) and stem.strip()
    }

    overrides, warnings = _parse_requested_overrides(request_id, requested_config_json)
    assignments: List[dict] = []

    for stem_key in STEM_KEYS:
        stem_type = STEM_TYPE_BY_KEY[stem_key]
        override = overrides.get(stem_key, {})

        requested_runner = override.get("runner", normalized_base_runner)
        requested_model = override.get("model", normalized_base_model)
        effective_runner = normalized_base_runner
        effective_model = normalized_base_model

        reason = "base_default"
        if stem_type not in supported:
            reason = "base_model_missing_stem"

        if override:
            if requested_runner not in RUNNER_CAPABILITIES:
                reason = "unknown_runner_fallback_base"
                warnings.append(
                    f"request_id={request_id} stem={stem_key} unknown runner={requested_runner}, fallback to base"
                )
            elif requested_runner != normalized_base_runner:
                runner_meta = RUNNER_CAPABILITIES.get(requested_runner, {})
                availability = str(runner_meta.get("availability", "unknown"))
                reason = "deferred_runner_override_base_only"
                warnings.append(
                    f"request_id={request_id} stem={stem_key} requested runner={requested_runner} "
                    f"(availability={availability}) deferred in base-only mode"
                )
            elif requested_model != normalized_base_model:
                reason = "deferred_model_override_base_only"
                warnings.append(
                    f"request_id={request_id} stem={stem_key} requested model={requested_model} deferred in base-only mode"
                )
            else:
                reason = "base_override"

        assignments.append({
            "stem": stem_key,
            "stemType": stem_type,
            "requestedRunner": requested_runner,
            "requestedModel": requested_model,
            "effectiveRunner": effective_runner,
            "effectiveModel": effective_model,
            "emitsFromBaseModel": stem_type in supported,
            "reason": reason,
        })

    return {
        "version": ROUTING_VERSION,
        "routingMode": ROUTING_MODE_BASE_ONLY,
        "assignments": assignments,
        "warnings": warnings,
    }
