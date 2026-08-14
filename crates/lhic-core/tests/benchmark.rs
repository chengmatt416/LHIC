use std::time::Instant;
use lhic_core::security::{Redactor, Vault};
use lhic_core::memory::MemoryStore;
use lhic_core::controller::{route, PathKind};
use lhic_core::skills::SkillDocument;

#[test]
fn benchmark_core_performance() {
    // 1. Benchmark Redaction
    let pii_samples = [
        "User alice@example.com with phone +1-555-123-4567 at IP 10.0.0.1 using sk-1234567890abcdef123456",
        "Plain text without any PII to check fast path bypass",
        "Another key pk-abcdef1234567890 and email support@service.io",
        "Just a number 12345 and a short word",
    ];

    let start = Instant::now();
    let iters = 50_000;
    for i in 0..iters {
        let sample = pii_samples[i % pii_samples.len()];
        let _ = Redactor::redact(sample);
    }
    let elapsed = start.elapsed();
    let ns_per_op = elapsed.as_nanos() / (iters as u128);
    let ops_per_sec = (iters as f64) / elapsed.as_secs_f64();
    println!("\n[Benchmark] Redactor::redact: {:.2} ops/sec ({} ns/op, total: {:?})", ops_per_sec, ns_per_op, elapsed);
    assert!(ops_per_sec > 10_000.0, "Redactor must exceed 10k ops/sec");

    // 2. Benchmark Vault Encryption / Decryption
    let temp_dir = std::env::temp_dir().join(format!("lhic-bench-vault-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp_dir);
    let vault = Vault::open(&temp_dir).unwrap();
    let start = Instant::now();
    let vault_iters = 10_000;
    for _ in 0..vault_iters {
        let sealed = vault.encrypt("sk-proj-test-api-key-1234567890").unwrap();
        let plain = vault.decrypt(&sealed).unwrap();
        assert_eq!(plain, "sk-proj-test-api-key-1234567890");
    }
    let vault_elapsed = start.elapsed();
    let vault_ops = (vault_iters as f64) / vault_elapsed.as_secs_f64();
    println!("[Benchmark] Vault AES-GCM Encrypt+Decrypt: {:.2} ops/sec (total: {:?})", vault_ops, vault_elapsed);
    let _ = std::fs::remove_dir_all(&temp_dir);

    // 3. Benchmark MemoryStore SQLite Performance
    let mem_dir = std::env::temp_dir().join(format!("lhic-bench-mem-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&mem_dir);
    let mut store = MemoryStore::open(&mem_dir.join("bench.sqlite")).unwrap();
    let session = store.create_session("bench-session").unwrap();

    let start = Instant::now();
    let msg_iters = 5_000;
    for i in 0..msg_iters {
        let content = format!("Message content index {} for testing search and insertion", i);
        store.append_message(session.id, "user", &content).unwrap();
    }
    let write_elapsed = start.elapsed();
    let write_ops = (msg_iters as f64) / write_elapsed.as_secs_f64();
    println!("[Benchmark] MemoryStore SQLite Insert: {:.2} ops/sec (total: {:?})", write_ops, write_elapsed);

    let start = Instant::now();
    let search_iters = 1_000;
    for i in 0..search_iters {
        let query = format!("index {}", i % 100);
        let res = store.search(&query, 10).unwrap();
        assert!(!res.is_empty());
    }
    let search_elapsed = start.elapsed();
    let search_ops = (search_iters as f64) / search_elapsed.as_secs_f64();
    println!("[Benchmark] MemoryStore SQLite Search: {:.2} ops/sec (total: {:?})", search_ops, search_elapsed);
    let _ = std::fs::remove_dir_all(&mem_dir);

    // 4. Benchmark Controller Routing
    let skills = vec![
        SkillDocument {
            id: "skill-1".to_string(),
            name: "daily workflow".to_string(),
            description: "complete login, search, and form updates".to_string(),
            category: None,
            tags: Some(vec!["login".to_string(), "form".to_string(), "search".to_string()]),
            rating: None,
            downloads: None,
            version: None,
            extra: Default::default(),
        },
        SkillDocument {
            id: "skill-2".to_string(),
            name: "pdf merge".to_string(),
            description: "merge multiple pdf documents".to_string(),
            category: None,
            tags: Some(vec!["pdf".to_string(), "documents".to_string()]),
            rating: None,
            downloads: None,
            version: None,
            extra: Default::default(),
        },
    ];
    let start = Instant::now();
    let route_iters = 50_000;
    for i in 0..route_iters {
        let intent = if i % 2 == 0 {
            "merge these pdf documents into one file"
        } else {
            "some unknown task description for general agent"
        };
        let decision = route(intent, &skills, &store);
        if i % 2 == 0 {
            assert_eq!(decision.path, PathKind::FastPath);
        } else {
            assert_eq!(decision.path, PathKind::SlowPath);
        }
    }
    let route_elapsed = start.elapsed();
    let route_ops = (route_iters as f64) / route_elapsed.as_secs_f64();
    println!("[Benchmark] Controller Routing: {:.2} ops/sec (total: {:?})", route_ops, route_elapsed);
}
