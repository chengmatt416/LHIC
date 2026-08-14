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
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = -64000;
             PRAGMA temp_store = MEMORY;
             PRAGMA mmap_size = 268435456;
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
             CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
             CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);",
        )?;
        Ok(Self { conn })
    }

    pub fn create_session(&mut self, name: &str) -> Result<Session> {
        let now = timestamp();
        let mut stmt = self.conn.prepare_cached(
            "INSERT INTO sessions (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
        )?;
        stmt.execute(rusqlite::params![name, now])?;
        Ok(Session {
            id: self.conn.last_insert_rowid(),
            name: name.to_string(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn list_sessions(&self, limit: i64) -> Result<Vec<Session>> {
        let mut stmt = self.conn.prepare_cached(
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
        let tx = self.conn.transaction()?;
        let id = {
            let mut stmt1 = tx.prepare_cached(
                "INSERT INTO messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            )?;
            stmt1.execute(rusqlite::params![session_id, role, content, now.as_str()])?;
            let id = tx.last_insert_rowid();
            let mut stmt2 =
                tx.prepare_cached("UPDATE sessions SET updated_at = ?1 WHERE id = ?2")?;
            stmt2.execute(rusqlite::params![now.as_str(), session_id])?;
            id
        };
        tx.commit()?;
        Ok(MemoryMessage {
            id,
            session_id,
            role: role.to_string(),
            content: content.to_string(),
            created_at: now,
        })
    }

    pub fn session_messages(&self, session_id: i64) -> Result<Vec<MemoryMessage>> {
        let mut stmt = self.conn.prepare_cached(
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
        let mut stmt = self.conn.prepare_cached(
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
    pub fn delete_session(&mut self, session_id: i64) -> Result<bool> {
        let mut stmt = self
            .conn
            .prepare_cached("DELETE FROM sessions WHERE id = ?1")?;
        let rows = stmt.execute(rusqlite::params![session_id])?;
        Ok(rows > 0)
    }

    pub fn get_session(&self, session_id: i64) -> Result<Option<Session>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, name, created_at, updated_at FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query([session_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Session {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            }))
        } else {
            Ok(None)
        }
    }
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_store() -> MemoryStore {
        let dir = std::env::temp_dir().join(format!(
            "lhic-mem-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        MemoryStore::open(&dir.join("memory.sqlite")).unwrap()
    }

    #[test]
    fn session_and_messages_lifecycle() {
        let mut store = temp_store();
        let session = store.create_session("test-session").unwrap();
        assert_eq!(session.name, "test-session");

        let msg1 = store
            .append_message(session.id, "user", "Hello World")
            .unwrap();
        let msg2 = store
            .append_message(session.id, "assistant", "Hi there! How can I help?")
            .unwrap();
        assert_eq!(msg1.role, "user");
        assert_eq!(msg2.role, "assistant");

        let messages = store.session_messages(session.id).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "Hello World");

        let search_res = store.search("world", 10).unwrap();
        assert_eq!(search_res.len(), 1);
        assert_eq!(search_res[0].id, msg1.id);

        let deleted = store.delete_session(session.id).unwrap();
        assert!(deleted);
        assert!(store.session_messages(session.id).unwrap().is_empty());
    }

    #[test]
    fn foreign_key_enforcement() {
        let mut store = temp_store();
        // Attempting to add a message to a non-existent session must fail due to FK constraint
        let res = store.append_message(9999, "user", "Orphaned message");
        assert!(res.is_err());
    }
}
