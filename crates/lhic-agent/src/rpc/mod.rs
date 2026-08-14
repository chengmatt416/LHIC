//! omp RPC v2 client: drives the bundled omp engine (`--mode rpc`) over
//! newline-delimited JSON on stdio with lossless chunked transport,
//! id-correlated responses, normalized events, and lifecycle-aware turn
//! completion.
//!
//! This module tree owns exactly one `OmpRpcClient` implementation (in
//! `client.rs`); `mod.rs` only re-exports it.
//!
//! Wire contract: <https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md>

pub mod client;
pub mod codec;
pub mod coordinator;
pub mod error;
pub mod host;
pub mod lifecycle;
pub mod trust;
pub mod types;

pub use client::{
    OmpRpcClient, RpcConfig, DEFAULT_CHUNK_STALE_TIMEOUT, DEFAULT_COMMAND_TIMEOUT,
    DEFAULT_READY_TIMEOUT, OMP_VERSION,
};
pub use codec::ChunkReassembler;
pub use coordinator::{LateCommandResponse, TurnCompletion, TurnCoordinator};
pub use error::RpcError;
pub use host::{
    HostToolDefinition, HostToolResult, HostUriRequest, HostUriResult, HostUriSchemeDefinition,
};
pub use lifecycle::{prompt_and_wait, PromptOutcome};
pub use trust::{sha256_file, verify_omp_binary, verify_omp_version, ArtifactTrust, OmpManifest};
pub use types::{
    AgentEvent, HostToolCall, HostToolCancel, HostUriCancel, PromptResult, ReadyFrame, RpcChunk,
    RpcResponse, UiRequest, UiResponse, DEFAULT_MAX_REASSEMBLED_FRAME_BYTES,
    LOCAL_MAX_REASSEMBLED_FRAME_BYTES, RPC_PROTOCOL_VERSION,
};
