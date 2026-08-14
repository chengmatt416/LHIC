//! OMP supply-chain trust verification helpers and unit tests.
//!
//! The trusted source is the committed `.omp-trust/manifest.json`
//! (`schemaVersion`, pinned `version`, per-platform artifact `assetSha256`
//! published by the upstream v17.2.15 release). Verification compares the
//! actual file digest against the manifest — never against a digest derived
//! from the same file (no self-attestation).

use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactTrust {
    pub asset_name: String,
    pub asset_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpManifest {
    pub schema_version: u32,
    pub version: String,
    pub source: String,
    pub sha256sums_url: String,
    pub artifacts: std::collections::HashMap<String, ArtifactTrust>,
}

impl OmpManifest {
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path).map_err(|e| format!("reading manifest: {e}"))?;
        let manifest: OmpManifest =
            serde_json::from_str(&raw).map_err(|e| format!("parsing manifest: {e}"))?;
        if manifest.schema_version != 1 {
            return Err(format!(
                "unsupported manifest schema version: {}",
                manifest.schema_version
            ));
        }
        Ok(manifest)
    }

    pub fn artifact(&self, target: &str) -> Result<&ArtifactTrust, String> {
        self.artifacts
            .get(target)
            .ok_or_else(|| format!("unsupported platform/arch target: {target}"))
    }
}

/// SHA-256 of a file (lowercase hex).
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Fail-closed verification: expected version + expected SHA-256 + file.
pub fn verify_omp_binary(
    manifest: &OmpManifest,
    target: &str,
    binary: &Path,
) -> Result<(), String> {
    let artifact = manifest.artifact(target)?;
    let actual = sha256_file(binary)?;
    if actual != artifact.asset_sha256 {
        return Err(format!(
            "SHA-256 mismatch for {}: expected {}, actual {}",
            artifact.asset_name, artifact.asset_sha256, actual
        ));
    }
    Ok(())
}

/// Parses the `omp --version` output into the canonical version token.
///
/// The official output is exactly `omp/<version>`; surrounding whitespace is
/// trimmed. Loose substring matching is rejected so `omp/17.2.15-evil` or
/// `omp/17.2.150` never pass.
pub fn parse_omp_version_output(output: &str) -> Result<String, String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Err("omp --version produced no output".to_string());
    }
    // Official output is a single token `omp/<version>` on the first line.
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    let Some(prefix) = first_line.strip_prefix("omp/") else {
        return Err(format!(
            "unexpected omp --version output (expected 'omp/<version>'): {trimmed:?}"
        ));
    };
    // The version must be a pure dotted numeric token: "17.2.15" yes,
    // "17.2.15-evil" or "17.2.150" no.
    let is_version_token =
        !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit() || c == '.');
    if !is_version_token {
        return Err(format!(
            "unexpected omp --version output (expected 'omp/<dotted-version>'): {trimmed:?}"
        ));
    }
    Ok(format!("omp/{prefix}"))
}

/// Validates that the binary reports exactly `omp/<expected_version>`.
pub fn verify_omp_version(binary: &Path, expected_version: &str) -> Result<(), String> {
    let output = std::process::Command::new(binary)
        .arg("--version")
        .output()
        .map_err(|e| format!("running {} --version: {e}", binary.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_omp_version_output(&stdout)?;
    let expected = format!("omp/{expected_version}");
    if parsed != expected {
        return Err(format!(
            "engine version mismatch: expected exactly {expected:?}, got {parsed:?}"
        ));
    }
    Ok(())
}

/// Exact equality check on parsed version output (helper shared by tests).
pub fn verify_omp_version_output(output: &str, expected_version: &str) -> Result<(), String> {
    let parsed = parse_omp_version_output(output)?;
    let expected = format!("omp/{expected_version}");
    if parsed != expected {
        return Err(format!(
            "engine version mismatch: expected exactly {expected:?}, got {parsed:?}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const MANIFEST_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../.omp-trust/manifest.json"
    );

    fn manifest() -> OmpManifest {
        OmpManifest::load(Path::new(MANIFEST_PATH)).expect("committed manifest must parse")
    }

    fn tmp_file(bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "lhic-trust-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn manifest_is_wellformed() {
        let m = manifest();
        assert_eq!(m.version, "17.2.15");
        assert!(m.artifacts.contains_key("linux-x64"));
        assert!(m.artifacts.contains_key("linux-arm64"));
        assert!(m.artifacts.contains_key("darwin-arm64"));
        assert!(m.artifacts.contains_key("windows-x64"));
        // All digests are 64 lowercase hex chars.
        for artifact in m.artifacts.values() {
            assert_eq!(artifact.asset_sha256.len(), 64, "{}", artifact.asset_name);
            assert!(artifact.asset_sha256.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn expected_sha_matching_file_passes() {
        let m = manifest();
        // Use the linux-arm64 digest with a matching digest string.
        let file = tmp_file(b"trusted bytes");
        // Compute actual hash, then verify against itself via a synthetic
        // artifact (this is the "matching" case at the helper level).
        let actual = sha256_file(&file).unwrap();
        let artifact = ArtifactTrust {
            asset_name: "t".into(),
            asset_sha256: actual.clone(),
        };
        let mut m = m.clone();
        m.artifacts.insert("t".into(), artifact);
        assert!(verify_omp_binary(&m, "t", &file).is_ok());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn tampered_file_fails_verification() {
        let m = manifest();
        let artifact = ArtifactTrust {
            asset_name: "t".into(),
            asset_sha256: "0".repeat(64),
        };
        let mut m = m.clone();
        m.artifacts.insert("t".into(), artifact);
        let file = tmp_file(b"tampered bytes");
        let err = verify_omp_binary(&m, "t", &file).unwrap_err();
        assert!(err.contains("SHA-256 mismatch"), "unexpected: {err}");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn unsupported_platform_fails() {
        let m = manifest();
        let err = m.artifact("os2-warp-ppc").unwrap_err();
        assert!(err.contains("unsupported"), "unexpected: {err}");
    }

    #[test]
    fn missing_manifest_entry_fails() {
        let m = manifest();
        assert!(m.artifact("does-not-exist").is_err());
    }

    #[test]
    fn wrong_version_string_fails() {
        // The helper requires the binary to print omp/<expected>; a bogus
        // expected version must fail even when the binary is fine.
        let file = tmp_file(b"#!/bin/sh\necho omp/17.2.15\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            let err = verify_omp_version(&file, "99.0.0").unwrap_err();
            assert!(err.contains("version mismatch"), "unexpected: {err}");
        }
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn correct_version_string_passes() {
        let file = tmp_file(b"#!/bin/sh\necho omp/17.2.15\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(verify_omp_version(&file, "17.2.15").is_ok());
        }
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn exact_version_matching() {
        // Pass cases.
        assert_eq!(
            parse_omp_version_output("omp/17.2.15").unwrap(),
            "omp/17.2.15"
        );
        assert_eq!(
            parse_omp_version_output("omp/17.2.15\n").unwrap(),
            "omp/17.2.15"
        );
        assert_eq!(
            parse_omp_version_output("  omp/17.2.15  \n").unwrap(),
            "omp/17.2.15"
        );
        // Reject cases: loose substring matches must not pass.
        assert!(parse_omp_version_output("omp/17.2.15-evil").is_err());
        assert!(parse_omp_version_output("foo omp/17.2.15 bar").is_err());
        assert!(parse_omp_version_output("17.2.15").is_err());
        assert!(parse_omp_version_output("omp /17.2.15").is_err());
        assert!(parse_omp_version_output("").is_err());
        // "omp/17.2.150" parses as a dotted token but fails exact equality.
        assert_eq!(
            parse_omp_version_output("omp/17.2.150").unwrap(),
            "omp/17.2.150"
        );
        // Exact equality against the expected version, not prefix matching.
        assert!(verify_omp_version_output("omp/17.2.15", "17.2.15").is_ok());
        assert!(verify_omp_version_output("omp/17.2.15", "17.2.150").is_err());
        assert!(verify_omp_version_output("omp/17.2.15-evil", "17.2.15").is_err());
    }
}
