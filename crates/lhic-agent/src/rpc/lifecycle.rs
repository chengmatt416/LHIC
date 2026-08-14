//! Lifecycle-aware prompt/turn handling.
//!
//! `prompt` is acknowledged immediately by the engine; an agent turn
//! completes only on an `agent_end` frame with `isTerminal !== false`, a
//! `turn_end`, or a local-only `prompt_result` / `data.agentInvoked: false`.
//! This module turns that wire contract into a blocking-with-streaming API.
//!
//! The turn deadline is enforced with `tokio::time::timeout_at` around every
//! blocking event receive, so a silent-but-alive engine cannot stall the
//! caller past the configured deadline.

use serde_json::Value;
use tokio::time::{Duration, Instant};

use super::client::OmpRpcClient;
use super::error::RpcError;
use super::types::AgentEvent;

/// Default cap on a single prompt turn before `prompt_and_wait` gives up.
pub const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_secs(600);

/// Result of a completed prompt turn.
#[derive(Debug, Clone)]
pub struct PromptOutcome {
    /// Whether the prompt was accepted by the engine.
    pub accepted: bool,
    /// `true` when the engine produced agent lifecycle events for this
    /// prompt; `false` when it resolved locally without an agent turn.
    pub agent_invoked: bool,
    /// Assistant text streamed via `message_update` deltas during the turn.
    pub streamed_text: String,
    /// The engine's raw ack response data.
    pub raw_ack: Value,
}

impl PromptOutcome {
    /// Whether this outcome represents terminal completion. `agent_invoked`
    /// distinguishes local-only prompts from full agent turns; both can be
    /// terminal once the turn has actually completed.
    pub fn is_terminal(&self) -> bool {
        self.accepted
    }
}

/// Sends a prompt and blocks until terminal completion, streaming deltas.
///
/// Completion is driven by engine lifecycle semantics — `agent_end` with
/// `isTerminal !== false`, `turn_end`, or a local-only `prompt_result` /
/// `data.agentInvoked: false` — never by a fixed wall-clock guess.
pub async fn prompt_and_wait(
    client: &OmpRpcClient,
    message: &str,
    timeout: Duration,
) -> Result<PromptOutcome, anyhow::Error> {
    let ack = client
        .prompt(message)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let agent_invoked = ack
        .get("agentInvoked")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut text = String::new();

    // `agentInvoked: false` is a completion signal for local-only prompts.
    if !agent_invoked {
        return Ok(PromptOutcome {
            accepted: true,
            agent_invoked: false,
            streamed_text: String::new(),
            raw_ack: ack,
        });
    }

    let deadline = Instant::now() + timeout;
    let seconds = timeout.as_secs();
    loop {
        // The deadline wraps the blocking receive: a silent engine cannot
        // outlive the configured turn timeout.
        let event = match tokio::time::timeout_at(deadline, client.next_event()).await {
            Ok(Ok(Some(event))) => event,
            Ok(Ok(None)) => {
                return Err(anyhow::anyhow!("omp engine closed during the turn"));
            }
            Ok(Err(e)) => return Err(anyhow::anyhow!("{e}")),
            Err(_) => {
                return Err(anyhow::anyhow!("{}", RpcError::TurnTimeout { seconds }));
            }
        };
        match event {
            AgentEvent::MessageUpdated { raw } => {
                if let Some(delta) = extract_text_delta(&raw) {
                    text.push_str(&delta);
                }
            }
            AgentEvent::AgentEnded { is_terminal, .. } if is_terminal => break,
            AgentEvent::TurnEnded { .. } => break,
            AgentEvent::PromptResolved(result) if !result.agent_invoked => break,
            AgentEvent::ChildClosed => {
                return Err(anyhow::anyhow!("omp engine closed during the turn"));
            }
            _ => {}
        }
    }

    Ok(PromptOutcome {
        accepted: true,
        agent_invoked: true,
        streamed_text: text,
        raw_ack: ack,
    })
}

/// Extracts the streamed assistant text from a `message_update` frame.
fn extract_text_delta(frame: &Value) -> Option<String> {
    let event = frame.get("assistantMessageEvent")?;
    if event.get("type").and_then(Value::as_str) == Some("text_delta") {
        return event
            .get("delta")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    // Some runtimes nest the delta under `message.content` updates.
    frame
        .get("delta")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_text_delta() {
        let frame = serde_json::json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": "hello" }
        });
        assert_eq!(extract_text_delta(&frame).as_deref(), Some("hello"));
    }

    #[test]
    fn local_prompt_is_terminal() {
        let outcome = PromptOutcome {
            accepted: true,
            agent_invoked: false,
            streamed_text: String::new(),
            raw_ack: Value::Null,
        };
        assert!(outcome.is_terminal());
    }

    #[test]
    fn agent_turn_is_also_terminal() {
        let outcome = PromptOutcome {
            accepted: true,
            agent_invoked: true,
            streamed_text: "done".to_string(),
            raw_ack: Value::Null,
        };
        assert!(outcome.is_terminal());
    }
}
