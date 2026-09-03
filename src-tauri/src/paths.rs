//! Path canonicalization and hashing shared by the importer and sync.

use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// Mirrors the frontend `canonKey`: Windows lowercases and normalizes to
/// backslashes; other platforms keep the path as-is.
pub fn canon_key(path: &str) -> String {
    if cfg!(target_os = "windows") {
        path.to_lowercase().replace('/', "\\")
    } else {
        path.to_string()
    }
}

pub fn hash_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn trim_sep(s: &str) -> &str {
    s.trim_end_matches(['/', '\\'])
}

/// Canonical key of the parent directory of `path`.
pub fn dirname_key(path: &str) -> String {
    let trimmed = trim_sep(path);
    match trimmed.rfind(['/', '\\']) {
        Some(idx) => canon_key(trim_sep(&trimmed[..idx])),
        None => canon_key(trimmed),
    }
}

pub fn leaf_name(path: &str) -> String {
    path.split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .last()
        .unwrap_or(path)
        .to_string()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
