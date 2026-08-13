//! Decision routing: fast-path skills vs the guarded agent slow path.

use serde::Serialize;

use crate::memory::MemoryStore;
use crate::skills::SkillDocument;

#[derive(Debug, Clone, Serialize)]
pub struct RouteDecision {
    pub path: PathKind,
    pub confidence: f64,
    pub reason: String,
    /// Fast-path skill matched by intent (empty for the slow path).
    pub skill: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathKind {
    FastPath,
    SlowPath,
}

/// Routes a task intent to a fast-path skill or the agent slow path.
///
/// The alpha scorer is keyword-based: a strong overlap between the intent and
/// a reviewed skill's name/description/tags routes to that skill; otherwise
/// the guarded agent path is chosen.
pub fn route(
    intent: &str,
    skills: &[SkillDocument],
    _memory: &MemoryStore,
) -> RouteDecision {
    let tokens = tokenize(intent);
    let mut best: Option<(&SkillDocument, f64, usize)> = None;
    for skill in skills {
        let haystack = format!(
            "{} {} {}",
            skill.name.to_lowercase(),
            skill.description.to_lowercase(),
            skill
                .tags
                .as_ref()
                .map(|tags| tags.join(" "))
                .unwrap_or_default()
                .to_lowercase()
        );
        let mut hits = 0usize;
        for token in &tokens {
            if haystack.contains(token) {
                hits += 1;
            }
        }
        if hits == 0 {
            continue;
        }
        let coverage = hits as f64 / tokens.len().max(1) as f64;
        if hits >= 2 && coverage >= 0.3
            && best.as_ref().is_none_or(|(_, score, _)| coverage > *score)
        {
            best = Some((skill, coverage, hits));
        }
    }
    match best {
        Some((skill, coverage, _)) => RouteDecision {
            path: PathKind::FastPath,
            confidence: coverage.min(1.0),
            reason: format!("intent matches reviewed skill \"{}\"", skill.name),
            skill: Some(skill.name.clone()),
        },
        None => RouteDecision {
            path: PathKind::SlowPath,
            confidence: 0.0,
            reason: "no reviewed skill covers this intent; guarded agent path".to_string(),
            skill: None,
        },
    }
}

fn tokenize(input: &str) -> Vec<String> {
    input
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| token.len() >= 3)
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, description: &str, tags: &[&str]) -> SkillDocument {
        SkillDocument {
            id: format!("skill-{}", name),
            name: name.to_string(),
            description: description.to_string(),
            category: None,
            tags: Some(tags.iter().map(|t| t.to_string()).collect()),
            rating: None,
            downloads: None,
            version: None,
            extra: Default::default(),
        }
    }

    fn memory_at() -> MemoryStore {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lhic-route-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        MemoryStore::open(&dir.join("memory.sqlite")).unwrap()
    }

    #[test]
    fn routes_matching_intent_to_fast_path() {
        let skills = vec![
            skill("daily workflow", "complete login, search, and form updates", &["login", "form"]),
            skill("pdf merge", "merge multiple pdf documents", &["pdf", "documents"]),
        ];
        let mut memory = memory_at();
        let decision = route("merge these pdf documents into one file", &skills, &mut memory);
        assert_eq!(decision.path, PathKind::FastPath);
        assert_eq!(decision.skill.as_deref(), Some("pdf merge"));
        assert!(decision.confidence >= 0.4);
    }

    #[test]
    fn routes_unmatched_intent_to_slow_path() {
        let skills = vec![skill("pdf merge", "merge pdf documents", &["pdf"])];
        let mut memory = memory_at();
        let decision = route("investigate the failing build pipeline", &skills, &mut memory);
        assert_eq!(decision.path, PathKind::SlowPath);
        assert!(decision.skill.is_none());
    }
}
