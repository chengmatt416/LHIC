//! Typed wire model for the omp RPC protocol (v1/v2).
//!
//! Mirrors the canonical wire contract documented at
//! <https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md> and the
//! `RpcCommand` / `AgentSessionEvent` surface in `rpc-types.ts`. Unknown
//! future fields are tolerated via `#[serde(default)]` / `flatten` so that
//! newer engines remain usable.
//!
//! All wire structs use `camelCase` serialization: the engine speaks
//! `protocolVersion`, `toolCallId`, `byteLength`, … even where Rust fields
//! are snake_case.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version this client implements (lossless `rpc_chunk` transport).
pub const RPC_PROTOCOL_VERSION: u32 = 2;

/// Fallback cap for a reassembled logical frame when the ready frame does
/// not advertise one (OMP's default is 64 MiB).
pub const DEFAULT_MAX_REASSEMBLED_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// Local security ceiling for a reassembled logical frame. The effective cap
/// is `min(local_cap, server_advertised_maxReassembledFrameBytes)`.
pub const LOCAL_MAX_REASSEMBLED_FRAME_BYTES: usize = 64 * 1024 * 1024;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_frame_bytes: Option<usize>,
    /// Cap for a v2-reassembled logical frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
#[serde(rename_all = "camelCase")]
pub struct RpcResponse {
    #[serde(rename = "type")]
    pub frame_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Machine-readable failure code (`session_busy`, `stale_cursor`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// `extension_ui_request` outbound from the engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
///
/// All variants share `type: "extension_ui_response"` with mutually
/// exclusive payload fields, exactly as OMP emits them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiResponse {
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
}

impl UiResponse {
    /// Text answer for `input` / `editor` / `select` dialogs.
    pub fn value(id: &str, value: String) -> Self {
        Self {
            frame_type: "extension_ui_response",
            id: id.to_string(),
            value: Some(value),
            confirmed: None,
            cancelled: None,
            timed_out: None,
        }
    }

    /// Boolean answer for `confirm` dialogs.
    pub fn confirm(id: &str, confirmed: bool) -> Self {
        Self {
            frame_type: "extension_ui_response",
            id: id.to_string(),
            value: None,
            confirmed: Some(confirmed),
            cancelled: None,
            timed_out: None,
        }
    }

    /// Cancelled (or timed out) dialog.
    pub fn cancel(id: &str, timed_out: bool) -> Self {
        Self {
            frame_type: "extension_ui_response",
            id: id.to_string(),
            value: None,
            confirmed: None,
            cancelled: Some(true),
            timed_out: Some(timed_out),
        }
    }
}

/// `host_tool_call` outbound: the engine asks the host to execute a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostToolCall {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub tool_name: String,
    pub arguments: Value,
}

/// `host_tool_cancel` outbound: the engine aborts a pending host tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostToolCancel {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    pub target_id: String,
}

/// `host_tool_result` inbound: host completion for a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct HostUriRequest {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    pub operation: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// `host_uri_cancel` outbound: the engine aborts a pending URI request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUriCancel {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    pub target_id: String,
}

/// `host_uri_result` inbound: host completion for a URI request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
/// Each variant keeps the raw engine frame where useful so host code never
/// loses data; the typed discriminants let UI/CLI render without
/// pattern-guessing.
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
    /// `host_tool_call`.
    HostToolCall(HostToolCall),
    /// `host_tool_cancel`.
    HostToolCancel(HostToolCancel),
    /// `host_uri_request`.
    HostUriRequest(HostUriRequest),
    /// `host_uri_cancel`.
    HostUriCancel(HostUriCancel),
    /// `available_commands_update`.
    CommandsUpdated { raw: Value },
    /// `prompt_result` (local-only prompt resolution).
    PromptResolved(PromptResult),
    /// `subagent_lifecycle` / `subagent_progress` / `subagent_event`.
    SubagentEvent { raw: Value },
    /// `command_output`, `session_info_update`, `config_update` and other
    /// builtin side channels.
    SideChannel { raw: Value },
    /// A late failure response for a request that already completed (e.g. a
    /// prompt that was acknowledged and later failed during async
    /// scheduling). Routed here instead of leaking into the pending map.
    LateCommandFailure {
        id: String,
        command: String,
        code: Option<String>,
        error: String,
    },
    /// A protocol violation surfaced by the transport (chunk errors,
    /// interruption of a chunk sequence, parse failures, …).
    ProtocolError { detail: String },
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
            AgentEvent::HostToolCall(_) => Some("host_tool_call"),
            AgentEvent::HostToolCancel(_) => Some("host_tool_cancel"),
            AgentEvent::HostUriRequest(_) => Some("host_uri_request"),
            AgentEvent::HostUriCancel(_) => Some("host_uri_cancel"),
            AgentEvent::CommandsUpdated { .. } => Some("available_commands_update"),
            AgentEvent::PromptResolved(_) => Some("prompt_result"),
            AgentEvent::SubagentEvent { .. } => Some("subagent_event"),
            AgentEvent::SideChannel { .. } => Some("side_channel"),
            AgentEvent::LateCommandFailure { .. } => Some("late_command_failure"),
            AgentEvent::ProtocolError { .. } => Some("protocol_error"),
            AgentEvent::Log(_) | AgentEvent::ChildClosed | AgentEvent::Unknown { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Compile-time assertion: the canonical re-export and the module path
    /// resolve to the same concrete type (exactly one implementation).
    #[test]
    fn canonical_client_type_is_single_implementation() {
        fn assert_same_type<T: ?Sized>(_: &T, _: &T) {}
        let canonical: crate::rpc::OmpRpcClient = crate::rpc::client::OmpRpcClient::new(
            "omp".to_string(),
            ".".to_string(),
            ".".to_string(),
            std::collections::HashMap::new(),
        );
        let module_path: &crate::rpc::client::OmpRpcClient = &canonical;
        let reexport: &crate::rpc::OmpRpcClient = &canonical;
        assert_same_type(module_path, reexport);
    }

    #[test]
    fn ui_value_serializes_as_extension_ui_response() {
        let response = UiResponse::value("ui_1", "feature/x".to_string());
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            json!({
                "type": "extension_ui_response",
                "id": "ui_1",
                "value": "feature/x"
            })
        );
    }

    #[test]
    fn ui_confirm_serializes_as_extension_ui_response() {
        let response = UiResponse::confirm("ui_2", true);
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            json!({
                "type": "extension_ui_response",
                "id": "ui_2",
                "confirmed": true
            })
        );
    }

    #[test]
    fn ui_cancel_serializes_as_extension_ui_response() {
        let response = UiResponse::cancel("ui_3", true);
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            json!({
                "type": "extension_ui_response",
                "id": "ui_3",
                "cancelled": true,
                "timedOut": true
            })
        );
    }

    #[test]
    fn host_tool_call_deserializes_camel_case() {
        let wire = json!({
            "type": "host_tool_call",
            "id": "host_1",
            "toolCallId": "toolu_123",
            "toolName": "echo_host",
            "arguments": { "message": "hello" }
        });
        let call: HostToolCall = serde_json::from_value(wire).unwrap();
        assert_eq!(call.tool_call_id.as_deref(), Some("toolu_123"));
        assert_eq!(call.tool_name, "echo_host");
        assert_eq!(call.arguments["message"], "hello");
    }

    #[test]
    fn host_tool_cancel_deserializes_target_id() {
        let wire = json!({
            "type": "host_tool_cancel",
            "id": "host_cancel_1",
            "targetId": "host_1"
        });
        let cancel: HostToolCancel = serde_json::from_value(wire).unwrap();
        assert_eq!(cancel.target_id, "host_1");
    }

    #[test]
    fn host_uri_request_deserializes() {
        let wire = json!({
            "type": "host_uri_request",
            "id": "uri_1",
            "operation": "read",
            "url": "db://users/42"
        });
        let req: HostUriRequest = serde_json::from_value(wire).unwrap();
        assert_eq!(req.operation, "read");
        assert_eq!(req.url, "db://users/42");
        assert!(req.content.is_none());
    }

    #[test]
    fn host_uri_cancel_deserializes_target_id() {
        let wire = json!({
            "type": "host_uri_cancel",
            "id": "uri_cancel_1",
            "targetId": "uri_1"
        });
        let cancel: HostUriCancel = serde_json::from_value(wire).unwrap();
        assert_eq!(cancel.target_id, "uri_1");
    }

    #[test]
    fn host_uri_result_deserializes_content_type() {
        let wire = json!({
            "type": "host_uri_result",
            "id": "uri_1",
            "content": "id=42\n",
            "contentType": "text/plain",
            "notes": ["fresh from cache"],
            "immutable": false
        });
        let result: HostUriResult = serde_json::from_value(wire).unwrap();
        assert_eq!(result.content_type.as_deref(), Some("text/plain"));
        assert_eq!(result.notes.as_ref().map(|n| n.len()), Some(1));
        assert_eq!(result.immutable, Some(false));
    }

    #[test]
    fn host_tool_definition_serializes_load_mode() {
        let def = HostToolDefinition {
            name: "echo_host".to_string(),
            label: Some("Echo Host".to_string()),
            description: "Echo a value".to_string(),
            parameters: json!({ "type": "object" }),
            hidden: None,
            load_mode: Some("essential".to_string()),
        };
        let value = serde_json::to_value(&def).unwrap();
        assert_eq!(value["loadMode"], "essential");
        assert_eq!(value["label"], "Echo Host");
    }

    #[test]
    fn host_tool_result_serializes_is_error() {
        let result = HostToolResult {
            frame_type: "host_tool_result".to_string(),
            id: "host_1".to_string(),
            is_error: Some(true),
            result: json!({ "content": [{ "type": "text", "text": "done" }] }),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["isError"], true);
    }

    #[test]
    fn prompt_result_deserializes_agent_invoked() {
        let wire = json!({
            "type": "prompt_result",
            "id": "req_1",
            "agentInvoked": false
        });
        let result: PromptResult = serde_json::from_value(wire).unwrap();
        assert_eq!(result.id.as_deref(), Some("req_1"));
        assert!(!result.agent_invoked);
    }

    #[test]
    fn response_preserves_machine_code() {
        let wire = json!({
            "type": "response",
            "id": "req_2",
            "command": "get_messages_page",
            "success": false,
            "error": "session is streaming",
            "code": "session_busy"
        });
        let response: RpcResponse = serde_json::from_value(wire).unwrap();
        assert_eq!(response.code.as_deref(), Some("session_busy"));
        assert!(!response.success);
    }

    #[test]
    fn ready_frame_parses_advertised_limits() {
        let wire = json!({
            "type": "ready",
            "protocolVersion": 1,
            "supportedProtocolVersions": [1, 2],
            "maxFrameBytes": 1048576,
            "maxReassembledFrameBytes": 67108864
        });
        let ready: ReadyFrame = serde_json::from_value(wire).unwrap();
        assert_eq!(ready.supported_protocol_versions, vec![1, 2]);
        assert_eq!(ready.max_frame_bytes, Some(1048576));
        assert_eq!(ready.max_reassembled_frame_bytes, Some(67108864));
    }
}
