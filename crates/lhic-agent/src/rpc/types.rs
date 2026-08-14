//! Typed wire model for the omp RPC protocol (v1/v2).
//!
//! Mirrors the canonical wire contract documented at
//! <https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md> and the
//! `RpcCommand` / `AgentSessionEvent` surface in `rpc-types.ts`. Unknown
//! future fields are tolerated via `#[serde(default)]` / `flatten` so that
//! newer engines remain usable.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version this client implements (lossless `rpc_chunk` transport).
pub const RPC_PROTOCOL_VERSION: u32 = 2;

/// Fallback cap for a reassembled logical frame when the ready frame does
/// not advertise one (OMP's default is 64 MiB).
pub const DEFAULT_MAX_REASSEMBLED_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// Startup frame written by the engine before any command is processed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    #[serde(default)]
    pub protocol_version: u32,
    #[serde(default)]
    pub supported_protocol_versions: Vec<u32>,
    /// Cap for a single physical stdout frame (v1 behavior).
    #[serde(default)]
    pub max_frame_bytes: Option<usize>,
    /// Cap for a v2-reassembled logical frame.
    #[serde(default)]
    pub max_reassembled_frame_bytes: Option<usize>,
    #[serde(flatten)]
    pub extra: Value,
}

/// `rpc_chunk` frame carrying a base64 segment of an oversized logical frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcChunk {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub chunk_id: String,
    pub index: usize,
    pub count: usize,
    pub byte_length: usize,
    pub data: String,
}

/// A command response (`RpcResponse`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    #[serde(rename = "type")]
    pub frame_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// `extension_ui_request` outbound from the engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiRequest {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    #[serde(flatten)]
    pub extra: Value,
}

/// `extension_ui_response` inbound to the engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiResponse {
    /// Text value (input/editor/select responses).
    ExtensionUiResponse { id: String, value: String },
    /// Boolean answer (confirm).
    ExtensionUiResponseConfirm { id: String, confirmed: bool },
    /// Cancelled (or timed out) dialog.
    ExtensionUiResponseCancel {
        id: String,
        cancelled: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timed_out: Option<bool>,
    },
}

/// `host_tool_call` outbound: the engine asks the host to execute a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostToolRequest {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub tool_name: String,
    pub arguments: Value,
}

/// `host_tool_result` inbound: host completion for a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostToolResult {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    pub result: Value,
}

/// `host_uri_request` outbound: the engine reads/writes a host-owned scheme.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostUriRequest {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    pub operation: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// `host_uri_result` inbound: host completion for a URI request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostUriResult {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub immutable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<String>>,
}

/// Definition of a host-owned tool registered via `set_host_tools`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostToolDefinition {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub description: String,
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_mode: Option<String>,
}

/// Definition of a host-owned URI scheme registered via `set_host_uri_schemes`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostUriSchemeDefinition {
    pub scheme: String,
    pub description: String,
    #[serde(default)]
    pub writable: bool,
    #[serde(default)]
    pub immutable: bool,
}

/// `prompt_result`: a scheduled prompt resolved locally without an agent turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptResult {
    #[serde(rename = "type")]
    pub frame_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub agent_invoked: bool,
}

/// Normalized agent/session events surfaced to LHIC consumers.
///
/// Each variant keeps the raw engine frame so host code never loses data;
/// the typed discriminants let UI/CLI render without pattern-guessing.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// Agent lifecycle started (`agent_start`).
    AgentStarted { raw: Value },
    /// Agent lifecycle ended. `is_terminal` distinguishes true run
    /// completion from maintenance/async rescheduling.
    AgentEnded { is_terminal: bool, raw: Value },
    /// `turn_start`.
    TurnStarted { raw: Value },
    /// `turn_end`.
    TurnEnded { raw: Value },
    /// `message_start`.
    MessageStarted { raw: Value },
    /// `message_update` — streaming delta (text/thinking/toolcall).
    MessageUpdated { raw: Value },
    /// `message_end`.
    MessageEnded { raw: Value },
    /// `tool_execution_start`.
    ToolStarted { raw: Value },
    /// `tool_execution_update`.
    ToolUpdated { raw: Value },
    /// `tool_execution_end`.
    ToolEnded { raw: Value },
    /// `auto_compaction_start`.
    CompactionStarted { raw: Value },
    /// `auto_compaction_end`.
    CompactionEnded { raw: Value },
    /// `auto_retry_start`.
    RetryStarted { raw: Value },
    /// `auto_retry_end`.
    RetryEnded { raw: Value },
    /// `model_changed`.
    ModelChanged { raw: Value },
    /// `extension_ui_request`.
    UiRequested(UiRequest),
    /// `extension_error`.
    ExtensionError { raw: Value },
    /// `host_tool_call` / `host_tool_cancel`.
    HostToolRequested(HostToolRequest),
    /// `host_uri_request` / `host_uri_cancel`.
    HostUriRequested(HostUriRequest),
    /// `available_commands_update`.
    CommandsUpdated { raw: Value },
    /// `prompt_result` (local-only prompt resolution).
    PromptResolved(PromptResult),
    /// `subagent_lifecycle` / `subagent_progress` / `subagent_event`.
    SubagentEvent { raw: Value },
    /// `command_output`, `session_info_update`, `config_update` and other
    /// builtin side channels.
    SideChannel { raw: Value },
    /// A stderr diagnostic line from the engine process.
    Log(String),
    /// Engine stdout closed (EOF). No further events will arrive.
    ChildClosed,
    /// Any frame this client version does not classify.
    Unknown { raw: Value },
}

impl AgentEvent {
    /// Returns the raw `type` string carried by the frame, when any.
    pub fn frame_type(&self) -> Option<&'static str> {
        match self {
            AgentEvent::AgentStarted { .. } => Some("agent_start"),
            AgentEvent::AgentEnded { .. } => Some("agent_end"),
            AgentEvent::TurnStarted { .. } => Some("turn_start"),
            AgentEvent::TurnEnded { .. } => Some("turn_end"),
            AgentEvent::MessageStarted { .. } => Some("message_start"),
            AgentEvent::MessageUpdated { .. } => Some("message_update"),
            AgentEvent::MessageEnded { .. } => Some("message_end"),
            AgentEvent::ToolStarted { .. } => Some("tool_execution_start"),
            AgentEvent::ToolUpdated { .. } => Some("tool_execution_update"),
            AgentEvent::ToolEnded { .. } => Some("tool_execution_end"),
            AgentEvent::CompactionStarted { .. } => Some("auto_compaction_start"),
            AgentEvent::CompactionEnded { .. } => Some("auto_compaction_end"),
            AgentEvent::RetryStarted { .. } => Some("auto_retry_start"),
            AgentEvent::RetryEnded { .. } => Some("auto_retry_end"),
            AgentEvent::ModelChanged { .. } => Some("model_changed"),
            AgentEvent::UiRequested(_) => Some("extension_ui_request"),
            AgentEvent::ExtensionError { .. } => Some("extension_error"),
            AgentEvent::HostToolRequested(_) => Some("host_tool_call"),
            AgentEvent::HostUriRequested(_) => Some("host_uri_request"),
            AgentEvent::CommandsUpdated { .. } => Some("available_commands_update"),
            AgentEvent::PromptResolved(_) => Some("prompt_result"),
            AgentEvent::SubagentEvent { .. } => Some("subagent_event"),
            AgentEvent::SideChannel { .. } => Some("side_channel"),
            AgentEvent::Log(_) | AgentEvent::ChildClosed | AgentEvent::Unknown { .. } => None,
        }
    }
}
