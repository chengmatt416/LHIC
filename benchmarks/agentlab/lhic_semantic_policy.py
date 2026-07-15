"""Deterministic semantic-BID policy used by the initial AgentLab adapter.

The policy intentionally supports only low-risk searches. Unsupported or
high-risk goals return BrowserGym's explicit infeasible action instead of
guessing. This keeps debug benchmark traces interpretable and fail-closed.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from typing import Literal


ActionPhase = Literal["initial", "filled", "submitted"]


@dataclass(frozen=True)
class SemanticBidControl:
    bid: str
    tag: str
    accessible_name: str
    input_type: str


@dataclass(frozen=True)
class PolicyDecision:
    action: str
    phase: ActionPhase
    reason: str


_DESTRUCTIVE_PATTERN = re.compile(
    r"\b(delete|remove|destroy|pay|purchase|send(?:\s+external)?\s+email|production\s+write|transfer)\b",
    re.IGNORECASE,
)
_SEARCH_PATTERN = re.compile(r"\b(search|find|look\s+up|lookup)\b", re.IGNORECASE)
_QUERY_PATTERN = re.compile(
    r"(?:search|find|look\s+up|lookup)\s+(?:for\s+)?[\"']?(.+?)[\"']?(?:\s+on\s+https?://|$)",
    re.IGNORECASE,
)
_FORM_FILL_PATTERN = re.compile(
    r"\b(?:fill|enter|type)\s+(?:the\s+)?(.+?)\s+(?:with|as)\s+[\"']?(.+?)[\"']?(?:$|\.)",
    re.IGNORECASE,
)
_TAG_PATTERN = re.compile(r"<(input|textarea|select)(?:\s+[^>]*?)?>", re.IGNORECASE)
_ATTRIBUTE_PATTERN = re.compile(
    r"([:\w-]+)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))",
    re.IGNORECASE,
)


def propose_action(goal: str, pruned_html: str, phase: ActionPhase = "initial") -> PolicyDecision:
    """Produce one BrowserGym high-level action for a safe search flow."""

    if _DESTRUCTIVE_PATTERN.search(goal):
        return _infeasible("High-risk goals require human confirmation.", phase)

    query = _extract_search_query(goal)
    if query:
        return _propose_search(query, pruned_html, phase)

    form_fill = _extract_form_fill(goal)
    if form_fill:
        return _propose_form_fill(*form_fill, pruned_html, phase)

    return _infeasible(
        "Only explicit search or single-field fill goals are supported by this adapter.",
        phase,
    )


def extract_semantic_controls(pruned_html: str) -> list[SemanticBidControl]:
    """Extract input-like BrowserGym controls using only standard-library parsing."""

    controls: list[SemanticBidControl] = []
    for match in _TAG_PATTERN.finditer(pruned_html):
        tag = match.group(1).lower()
        attributes = _parse_attributes(match.group(0))
        bid = attributes.get("bid")
        if not bid:
            continue
        accessible_name = " ".join(
            value
            for value in (
                attributes.get("aria-label"),
                attributes.get("placeholder"),
                attributes.get("name"),
                attributes.get("title"),
            )
            if value
        )
        controls.append(
            SemanticBidControl(
                bid=bid,
                tag=tag,
                accessible_name=html.unescape(accessible_name),
                input_type=attributes.get("type", tag).lower(),
            )
        )
    return controls


def _find_search_control(pruned_html: str) -> SemanticBidControl | None:
    for control in extract_semantic_controls(pruned_html):
        if control.input_type == "search" or _SEARCH_PATTERN.search(
            control.accessible_name
        ):
            return control
    return None


def _propose_search(
    query: str, pruned_html: str, phase: ActionPhase
) -> PolicyDecision:
    search_control = _find_search_control(pruned_html)
    if not search_control:
        return _infeasible("No semantic search control with a BrowserGym BID was found.", phase)

    if phase == "initial":
        return PolicyDecision(
            action=f"fill({json.dumps(search_control.bid)}, {json.dumps(query)})",
            phase="filled",
            reason=f"Filled semantic search control {search_control.bid}.",
        )
    if phase == "filled":
        return PolicyDecision(
            action=f"press({json.dumps(search_control.bid)}, 'ENTER')",
            phase="submitted",
            reason=f"Submitted semantic search control {search_control.bid}.",
        )
    return _infeasible("Search was already submitted; awaiting benchmark completion.", phase)


def _propose_form_fill(
    field_name: str, value: str, pruned_html: str, phase: ActionPhase
) -> PolicyDecision:
    control = _find_named_control(pruned_html, field_name)
    if not control:
        return _infeasible(
            "No semantic form control with a BrowserGym BID matched the requested field.",
            phase,
        )
    if control.tag == "select":
        return _infeasible(
            "Select controls require a verified option policy before this adapter can act.",
            phase,
        )
    if phase == "initial":
        return PolicyDecision(
            action=f"fill({json.dumps(control.bid)}, {json.dumps(value)})",
            phase="filled",
            reason=f"Filled semantic form control {control.bid}.",
        )
    return _infeasible(
        "The single-field fill was already issued; awaiting benchmark verification.",
        phase,
    )


def _find_named_control(
    pruned_html: str, field_name: str
) -> SemanticBidControl | None:
    normalized_field_name = _normalize(field_name)
    if not normalized_field_name:
        return None
    for control in extract_semantic_controls(pruned_html):
        normalized_name = _normalize(control.accessible_name)
        if normalized_name and (
            normalized_name == normalized_field_name
            or normalized_field_name in normalized_name
            or normalized_name in normalized_field_name
        ):
            return control
    return None


def _extract_search_query(goal: str) -> str | None:
    match = _QUERY_PATTERN.search(goal)
    if not match:
        return None
    query = match.group(1).strip()
    return query or None


def _extract_form_fill(goal: str) -> tuple[str, str] | None:
    match = _FORM_FILL_PATTERN.search(goal)
    if not match:
        return None
    field_name, value = (part.strip() for part in match.groups())
    if not field_name or not value:
        return None
    return field_name, value


def _parse_attributes(tag: str) -> dict[str, str]:
    attributes: dict[str, str] = {}
    for match in _ATTRIBUTE_PATTERN.finditer(tag):
        name = match.group(1).lower()
        value = next(
            (candidate for candidate in match.groups()[1:] if candidate is not None),
            "",
        )
        attributes[name] = html.unescape(value)
    return attributes


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _infeasible(reason: str, phase: ActionPhase) -> PolicyDecision:
    return PolicyDecision(
        action=f"report_infeasible({json.dumps(reason)})",
        phase=phase,
        reason=reason,
    )
