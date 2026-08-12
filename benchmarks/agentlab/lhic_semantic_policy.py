"""Deterministic semantic-BID policy used by the initial AgentLab adapter.

The policy executes only low-risk, single-step interactions that can be bound
to a BrowserGym BID in the current observation. It deliberately reports
infeasible rather than guessing when it cannot identify a semantic target or an
action may cause an external side effect.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Literal


ActionPhase = Literal[
    "initial", "filled", "selected", "clicked", "submitted", "navigated"
]


@dataclass(frozen=True)
class SemanticBidControl:
    bid: str
    tag: str
    accessible_name: str
    input_type: str
    role: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class PolicyDecision:
    action: str
    phase: ActionPhase
    reason: str


@dataclass(frozen=True)
class PlanState:
    step_index: int = 0
    phase: ActionPhase = "initial"


@dataclass(frozen=True)
class PlanDecision:
    decision: PolicyDecision
    next_state: PlanState
    step_count: int
    completed: bool


_DESTRUCTIVE_PATTERN = re.compile(
    r"\b(delete|remove|destroy|pay|purchase|send(?:\s+external)?\s+email|production\s+write|transfer)\b",
    re.IGNORECASE,
)
_SIDE_EFFECT_CONTROL_PATTERN = re.compile(
    r"\b(delete|remove|destroy|pay|purchase|send|submit|save|confirm|apply|checkout|transfer)\b",
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
_SELECT_PATTERN = re.compile(
    r"\b(?:select|choose|pick)\s+(?:the\s+)?(.+?)\s+(?:option\s+)?(?:with|as|to)\s+[\"']?(.+?)[\"']?(?:$|\.)",
    re.IGNORECASE,
)
_SELECT_FROM_PATTERN = re.compile(
    r"\b(?:select|choose|pick)\s+[\"']?(.+?)[\"']?\s+(?:from|in)\s+(?:the\s+)?(.+?)(?:$|\.)",
    re.IGNORECASE,
)
_CLICK_PATTERN = re.compile(
    r"\b(?:click|open|view)\s+(?:on\s+)?(?:the\s+)?[\"']?(.+?)[\"']?(?:$|\.)",
    re.IGNORECASE,
)
_PLAN_SEPARATOR_PATTERN = re.compile(r"\b(?:and\s+then|then)\b", re.IGNORECASE)
_URL_NAVIGATION_PATTERN = re.compile(
    r"\b(?:go|navigate|browse|visit|open)\s+(?:to\s+)?"
    r"(?P<url>https?://[^\s\"'<>]+)",
    re.IGNORECASE,
)
_KNOWLEDGE_NAVIGATION_PATTERN = re.compile(
    r"\bnavigate\s+to\s+a\s+relevant\s+article\s+in\s+the\s+knowledge\s+base\s+"
    r"by\s+searching\s+for:\s*[\"'](?P<query>.+?)[\"']\s+and\s+open\s+"
    r"the\s+article:\s*[\"'](?P<article>.+?)[\"']\s*\.?$",
    re.IGNORECASE,
)
_MENU_NAVIGATION_PATTERN = re.compile(
    r"\bnavigate\s+to\s+the\s+[\"'](?P<module>.+?)[\"']\s+module\s+of\s+"
    r"the\s+[\"'](?P<application>.+?)[\"']\s+application\s*\.?$",
    re.IGNORECASE,
)
_WORKARENA_FORM_FIELD_PATTERN = re.compile(
    r'\ba\s+value\s+of\s+"(?P<value>[^"]*)"\s+for\s+field\s+"(?P<field>[^"]+)"',
    re.IGNORECASE,
)
_CONTROL_TAGS = {
    "input",
    "textarea",
    "select",
    "button",
    "a",
    "div",
    "span",
    "li",
}
_TEXT_CONTROL_TAGS = {"button", "a", "div", "span", "li"}
_INTERACTIVE_ROLES = {
    "button",
    "checkbox",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "switch",
    "tab",
    "treeitem",
}


class _SemanticControlParser(HTMLParser):
    """Collect BrowserGym BID controls without depending on a browser runtime."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.controls: list[SemanticBidControl] = []
        self._raw_controls: list[tuple[str, dict[str, str], str]] = []
        self._labels_by_for: dict[str, list[str]] = {}
        self._open_text_nodes: list[tuple[str, dict[str, str], list[str]]] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        normalized_tag = tag.lower()
        if normalized_tag != "label" and normalized_tag not in _CONTROL_TAGS:
            return
        attributes = {
            name.lower(): value or "" for name, value in attrs if name is not None
        }
        if normalized_tag == "label":
            self._open_text_nodes.append((normalized_tag, attributes, []))
            return
        if not attributes.get("bid"):
            return
        if normalized_tag in {"div", "span", "li"} and (
            attributes.get("role", "").lower() not in _INTERACTIVE_ROLES
        ):
            return
        if (
            "disabled" in attributes
            or attributes.get("aria-disabled", "").lower() == "true"
            or "hidden" in attributes
            or attributes.get("aria-hidden", "").lower() == "true"
            or attributes.get("type", "").lower() == "hidden"
            or "readonly" in attributes
        ):
            return
        if normalized_tag in _TEXT_CONTROL_TAGS:
            self._open_text_nodes.append((normalized_tag, attributes, []))
            return
        self._raw_controls.append((normalized_tag, attributes, ""))

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        for _, _, text in self._open_text_nodes:
            text.append(data)

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.lower()
        for index in range(len(self._open_text_nodes) - 1, -1, -1):
            open_tag, attributes, text = self._open_text_nodes[index]
            if normalized_tag != open_tag:
                continue
            text_content = " ".join(text)
            if open_tag == "label":
                control_id = attributes.get("for", "").strip()
                if control_id:
                    self._labels_by_for.setdefault(control_id, []).append(text_content)
            else:
                self._raw_controls.append((open_tag, attributes, text_content))
            del self._open_text_nodes[index]
            return

    def finish(self) -> None:
        while self._open_text_nodes:
            tag, attributes, text = self._open_text_nodes.pop()
            text_content = " ".join(text)
            if tag == "label":
                control_id = attributes.get("for", "").strip()
                if control_id:
                    self._labels_by_for.setdefault(control_id, []).append(text_content)
            else:
                self._raw_controls.append((tag, attributes, text_content))
        self.controls = [
            _make_control(
                tag,
                attributes,
                text,
                " ".join(self._labels_by_for.get(attributes.get("id", ""), [])),
            )
            for tag, attributes, text in self._raw_controls
        ]


def propose_action(
    goal: str, pruned_html: str, phase: ActionPhase = "initial"
) -> PolicyDecision:
    """Produce one safe BrowserGym high-level action from semantic controls."""

    if _DESTRUCTIVE_PATTERN.search(goal):
        return _infeasible("High-risk goals require human confirmation.", phase)
    navigation_url = _extract_navigation_url(goal)
    if navigation_url:
        if phase != "initial":
            return _infeasible(
                "Navigation was already issued; awaiting benchmark completion.", phase
            )
        return PolicyDecision(
            action=f"goto({json.dumps(navigation_url)})",
            phase="navigated",
            reason=f"Navigated to the explicit HTTP(S) URL {navigation_url}.",
        )

    query = _extract_search_query(goal)
    if query:
        return _propose_search(query, pruned_html, phase)

    form_fill = _extract_form_fill(goal)
    if form_fill:
        return _propose_form_fill(*form_fill, pruned_html, phase)

    select = _extract_select(goal)
    if select:
        return _propose_select(*select, pruned_html, phase)

    click_target = _extract_click_target(goal)
    if click_target:
        return _propose_click(click_target, pruned_html, phase)

    return _infeasible(
        "Only explicit HTTP(S) navigation, semantic search, field fill, select, "
        "or safe click goals are supported by this adapter.",
        phase,
    )


def propose_plan_action(
    goal: str, pruned_html: str, state: PlanState = PlanState()
) -> PlanDecision:
    """Advance one explicit low-risk instruction from a semantic goal plan.

    A plan is intentionally limited to instructions separated by ``then`` or
    ``and then``. This makes every action traceable to an explicit user clause
    and lets the next action bind against a fresh BrowserGym observation.
    """

    steps = _split_goal_steps(goal)
    if state.step_index >= len(steps):
        return PlanDecision(
            decision=PolicyDecision(
                action="noop()",
                phase=state.phase,
                reason="The explicit semantic plan is complete; awaiting benchmark completion.",
            ),
            next_state=state,
            step_count=len(steps),
            completed=True,
        )

    step = steps[state.step_index]
    decision = propose_action(step, pruned_html, state.phase)
    if decision.action.startswith("report_infeasible("):
        return PlanDecision(
            decision=decision,
            next_state=state,
            step_count=len(steps),
            completed=False,
        )

    if _extract_search_query(step) and decision.phase == "filled":
        next_state = PlanState(step_index=state.step_index, phase="filled")
    else:
        next_state = PlanState(step_index=state.step_index + 1, phase="initial")
    return PlanDecision(
        decision=decision,
        next_state=next_state,
        step_count=len(steps),
        completed=next_state.step_index >= len(steps),
    )


def extract_semantic_controls(pruned_html: str) -> list[SemanticBidControl]:
    """Extract BrowserGym controls with BIDs using standard-library HTML parsing."""

    parser = _SemanticControlParser()
    parser.feed(pruned_html)
    parser.close()
    parser.finish()
    return parser.controls


def _make_control(
    tag: str, attributes: dict[str, str], text: str, label_text: str = ""
) -> SemanticBidControl:
    raw_aliases = (
        attributes.get("aria-label"),
        label_text,
        attributes.get("placeholder"),
        attributes.get("title"),
        text,
        attributes.get("name"),
        attributes.get("value"),
    )
    aliases = tuple(
        dict.fromkeys(
            html.unescape(value.strip())
            for value in raw_aliases
            if value and value.strip()
        )
    )
    return SemanticBidControl(
        bid=attributes["bid"],
        tag=tag,
        accessible_name=" ".join(aliases),
        input_type=attributes.get("type", tag).lower(),
        role=attributes.get("role", "").lower(),
        aliases=aliases,
    )


def _find_search_control(pruned_html: str) -> SemanticBidControl | None:
    for control in extract_semantic_controls(pruned_html):
        if (
            control.input_type == "search"
            or control.role in {"search", "searchbox"}
            or any(_SEARCH_PATTERN.search(alias) for alias in control.aliases)
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
            action=f"press({json.dumps(search_control.bid)}, 'Enter')",
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
            "Select controls require an explicit select or choose instruction.", phase
        )
    if phase == "initial":
        return PolicyDecision(
            action=f"fill({json.dumps(control.bid)}, {json.dumps(value)})",
            phase="filled",
            reason=f"Filled semantic form control {control.bid}.",
        )
    return _infeasible(
        "The single-field fill was already issued; awaiting verification.", phase
    )


def _propose_select(
    field_name: str, value: str, pruned_html: str, phase: ActionPhase
) -> PolicyDecision:
    control = _find_named_control(pruned_html, field_name, allowed_tags={"select"})
    if not control:
        return _infeasible(
            "No semantic select control with a BrowserGym BID matched the requested field.",
            phase,
        )
    if phase == "initial":
        return PolicyDecision(
            action=f"select_option({json.dumps(control.bid)}, {json.dumps(value)})",
            phase="selected",
            reason=f"Selected an option in semantic control {control.bid}.",
        )
    return _infeasible(
        "The select action was already issued; awaiting verification.", phase
    )


def _propose_click(
    target: str, pruned_html: str, phase: ActionPhase
) -> PolicyDecision:
    control = _find_named_control(
        pruned_html, target, allowed_tags={"button", "a", "div", "span", "li"}
    )
    if not control:
        return _infeasible(
            "No safe semantic button or link with a BrowserGym BID matched the requested target.",
            phase,
        )
    if _SIDE_EFFECT_CONTROL_PATTERN.search(control.accessible_name):
        return _infeasible(
            "The matched click target may have an external side effect and requires human confirmation.",
            phase,
        )
    if phase == "initial":
        return PolicyDecision(
            action=f"click({json.dumps(control.bid)})",
            phase="clicked",
            reason=f"Clicked safe semantic control {control.bid}.",
        )
    return _infeasible(
        "The click action was already issued; awaiting verification.", phase
    )


def _find_named_control(
    pruned_html: str, field_name: str, allowed_tags: set[str] | None = None
) -> SemanticBidControl | None:
    normalized_field_name = _normalize(field_name)
    if not normalized_field_name:
        return None
    exact_matches: list[SemanticBidControl] = []
    partial_matches: list[SemanticBidControl] = []
    for control in extract_semantic_controls(pruned_html):
        if allowed_tags is not None and control.tag not in allowed_tags:
            continue
        normalized_aliases = {
            normalized
            for alias in control.aliases or (control.accessible_name,)
            if (normalized := _normalize(alias))
        }
        if normalized_field_name in normalized_aliases:
            exact_matches.append(control)
        elif any(
            normalized_field_name in normalized
            or normalized in normalized_field_name
            for normalized in normalized_aliases
        ):
            partial_matches.append(control)

    if len(exact_matches) == 1:
        return exact_matches[0]
    if len(exact_matches) > 1:
        return None
    if len(partial_matches) == 1:
        return partial_matches[0]
    return None


def _extract_navigation_url(goal: str) -> str | None:
    match = _URL_NAVIGATION_PATTERN.search(goal)
    if not match:
        return None
    url = match.group("url").rstrip(".,;:!?)]}")
    return url or None


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


def _extract_select(goal: str) -> tuple[str, str] | None:
    match = _SELECT_PATTERN.search(goal)
    if match:
        field_name, value = (part.strip() for part in match.groups())
        if field_name and value:
            return field_name, value
    match = _SELECT_FROM_PATTERN.search(goal)
    if match:
        value, field_name = (part.strip() for part in match.groups())
        if field_name and value:
            return field_name, value
    return None


def _extract_click_target(goal: str) -> str | None:
    match = _CLICK_PATTERN.search(goal)
    if not match:
        return None
    target = match.group(1).strip()
    return target or None


def _split_goal_steps(goal: str) -> list[str]:
    knowledge_navigation = _KNOWLEDGE_NAVIGATION_PATTERN.search(goal)
    if knowledge_navigation:
        return [
            f'Search for "{knowledge_navigation.group("query")}"',
            f'Open "{knowledge_navigation.group("article")}"',
        ]
    menu_navigation = _MENU_NAVIGATION_PATTERN.search(goal)
    if menu_navigation:
        module_path = menu_navigation.group("module")
        final_module = module_path.split(">")[-1].strip()
        return [
            'Open "All"',
            f'Fill Filter with "{menu_navigation.group("application")}"',
            f'Open "{final_module}"',
        ]
    form_fields = _WORKARENA_FORM_FIELD_PATTERN.findall(goal)
    if goal.lstrip().lower().startswith("create a new ") and form_fields:
        return [f'Fill "{field}" with "{value}"' for value, field in form_fields]
    steps = [step.strip(" .") for step in _PLAN_SEPARATOR_PATTERN.split(goal)]
    return [step for step in steps if step]


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _infeasible(reason: str, phase: ActionPhase) -> PolicyDecision:
    return PolicyDecision(
        action=f"report_infeasible({json.dumps(reason)})",
        phase=phase,
        reason=reason,
    )
