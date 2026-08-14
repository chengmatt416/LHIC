//! Shared-skill library client (Appwrite REST).
//!
//! Rust-native replacement for the Appwrite shared-skills sync service:
//! lists, searches, and downloads reviewed skills from the marketplace
//! database.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDocument {
    #[serde(rename = "$id")]
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub rating: Option<f64>,
    pub downloads: Option<i64>,
    pub version: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct DocumentsResponse {
    documents: Vec<SkillDocument>,
    #[allow(dead_code)]
    total: i64,
}

/// Client for the LHIC shared-skill marketplace.
///
/// Configuration comes from environment variables so credentials never live
/// in app state:
///   LHIC_APPWRITE_ENDPOINT (default https://cloud.appwrite.io/v1)
///   LHIC_APPWRITE_PROJECT   database project id
///   LHIC_APPWRITE_DATABASE  database id
///   LHIC_APPWRITE_COLLECTION skills collection id
///   LHIC_APPWRITE_API_KEY   optional API key for authenticated reads
pub struct SkillsClient {
    endpoint: String,
    project: String,
    database: String,
    collection: String,
    api_key: Option<String>,
    http: reqwest::Client,
}

impl SkillsClient {
    pub fn from_env() -> Result<Self> {
        let endpoint = std::env::var("LHIC_APPWRITE_ENDPOINT")
            .unwrap_or_else(|_| "https://cloud.appwrite.io/v1".to_string());
        let project = std::env::var("LHIC_APPWRITE_PROJECT")
            .context("LHIC_APPWRITE_PROJECT is required")?;
        let database =
            std::env::var("LHIC_APPWRITE_DATABASE").context("LHIC_APPWRITE_DATABASE is required")?;
        let collection = std::env::var("LHIC_APPWRITE_COLLECTION")
            .context("LHIC_APPWRITE_COLLECTION is required")?;
        let api_key = std::env::var("LHIC_APPWRITE_API_KEY").ok();
        Ok(Self {
            endpoint,
            project,
            database,
            collection,
            api_key,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .pool_idle_timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        })
    }

    pub async fn list(&self, limit: i64, offset: i64) -> Result<Vec<SkillDocument>> {
        self.query(&format!("limit={limit}&offset={offset}")).await
    }

    pub async fn search(&self, query: &str, limit: i64) -> Result<Vec<SkillDocument>> {
        let clause = format!("search(\"{}\")", query.replace('"', "\\\""));
        self.query(&format!("queries[]={}&limit={limit}", urlencode(&clause))).await
    }

    async fn query(&self, params: &str) -> Result<Vec<SkillDocument>> {
        let url = format!(
            "{}/databases/{}/collections/{}/documents?{}",
            self.endpoint, self.database, self.collection, params
        );
        let mut request = self
            .http
            .get(&url)
            .header("X-Appwrite-Project", &self.project)
            .header("Accept", "application/json");
        if let Some(key) = &self.api_key {
            request = request.header("X-Appwrite-Key", key);
        }
        let response = request.send().await.context("skills request failed")?;
        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "skills request failed with {}",
                response.status()
            ));
        }
        let payload: DocumentsResponse = response
            .json()
            .await
            .context("skills response is invalid")?;
        Ok(payload.documents)
    }
}

fn urlencode(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_special_characters() {
        assert_eq!(urlencode("hello world"), "hello%20world");
        assert_eq!(urlencode("a=1&b=2"), "a%3D1%26b%3D2");
        assert_eq!(urlencode("test-file_1.0~"), "test-file_1.0~");
    }
}
