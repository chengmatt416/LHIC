"""LHIC Benchmark Learning Loop

Implements task→SlowPath→learned→FastPath reuse across tasks.

Flow:
1. Task arrives → check learned skills
2. No match → Slow Path (LLM) → execute → verify
3. Success + verified → learn skill → store
4. Next similar task → Fast Path (learned skill) → no LLM needed

This is the core value proposition: "learns once, replays instantly".
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class LearnedSkill:
    """A skill learned from successful task execution."""

    skill_id: str
    goal_pattern: str  # Normalized goal pattern for matching
    actions: list[dict[str, Any]]
    verification: dict[str, Any]

    # Metadata
    learned_from_task: str
    learned_at: float
    use_count: int = 0
    success_count: int = 0
    failure_count: int = 0

    # Matching
    keywords: list[str] = field(default_factory=list)
    site_patterns: list[str] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / max(1, total)

    @property
    def confidence(self) -> float:
        """Confidence score based on use count and success rate."""
        use_factor = min(1.0, self.use_count / 10)  # Saturates at 10 uses
        return self.success_rate * 0.7 + use_factor * 0.3


@dataclass
class SkillMatch:
    """Result of matching a task to a learned skill."""

    skill: LearnedSkill
    confidence: float
    match_reason: str


class BenchmarkLearningLoop:
    """Manages skill learning and reuse across benchmark tasks."""

    def __init__(self, enable_learning: bool = True):
        self.enable_learning = enable_learning
        self._skills: dict[str, LearnedSkill] = {}
        self._task_history: list[dict[str, Any]] = []

        # Anti-hardcoding: track task-specific patterns
        self._benchmark_patterns: set[str] = set()

    def find_skill(
        self,
        goal: str,
        site: str = "",
        pruned_html: str = "",
    ) -> Optional[SkillMatch]:
        """Find a learned skill matching the goal."""
        if not self.enable_learning:
            return None

        goal_normalized = self._normalize_goal(goal)
        goal_keywords = self._extract_keywords(goal)

        best_match: Optional[SkillMatch] = None
        best_confidence = 0.0

        for skill in self._skills.values():
            # Check keyword overlap
            keyword_overlap = len(goal_keywords & set(skill.keywords))
            if keyword_overlap < 2:
                continue

            # Check site pattern match
            site_match = any(
                pattern in site for pattern in skill.site_patterns
            ) if skill.site_patterns else True

            if not site_match:
                continue

            # Calculate confidence
            keyword_score = keyword_overlap / max(1, len(goal_keywords))
            confidence = skill.confidence * keyword_score

            if confidence > best_confidence and confidence > 0.5:
                best_confidence = confidence
                best_match = SkillMatch(
                    skill=skill,
                    confidence=confidence,
                    match_reason=f"Keywords: {keyword_overlap}, Site: {site_match}",
                )

        if best_match:
            best_match.skill.use_count += 1

        return best_match

    def learn_skill(
        self,
        goal: str,
        actions: list[dict[str, Any]],
        verification: dict[str, Any],
        site: str = "",
        task_id: str = "",
    ) -> Optional[LearnedSkill]:
        """Learn a skill from successful task execution."""
        if not self.enable_learning:
            return None

        # Only learn from verified successes
        if not verification.get("passed", False):
            return None

        # Anti-hardcoding: check if this is a benchmark-specific pattern
        if self._is_benchmark_specific(goal, site):
            return None

        # Generate skill ID
        skill_id = self._generate_skill_id(goal, actions)

        # Check if skill already exists
        if skill_id in self._skills:
            existing = self._skills[skill_id]
            existing.success_count += 1
            return existing

        # Create new skill
        skill = LearnedSkill(
            skill_id=skill_id,
            goal_pattern=self._normalize_goal(goal),
            actions=actions,
            verification=verification,
            learned_from_task=task_id,
            learned_at=time.time(),
            keywords=list(self._extract_keywords(goal)),
            site_patterns=[site] if site else [],
        )

        self._skills[skill_id] = skill

        # Track in history
        self._task_history.append({
            "task_id": task_id,
            "goal": goal,
            "site": site,
            "skill_id": skill_id,
            "learned_at": time.time(),
        })

        return skill

    def record_outcome(
        self,
        skill_id: str,
        success: bool,
        verification: dict[str, Any],
    ) -> None:
        """Record the outcome of using a learned skill."""
        if skill_id in self._skills:
            skill = self._skills[skill_id]
            if success:
                skill.success_count += 1
            else:
                skill.failure_count += 1

    def get_transferable_skills(
        self,
        target_site: str,
    ) -> list[LearnedSkill]:
        """Get skills that can transfer to a new site."""
        transferable = []

        for skill in self._skills.values():
            # Skills with high success rate can transfer
            if skill.success_rate >= 0.8 and skill.use_count >= 2:
                transferable.append(skill)

        return transferable

    def _normalize_goal(self, goal: str) -> str:
        """Normalize goal for matching."""
        # Lowercase
        normalized = goal.lower()

        # Remove common prefixes
        for prefix in ["search for", "find a", "find the", "locate a", "look for"]:
            if normalized.startswith(prefix):
                normalized = normalized[len(prefix):].strip()
                break

        # Remove common suffixes
        for suffix in ["on allrecipes", "on amazon", "on github", "on espn"]:
            idx = normalized.find(suffix)
            if idx > 0:
                normalized = normalized[:idx].strip()

        return normalized

    def _extract_keywords(self, goal: str) -> set[str]:
        """Extract meaningful keywords from goal."""
        # Remove common words
        stop_words = {
            "a", "an", "the", "is", "are", "was", "were", "be", "been",
            "being", "have", "has", "had", "do", "does", "did", "will",
            "would", "could", "should", "may", "might", "can", "shall",
            "on", "in", "at", "to", "for", "with", "from", "by", "of",
            "that", "which", "who", "whom", "this", "these", "those",
            "and", "or", "but", "if", "then", "else", "when", "where",
            "how", "what", "why", "not", "no", "nor", "so", "up", "out",
        }

        words = re.findall(r'\b\w+\b', goal.lower())
        return {w for w in words if w not in stop_words and len(w) > 2}

    def _generate_skill_id(
        self,
        goal: str,
        actions: list[dict[str, Any]],
    ) -> str:
        """Generate deterministic skill ID."""
        content = json.dumps({
            "goal_normalized": self._normalize_goal(goal),
            "action_types": [a.get("type", "") for a in actions],
        }, sort_keys=True)

        return hashlib.sha256(content.encode()).hexdigest()[:16]

    def _is_benchmark_specific(self, goal: str, site: str) -> bool:
        """Check if goal is benchmark-specific (anti-hardcoding)."""
        # Check for benchmark-specific patterns
        benchmark_indicators = [
            "webarena",
            "osworld",
            "taubench",
            "workarena",
            "test task",
            "benchmark task",
        ]

        goal_lower = goal.lower()
        for indicator in benchmark_indicators:
            if indicator in goal_lower:
                return True

        # Check for overly specific patterns
        # (e.g., "Find the exact recipe for X on Y with Z reviews")
        if len(goal.split()) > 20:  # Very long, specific goals
            return True

        return False

    def get_stats(self) -> dict[str, Any]:
        """Get learning loop statistics."""
        total_uses = sum(s.use_count for s in self._skills.values())
        total_successes = sum(s.success_count for s in self._skills.values())

        return {
            "total_skills": len(self._skills),
            "total_uses": total_uses,
            "total_successes": total_successes,
            "avg_success_rate": total_successes / max(1, total_uses),
            "skills_with_reuse": sum(
                1 for s in self._skills.values() if s.use_count > 1
            ),
        }
