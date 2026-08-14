//! RPC protocol error types.

use std::fmt;

/// Typed RPC errors so callers can distinguish recoverable protocol failures
/// from transport/process failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    /// Engine stdout closed unexpectedly.
    ConnectionClosed,
    /// A line could not be parsed as JSON.
    Parse { line: String },
    /// A `rpc_chunk` sequence violated the framing contract.
    Chunk { detail: String },
    /// A frame had the right shape but failed validation.
    Malformed { detail: String },
    /// Command response reported `success: false`.
    CommandFailed { command: String, error: String },
    /// A command did not answer within its timeout.
    Timeout { command: String, seconds: u64 },
    /// Protocol/version negotiation failed.
    Negotiation { detail: String },
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::ConnectionClosed => write!(f, "omp RPC connection closed"),
            RpcError::Parse { line } => {
                write!(f, "malformed JSON frame: {}", truncate(line, 200))
            }
            RpcError::Chunk { detail } => write!(f, "invalid rpc_chunk sequence: {detail}"),
            RpcError::Malformed { detail } => write!(f, "malformed RPC frame: {detail}"),
            RpcError::CommandFailed { command, error } => {
                write!(f, "omp command {command} failed: {error}")
            }
            RpcError::Timeout { command, seconds } => {
                write!(f, "omp command {command} timed out after {seconds}s")
            }
            RpcError::Negotiation { detail } => write!(f, "protocol negotiation failed: {detail}"),
        }
    }
}

impl std::error::Error for RpcError {}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}
