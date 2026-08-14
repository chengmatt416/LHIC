//! Frame decoding and lossless `rpc_chunk` reassembly (protocol v2).
//!
//! Implements the framing contract from the omp RPC spec: physical stdout
//! frames are capped at `maxFrameBytes`; oversized logical frames are emitted
//! as an uninterrupted sequence of `rpc_chunk` frames carrying base64
//! segments. Clients MUST validate `chunkId`, `index`, `count`, and
//! `byteLength`, reject interleaved/interrupted sequences, enforce the
//! advertised reassembly limit, concatenate in index order, decode strict
//! UTF-8, and parse the result as one JSON object.

use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::Value;

use super::error::RpcError;
use super::types::{RpcChunk, DEFAULT_MAX_REASSEMBLED_FRAME_BYTES};

/// Incremental validator/reassembler for one `rpc_chunk` sequence.
///
/// One instance tracks a single logical frame. After a sequence completes or
/// fails it must be reset; a fresh sequence with a different `chunk_id`
/// automatically resets the buffer (rejecting the interleaved old one).
#[derive(Debug)]
pub struct ChunkReassembler {
    max_frame_bytes: usize,
    /// Monotonic clock at the last accepted chunk (for stale detection).
    last_chunk_at: Option<Instant>,
    /// Identity of the sequence currently being assembled.
    chunk_id: Option<String>,
    next_index: usize,
    count: usize,
    byte_length: usize,
    buffer: Vec<u8>,
}

impl ChunkReassembler {
    pub fn new(max_frame_bytes: usize) -> Self {
        let max_frame_bytes = if max_frame_bytes == 0 {
            DEFAULT_MAX_REASSEMBLED_FRAME_BYTES
        } else {
            max_frame_bytes
        };
        Self {
            max_frame_bytes,
            last_chunk_at: None,
            chunk_id: None,
            next_index: 0,
            count: 0,
            byte_length: 0,
            buffer: Vec::new(),
        }
    }

    /// Feeds one chunk. Returns the fully reassembled logical frame bytes on
    /// the last chunk of a valid sequence.
    pub fn feed(&mut self, chunk: &RpcChunk) -> Result<Option<Vec<u8>>, RpcError> {
        if chunk.byte_length > self.max_frame_bytes {
            return Err(RpcError::Chunk {
                detail: format!(
                    "logical frame byteLength {} exceeds reassembly cap {}",
                    chunk.byte_length, self.max_frame_bytes
                ),
            });
        }
        if chunk.index >= chunk.count {
            return Err(RpcError::Chunk {
                detail: format!(
                    "chunk index {} out of range for count {}",
                    chunk.index, chunk.count
                ),
            });
        }
        if chunk.count == 0 {
            return Err(RpcError::Chunk {
                detail: "chunk count must be positive".to_string(),
            });
        }

        // A different chunk id interrupts the previous sequence: reject it.
        if let Some(current) = &self.chunk_id {
            if current != &chunk.chunk_id {
                return Err(RpcError::Chunk {
                    detail: format!(
                        "interleaved chunk sequence: expected {} got {}",
                        current, chunk.chunk_id
                    ),
                });
            }
        }

        // First chunk initializes the sequence.
        if self.chunk_id.is_none() {
            self.chunk_id = Some(chunk.chunk_id.clone());
            self.next_index = 0;
            self.count = chunk.count;
            self.byte_length = chunk.byte_length;
            self.buffer.clear();
        } else {
            // Consistent framing across the whole sequence.
            if chunk.count != self.count || chunk.byte_length != self.byte_length {
                return Err(RpcError::Chunk {
                    detail: format!(
                        "inconsistent framing: count {}/{} byteLength {}/{}",
                        chunk.count, self.count, chunk.byte_length, self.byte_length
                    ),
                });
            }
        }

        if chunk.index != self.next_index {
            return Err(RpcError::Chunk {
                detail: format!(
                    "out-of-order chunk: expected index {}, got {}",
                    self.next_index, chunk.index
                ),
            });
        }

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&chunk.data)
            .map_err(|e| RpcError::Chunk {
                detail: format!("invalid base64 in chunk {}: {e}", chunk.index),
            })?;

        if self.buffer.len() + bytes.len() > self.byte_length {
            return Err(RpcError::Chunk {
                detail: "chunk overflows declared byteLength".to_string(),
            });
        }

        self.buffer.extend_from_slice(&bytes);
        self.next_index += 1;
        self.last_chunk_at = Some(Instant::now());

        if self.next_index == self.count {
            if self.buffer.len() != self.byte_length {
                return Err(RpcError::Chunk {
                    detail: format!(
                        "reassembled {} bytes, declared {}",
                        self.buffer.len(),
                        self.byte_length
                    ),
                });
            }
            let complete = std::mem::take(&mut self.buffer);
            self.reset();
            Ok(Some(complete))
        } else {
            Ok(None)
        }
    }

    /// Fails the current sequence if it has been idle for `stale_after`.
    pub fn check_stale(&mut self, stale_after: Duration) -> Result<(), RpcError> {
        self.check_stale_at(stale_after, Instant::now())
    }

    /// `check_stale` with an injectable clock (testable).
    fn check_stale_at(&mut self, stale_after: Duration, now: Instant) -> Result<(), RpcError> {
        if self.chunk_id.is_none() {
            return Ok(());
        }
        if let Some(last) = self.last_chunk_at {
            if now.duration_since(last) > stale_after {
                let id = self.chunk_id.clone().unwrap_or_default();
                self.reset();
                return Err(RpcError::Chunk {
                    detail: format!(
                        "sequence {id} stalled (no chunk for {}ms)",
                        stale_after.as_millis()
                    ),
                });
            }
        }
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.chunk_id.is_some()
    }

    fn reset(&mut self) {
        self.chunk_id = None;
        self.next_index = 0;
        self.count = 0;
        self.byte_length = 0;
        self.buffer.clear();
        self.last_chunk_at = None;
    }
}

/// Validates and reassembles a chunked logical frame into its raw JSON bytes.
pub fn reassemble_chunked(chunks: &[RpcChunk]) -> Result<Vec<u8>, RpcError> {
    let mut reassembler = ChunkReassembler::new(DEFAULT_MAX_REASSEMBLED_FRAME_BYTES);
    let mut complete: Option<Vec<u8>> = None;
    for chunk in chunks {
        complete = reassembler.feed(chunk)?;
    }
    complete.ok_or_else(|| RpcError::Chunk {
        detail: "sequence did not complete".to_string(),
    })
}

/// Parses one physical stdout line into a JSON `Value`.
pub fn parse_line(line: &str) -> Result<Value, RpcError> {
    serde_json::from_str(line).map_err(|_| RpcError::Parse {
        line: line.to_string(),
    })
}

/// Decodes reassembled bytes as strict UTF-8 JSON.
pub fn decode_reassembled(bytes: Vec<u8>) -> Result<Value, RpcError> {
    let text = String::from_utf8(bytes).map_err(|e| RpcError::Malformed {
        detail: format!("reassembled frame is not UTF-8: {e}"),
    })?;
    serde_json::from_str(&text).map_err(|e| RpcError::Malformed {
        detail: format!("reassembled frame is not JSON: {e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(
        chunk_id: &str,
        index: usize,
        count: usize,
        data: &[u8],
        byte_length: usize,
    ) -> RpcChunk {
        RpcChunk {
            frame_type: "rpc_chunk".to_string(),
            chunk_id: chunk_id.to_string(),
            index,
            count,
            byte_length,
            data: base64::engine::general_purpose::STANDARD.encode(data),
        }
    }

    fn split_payload(payload: &[u8], parts: usize) -> Vec<Vec<u8>> {
        let chunk_size = payload.len().div_ceil(parts);
        payload.chunks(chunk_size).map(|c| c.to_vec()).collect()
    }

    #[test]
    fn lossless_reassembly_of_large_payload() {
        let payload = serde_json::json!({
            "type": "response",
            "id": "req_big",
            "command": "get_messages",
            "success": true,
            "data": { "text": "x".repeat(1_200_000) }
        })
        .to_string()
        .into_bytes();

        let segments = split_payload(&payload, 7);
        let chunks: Vec<RpcChunk> = segments
            .iter()
            .enumerate()
            .map(|(i, seg)| chunk("rpc-1", i, segments.len(), seg, payload.len()))
            .collect();

        let decoded = reassemble_chunked(&chunks).unwrap();
        assert_eq!(decoded, payload);
        let value: Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(value["id"], "req_big");
    }

    #[test]
    fn rejects_out_of_order_chunks() {
        let payload = b"{\"type\":\"response\"}".to_vec();
        let segments = split_payload(&payload, 3);
        let mut chunks: Vec<RpcChunk> = segments
            .iter()
            .enumerate()
            .map(|(i, seg)| chunk("rpc-1", i, segments.len(), seg, payload.len()))
            .collect();
        chunks.swap(0, 2);
        assert!(reassemble_chunked(&chunks).is_err());
    }

    #[test]
    fn rejects_duplicate_chunks() {
        let payload = b"{\"type\":\"response\"}".to_vec();
        let segments = split_payload(&payload, 2);
        let mut chunks: Vec<RpcChunk> = segments
            .iter()
            .enumerate()
            .map(|(i, seg)| chunk("rpc-1", i, segments.len(), seg, payload.len()))
            .collect();
        chunks.push(chunk("rpc-1", 0, 2, &segments[0], payload.len()));
        assert!(reassemble_chunked(&chunks).is_err());
    }

    #[test]
    fn rejects_missing_chunk() {
        let payload = b"{\"type\":\"response\"}".to_vec();
        let segments = split_payload(&payload, 3);
        let chunks: Vec<RpcChunk> = segments
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 1)
            .map(|(i, seg)| chunk("rpc-1", i, segments.len(), seg, payload.len()))
            .collect();
        assert!(reassemble_chunked(&chunks).is_err());
    }

    #[test]
    fn rejects_oversized_frame() {
        let payload = vec![0u8; 1024];
        let mut reassembler = ChunkReassembler::new(512);
        let c = chunk("rpc-1", 0, 1, &payload, payload.len());
        assert!(reassembler.feed(&c).is_err());
    }

    #[test]
    fn rejects_interleaved_chunk_ids() {
        let payload = b"{\"type\":\"response\"}".to_vec();
        let segments = split_payload(&payload, 2);
        let mut chunks: Vec<RpcChunk> = segments
            .iter()
            .enumerate()
            .map(|(i, seg)| chunk("rpc-1", i, segments.len(), seg, payload.len()))
            .collect();
        chunks.insert(1, chunk("rpc-2", 0, 1, b"{\"type\":\"event\"}", 15));
        assert!(reassemble_chunked(&chunks).is_err());
    }

    #[test]
    fn rejects_invalid_base64() {
        let mut reassembler = ChunkReassembler::new(1024);
        let c = RpcChunk {
            frame_type: "rpc_chunk".to_string(),
            chunk_id: "rpc-1".to_string(),
            index: 0,
            count: 1,
            byte_length: 10,
            data: "not-base64!!!".to_string(),
        };
        assert!(reassembler.feed(&c).is_err());
    }

    #[test]
    fn rejects_byte_length_mismatch() {
        let mut reassembler = ChunkReassembler::new(1024);
        let c = chunk("rpc-1", 0, 1, b"hello", 999);
        assert!(reassembler.feed(&c).is_err());
    }

    #[test]
    fn detects_stale_sequence() {
        let mut reassembler = ChunkReassembler::new(1024);
        let payload = b"{\"type\":\"response\"}".to_vec();
        let c = chunk("rpc-1", 0, 2, &payload, payload.len());
        assert!(reassembler.feed(&c).unwrap().is_none());
        assert!(reassembler.is_active());
        // Deterministic: a "now" far past the last chunk triggers staleness.
        assert!(reassembler
            .check_stale_at(
                Duration::from_secs(1),
                Instant::now() + Duration::from_secs(5)
            )
            .is_err());
        assert!(!reassembler.is_active());
        // Fresh sequence: not stale immediately.
        let mut fresh = ChunkReassembler::new(1024);
        assert!(fresh.feed(&c).unwrap().is_none());
        assert!(fresh
            .check_stale_at(Duration::from_secs(60), Instant::now())
            .is_ok());
    }

    #[test]
    fn parse_line_rejects_garbage() {
        assert!(parse_line("{not json}").is_err());
        assert!(parse_line("").is_err());
        assert!(parse_line("{\"type\":\"ready\"}").is_ok());
    }
}
