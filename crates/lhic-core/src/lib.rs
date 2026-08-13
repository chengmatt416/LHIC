//! LHIC core services: memory, security, trace, browser, skills, controller.
//!
//! Rust-native rewrite of the LHIC application core. All services are
//! synchronous-safe (SQLite, AES-GCM vault, JSONL trace) or async (CDP
//! browser, Appwrite REST skills).

pub mod browser;
pub mod controller;
pub mod memory;
pub mod security;
pub mod skills;
pub mod trace;

use std::path::PathBuf;

/// Resolves the LHIC data directory (`~/.lhic`), creating it on demand.
pub fn lhic_home() -> anyhow::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home directory"))?;
    let path = home.join(".lhic");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}
