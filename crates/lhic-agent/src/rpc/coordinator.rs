//! Non-lossy turn-coordination state.
//!
//! The bounded observer event stream is best-effort under overload, but
//! terminal protocol state must never be lost: `turn_end`, terminal
//! `agent_end`, `prompt_result`, a correlated late prompt failure, a fatal
//! protocol error, and child closure all land here (written by the stdout
//! reader) and are polled by `prompt_and_wait` through a `Notify`.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::Notify;

/// Outcome of a completed turn, stored non-lossily.
#[derive(Debug, Clone)]
pub enum TurnCompletion {
    /// Terminal lifecycle event reached.
    Terminal { prompt_id: String },
    /// Local-only `prompt_result` with `agentInvoked: false`.
    PromptResult {
        prompt_id: String,
        agent_invoked: bool,
    },
    /// A correlated late failure for the prompt's request id.
    LateFailure {
        prompt_id: String,
        command: String,
        code: Option<String>,
        error: String,
    },
    /// The engine child closed before the turn completed.
    ChildClosed { prompt_id: String },
    /// A fatal protocol error terminated the turn.
    ProtocolError { prompt_id: String, detail: String },
}

#[derive(Debug)]
struct TurnCoordinatorInner {
    active_prompt: Option<String>,
    completion: Option<TurnCompletion>,
    child_closed: bool,
}

/// Shared, non-lossy turn state written by the reader and polled by
/// `prompt_and_wait`. All mutations notify waiters.
#[derive(Debug, Clone)]
pub struct TurnCoordinator {
    inner: Arc<Mutex<TurnCoordinatorInner>>,
    notify: Arc<Notify>,
}

impl Default for TurnCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl TurnCoordinator {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(TurnCoordinatorInner {
                active_prompt: None,
                completion: None,
                child_closed: false,
            })),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Registers the prompt being awaited. Returns immediately when the turn
    /// already completed before registration.
    pub fn register(&self, prompt_id: &str) {
        self.inner.lock().active_prompt = Some(prompt_id.to_string());
        self.notify.notify_waiters();
    }

    /// Marks the active turn terminal (lifecycle event).
    pub fn mark_terminal(&self) {
        let mut guard = self.inner.lock();
        if let Some(id) = guard.active_prompt.clone() {
            guard.completion = Some(TurnCompletion::Terminal { prompt_id: id });
        }
        drop(guard);
        self.notify.notify_waiters();
    }

    /// Records a `prompt_result` frame (local-only resolution).
    pub fn mark_prompt_result(&self, prompt_id: &str, agent_invoked: bool) {
        let mut guard = self.inner.lock();
        if guard.active_prompt.as_deref() == Some(prompt_id) || guard.completion.is_none() {
            guard.completion = Some(TurnCompletion::PromptResult {
                prompt_id: prompt_id.to_string(),
                agent_invoked,
            });
        }
        drop(guard);
        self.notify.notify_waiters();
    }

    /// Records a correlated late failure for the active prompt.
    pub fn mark_late_failure(
        &self,
        prompt_id: &str,
        command: &str,
        code: Option<String>,
        error: &str,
    ) {
        let mut guard = self.inner.lock();
        if guard.active_prompt.as_deref() == Some(prompt_id) {
            guard.completion = Some(TurnCompletion::LateFailure {
                prompt_id: prompt_id.to_string(),
                command: command.to_string(),
                code,
                error: error.to_string(),
            });
        }
        drop(guard);
        self.notify.notify_waiters();
    }

    /// Marks a fatal protocol error as the turn's completion.
    pub fn mark_protocol_error(&self, detail: &str) {
        let mut guard = self.inner.lock();
        if let Some(id) = guard.active_prompt.clone() {
            guard.completion = Some(TurnCompletion::ProtocolError {
                prompt_id: id,
                detail: detail.to_string(),
            });
        }
        drop(guard);
        self.notify.notify_waiters();
    }

    /// Marks child closure. Pending turns complete with ChildClosed.
    pub fn mark_child_closed(&self) {
        let mut guard = self.inner.lock();
        guard.child_closed = true;
        if let Some(id) = guard.active_prompt.clone() {
            if guard.completion.is_none() {
                guard.completion = Some(TurnCompletion::ChildClosed { prompt_id: id });
            }
        }
        drop(guard);
        self.notify.notify_waiters();
    }

    /// Whether the awaited turn reached terminal completion.
    pub fn is_terminal(&self, prompt_id: &str) -> bool {
        let guard = self.inner.lock();
        match &guard.completion {
            Some(completion) => match completion {
                TurnCompletion::Terminal { prompt_id: id }
                | TurnCompletion::PromptResult { prompt_id: id, .. }
                | TurnCompletion::LateFailure { prompt_id: id, .. }
                | TurnCompletion::ChildClosed { prompt_id: id }
                | TurnCompletion::ProtocolError { prompt_id: id, .. } => id == prompt_id,
            },
            None => false,
        }
    }

    /// The terminal completion, if the awaited turn completed.
    pub fn take_completion(&self, prompt_id: &str) -> Option<TurnCompletion> {
        let mut guard = self.inner.lock();
        let terminal = match &guard.completion {
            Some(completion) => match completion {
                TurnCompletion::Terminal { prompt_id: id }
                | TurnCompletion::PromptResult { prompt_id: id, .. }
                | TurnCompletion::LateFailure { prompt_id: id, .. }
                | TurnCompletion::ChildClosed { prompt_id: id }
                | TurnCompletion::ProtocolError { prompt_id: id, .. } => id == prompt_id,
            },
            None => false,
        };
        if terminal {
            guard.completion.take()
        } else {
            None
        }
    }

    pub fn notify(&self) -> Arc<Notify> {
        self.notify.clone()
    }
}

/// Helper used by tests and diagnostics.
pub fn completion_is_success(completion: &TurnCompletion) -> bool {
    match completion {
        TurnCompletion::Terminal { .. } | TurnCompletion::PromptResult { .. } => true,
        TurnCompletion::LateFailure { .. }
        | TurnCompletion::ChildClosed { .. }
        | TurnCompletion::ProtocolError { .. } => false,
    }
}

/// Payload of an unknown/late command response (diagnostic only).
#[derive(Debug, Clone)]
pub struct LateCommandResponse {
    pub id: String,
    pub command: String,
    pub success: bool,
    pub data: Option<Value>,
    pub code: Option<String>,
    pub error: Option<String>,
}
