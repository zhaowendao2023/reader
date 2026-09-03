//! One-time import of legacy `store.bin` / `progress.json` data.
//!
//! Runs as migration v2 inside a transaction. Book ids are re-derived as
//! sha256(canonKey(path)) so entries created by older id schemes converge on a
//! single identity; progress is remapped through the old id; and a book whose
//! parent directory is a known favorite gets linked under it.

use std::collections::HashMap;
use std::error::Error;
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::paths::{canon_key, dirname_key, hash_hex, leaf_name, now_ms, trim_sep};

const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "webm", "mov", "avi", "ts", "m2ts", "flv", "wmv"];
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];

pub fn run(conn: &Connection, data_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let store = read_json(&data_dir.join("store.bin")).unwrap_or_else(|err| {
        eprintln!("[import] cannot read store.bin: {err}");
        Value::Null
    });
    let progress = read_json(&data_dir.join("progress.json")).unwrap_or_else(|err| {
        eprintln!("[import] cannot read progress.json: {err}");
        Value::Null
    });

    let books = store
        .get("books")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let favorites = store
        .get("favoriteDirs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let progress_map = progress.as_object().cloned().unwrap_or_default();

    let now = now_ms();

    // Favorite roots first, so books can reference them as parents.
    let mut fav_keys = HashMap::new(); // canonical dir -> (item id, display name)
    for fav in favorites.iter() {
        let Some(path) = fav.get("path").and_then(Value::as_str) else {
            continue;
        };
        if path.trim().is_empty() {
            continue;
        }
        let path_key = canon_key(path);
        let id = hash_hex(&path_key);
        let name = fav
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| leaf_name(path));
        conn.execute(
            "INSERT INTO items (id, kind, name, path_key, created_at, updated_at)
             VALUES (?1, 'favorite', ?2, ?3, ?4, ?4)
             ON CONFLICT(path_key) DO NOTHING",
            params![id, name, path_key, now],
        )?;
        fav_keys.insert(trim_sep(&path_key).to_string(), (id, name));
    }

    // Books: re-derive id; remember the old id as an alias for progress.
    let mut aliases = HashMap::new(); // old id -> (new id, kind)
    for (old_id, info) in books.iter() {
        let Some(path) = info.get("path").and_then(Value::as_str) else {
            continue;
        };
        if path.trim().is_empty() {
            continue;
        }
        let path_key = canon_key(path);
        let id = hash_hex(&path_key);
        let ext = info
            .get("ext")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let kind = kind_for_ext(&ext);
        aliases.insert(old_id.clone(), (id.clone(), kind));

        let name = leaf_name(path);
        let (parent_path, folder) = match fav_keys.get(&dirname_key(path)) {
            Some((parent_id, fav_name)) => (Some(parent_id.clone()), Some(fav_name.clone())),
            None => (None, None),
        };
        conn.execute(
            "INSERT INTO items (id, kind, name, ext, path_key, parent_path, folder, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(path_key) DO NOTHING",
            params![id, kind, name, ext, path_key, parent_path, folder, now],
        )?;
    }

    let mut imported = 0;
    let mut orphaned = 0;
    for (old_id, entry) in progress_map.iter() {
        let Some((new_id, kind)) = aliases.get(old_id) else {
            orphaned += 1;
            continue;
        };
        let page = entry.get("page").and_then(Value::as_i64);
        let ts = entry.get("ts").and_then(Value::as_i64).unwrap_or(now);
        conn.execute(
            "INSERT INTO progress (item_id, kind, page, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(item_id) DO UPDATE SET
                kind = excluded.kind,
                page = excluded.page,
                updated_at = excluded.updated_at",
            params![new_id, kind, page, ts],
        )?;
        imported += 1;
    }

    eprintln!(
        "[import] done: {} favorites, {} books; progress {} imported, {} orphaned",
        fav_keys.len(),
        aliases.len(),
        imported,
        orphaned
    );
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, Box<dyn Error>> {
    let text = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&text)?)
}

fn kind_for_ext(ext: &str) -> &'static str {
    if VIDEO_EXTS.contains(&ext) {
        "video"
    } else if IMAGE_EXTS.contains(&ext) {
        "image"
    } else {
        // store.bin has historically only ever held comics.
        "comic"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("import_test_{name}_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_json(dir: &Path, name: &str, value: &Value) {
        fs::write(dir.join(name), serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn open_db(dir: &Path) -> Connection {
        let conn = Connection::open(dir.join("test.db")).unwrap();
        conn.execute_batch(include_str!("../migrations/001_init.sql"))
            .unwrap();
        conn
    }

    #[test]
    fn imports_books_favorites_and_progress() {
        let dir = test_dir("books");
        write_json(
            &dir,
            "store.bin",
            &serde_json::json!({
                "books": { "old1": { "title": "A", "path": "F:\\Comics\\A.cbz", "ext": "cbz" } },
                "favoriteDirs": [ { "path": "F:\\Comics", "name": "Comics" } ]
            }),
        );
        write_json(
            &dir,
            "progress.json",
            &serde_json::json!({ "old1": { "page": 7, "ts": 123456 } }),
        );

        let conn = open_db(&dir);
        run(&conn, &dir).unwrap();

        let items: Vec<(String, String)> = conn
            .prepare("SELECT kind, name FROM items ORDER BY kind")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.contains(&("favorite".to_string(), "Comics".to_string())));
        assert!(items.contains(&("comic".to_string(), "A.cbz".to_string())));

        let expected_id = hash_hex(&canon_key("F:\\Comics\\A.cbz"));
        let book: (String, String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT id, kind, parent_path, folder FROM items WHERE path_key = ?1",
                params![canon_key("F:\\Comics\\A.cbz")],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(book.0, expected_id);
        assert_eq!(book.1, "comic");
        assert!(book.2.is_some(), "book should link to its favorite");
        assert_eq!(book.3.as_deref(), Some("Comics"));

        let prog: (String, i64, Option<i64>) = conn
            .query_row(
                "SELECT item_id, updated_at, page FROM progress",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(prog.0, expected_id);
        assert_eq!(prog.1, 123456);
        assert_eq!(prog.2, Some(7));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn drops_orphan_progress_and_is_idempotent() {
        let dir = test_dir("orphan");
        write_json(
            &dir,
            "store.bin",
            &serde_json::json!({
                "books": { "b1": { "title": "X", "path": "/data/comics/X.cbz", "ext": "cbz" } }
            }),
        );
        write_json(
            &dir,
            "progress.json",
            &serde_json::json!({
                "b1": { "page": 3, "ts": 1 },
                "ghost": { "page": 9, "ts": 2 }
            }),
        );

        let conn = open_db(&dir);
        run(&conn, &dir).unwrap();
        run(&conn, &dir).unwrap();

        let item_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
            .unwrap();
        let progress_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM progress", [], |r| r.get(0))
            .unwrap();
        assert_eq!(item_count, 1);
        assert_eq!(progress_count, 1);

        fs::remove_dir_all(&dir).ok();
    }
}
