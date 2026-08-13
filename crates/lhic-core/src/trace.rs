//! Redacted JSONL event trace.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use anyhow::Result;
use serde::Serialize;

use crate::security::Redactor;

/// Append-only JSONL event log. Every payload passes through the PII redactor
/// before it is written, mirroring the trace guarantees of the original app.
pub struct Trace {
    file: std::fs::File,
    path: PathBuf,
}

impl Trace {
    pub fn open(dir: &std::path::Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("trace.jsonl");
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self { file, path })
    }

    pub fn record<T: Serialize>(&mut self, event_type: &str, payload: &T) -> Result<()> {
        let json = serde_json::to_string(payload)?;
        let redacted = Redactor::redact(&json);
        let line = format!(
            "{}\t{}\t{}\n",
            chrono::Utc::now().to_rfc3339(),
            event_type,
            redacted
        );
        self.file.write_all(line.as_bytes())?;
        self.file.flush()?;
        Ok(())
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}
