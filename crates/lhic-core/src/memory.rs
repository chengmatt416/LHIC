//! SQLite-backed workflow memory: sessions and messages.

use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryMessage {
    pub id: i64,
    pub session_id: i64,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

/// Persistent session/message store backed by SQLite.
pub struct MemoryStore {
    conn: Connection,
}

impl MemoryStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS sessions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);",
        )?;
        Ok(Self { conn })
    }

    pub fn create_session(&mut self, name: &str) -> Result<Session> {
        let now = timestamp();
        self.conn.execute(
            "INSERT INTO sessions (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
            rusqlite::params![name, now],
        )?;
        Ok(Session {
            id: self.conn.last_insert_rowid(),
            name: name.to_string(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn list_sessions(&self, limit: i64) -> Result<Vec<Session>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |row| {
            Ok(Session {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn append_message(
        &mut self,
        session_id: i64,
        role: &str,
        content: &str,
    ) -> Result<MemoryMessage> {
        let now = timestamp();
        self.conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session_id, role, content, now],
        )?;
        self.conn.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, session_id],
        )?;
        Ok(MemoryMessage {
            id: self.conn.last_insert_rowid(),
            session_id,
            role: role.to_string(),
            content: content.to_string(),
            created_at: now,
        })
    }

    pub fn session_messages(&self, session_id: i64) -> Result<Vec<MemoryMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, role, content, created_at FROM messages
             WHERE session_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([session_id], |row| {
            Ok(MemoryMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Full-text-ish search over message content (LIKE on lowercase).
    pub fn search(&self, needle: &str, limit: i64) -> Result<Vec<MemoryMessage>> {
        let pattern = format!("%{}%", needle.to_lowercase());
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, role, content, created_at FROM messages
             WHERE lower(content) LIKE ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![pattern, limit], |row| {
            Ok(MemoryMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}
