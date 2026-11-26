//! Tauri commands that keep the SQLite library in sync with favorite-dir scans.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::db::{with_conn, with_tx};
use crate::paths::{canon_key, hash_hex, now_ms};

/// 各搜索入口统一的默认条数与硬上限；只允许在这里调整。
pub(crate) const QUERY_LIMIT_DEFAULT: i64 = 60;
pub(crate) const QUERY_LIMIT_MAX: i64 = 200;

pub(crate) fn clamp_query_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(QUERY_LIMIT_DEFAULT)
        .clamp(1, QUERY_LIMIT_MAX)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    pub path_key: String,
    pub kind: String,
    pub media_type: Option<String>,
    pub name: String,
    pub ext: Option<String>,
    pub parent_path: Option<String>,
    pub folder: Option<String>,
    pub size: Option<i64>,
    pub mtime: Option<i64>,
    pub extra: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRow {
    pub id: String,
    pub kind: String,
    pub media_type: Option<String>,
    pub name: String,
    pub ext: Option<String>,
    pub path_key: String,
    pub parent_path: Option<String>,
    pub folder: Option<String>,
    pub size: Option<i64>,
    pub mtime: Option<i64>,
    pub extra: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
    /// Tag names that matched the search query. Empty for list_items / rows
    /// that matched by name only.
    #[serde(default)]
    pub matched_tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub favorites: usize,
    pub entries: usize,
    pub missing: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMeta {
    /// True once at least one favorite has been synced by a scan. The legacy
    /// import inserts favorite rows with created_at == updated_at, so this is
    /// false after a fresh import and true after the first scan.
    pub synced: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEntry {
    pub item_id: String,
    pub page: Option<i64>,
    #[serde(default)]
    pub position: Option<f64>,
    #[serde(default)]
    pub kind: Option<String>,
    pub ts: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRow {
    pub item_id: String,
    pub kind: String,
    pub page: Option<i64>,
    pub position: Option<f64>,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteRow {
    pub path_key: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// Rows whose name matched the query. Favorite roots are never included.
    pub items: Vec<ItemRow>,
    /// Parent pack/group rows of matched video/image files, so the frontend
    /// can group single-file hits under their containing directory without
    /// needing an extra round-trip.
    pub parents: Vec<ItemRow>,
}

/// Escapes LIKE wildcards so user input is matched literally. Backslash is
/// escaped first so the later % / _ escapes stay unambiguous with ESCAPE '\'.
fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub(crate) fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ItemRow> {
    let extra: String = row.get(10)?;
    Ok(ItemRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        media_type: row.get(2)?,
        name: row.get(3)?,
        ext: row.get(4)?,
        path_key: row.get(5)?,
        parent_path: row.get(6)?,
        folder: row.get(7)?,
        size: row.get(8)?,
        mtime: row.get(9)?,
        extra: serde_json::from_str(&extra).unwrap_or(serde_json::Value::Null),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        matched_tags: Vec::new(),
    })
}

pub(crate) const ITEM_COLUMNS: &str =
    "id, kind, media_type, name, ext, path_key, parent_path, folder, size, mtime, extra, created_at, updated_at";

/// 给命中的单文件视频/图片补上父目录行，让前端能把散文件折叠进所在目录。
///
/// 名称搜索与标签筛选的命中条件不同，父目录查询 SQL 由调用方给出；这里只负责
/// 取行、按实际命中的父目录过滤，避免同一段循环在两个入口各写一遍。
pub(crate) fn attach_parents(
    conn: &Connection,
    items: &[ItemRow],
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<ItemRow>, String> {
    let file_parent_keys: std::collections::HashSet<&str> = items
        .iter()
        .filter(|i| i.kind == "video" || i.kind == "image")
        .filter_map(|i| i.parent_path.as_deref())
        .collect();
    if file_parent_keys.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params, row_to_item)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let row = r.map_err(|e| e.to_string())?;
        if file_parent_keys.contains(row.path_key.as_str()) {
            out.push(row);
        }
    }
    Ok(out)
}

/// Name fuzzy search over non-missing library items. Favorites (the root
/// container rows) are intentionally excluded; matched video/image files get
/// their parent pack/group rows returned separately for grouped display.
pub fn search_items_inner(
    conn: &Connection,
    query: &str,
    kind: Option<&str>,
    limit: Option<i64>,
) -> Result<SearchResults, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchResults {
            items: Vec::new(),
            parents: Vec::new(),
        });
    }
    let like = format!("%{}%", escape_like(trimmed));
    let limit = clamp_query_limit(limit);

    // 名称命中 OR 标签命中：标签走 item_tags→tags 子查询，同一 ?1 LIKE 模式复用。
    let mut sql = format!(
        "SELECT {ITEM_COLUMNS} FROM items
         WHERE missing = 0 AND kind != 'favorite' AND (
            name LIKE ?1 ESCAPE '\\'
            OR id IN (
                SELECT it.item_id FROM item_tags it
                JOIN tags t ON t.id = it.tag_id
                WHERE t.name LIKE ?1 ESCAPE '\\'
            )
         )"
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(like.clone())];
    let mut limit_idx = 2;
    if let Some(k) = kind {
        sql.push_str(" AND kind = ?2");
        params.push(Box::new(k.to_string()));
        limit_idx = 3;
    }
    sql.push_str(&format!(" ORDER BY name COLLATE NOCASE LIMIT ?{limit_idx}"));
    params.push(Box::new(limit));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())), row_to_item)
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for r in rows {
        items.push(r.map_err(|e| e.to_string())?);
    }

    // 把标签命中的标签名回填到 matched_tags：一次查询按 item_id 索引，
    // 只给仍然留在结果里的条目打标记。
    let mut tag_hits: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT it.item_id, t.name FROM item_tags it
                 JOIN tags t ON t.id = it.tag_id
                 WHERE t.name LIKE ?1 ESCAPE '\\'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&like], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (item_id, tag_name) = r.map_err(|e| e.to_string())?;
            tag_hits.entry(item_id).or_default().push(tag_name);
        }
    }
    for item in &mut items {
        if let Some(names) = tag_hits.get(&item.id) {
            item.matched_tags = names.clone();
        }
    }

    // 系列折叠：文件命中时，若其祖先目录链上存在命中的 pack/group，
    // 说明它只是系列目录下的一个单集/成员，并入目录结果，避免搜
    // "蜡笔小新"返回几百个单集。查询词具体到目录名之外（集号/剧场版
    // 名等）时，祖先目录不命中，单文件仍独立返回。
    // 注意必须沿 parent_path 向上找全链：系列常见"系列名(group) →
    // 季/集数子目录(pack) → 单集(video)"结构，单集的直接父目录名
    // 往往不含系列名。目录既可按名称命中，也可按标签命中。
    let mut pack_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    if kind.is_none() {
        let mut stmt = conn
            .prepare(
                "SELECT path_key FROM items
                 WHERE missing = 0 AND kind IN ('pack', 'group') AND (
                    name LIKE ?1 ESCAPE '\\'
                    OR id IN (
                        SELECT it.item_id FROM item_tags it
                        JOIN tags t ON t.id = it.tag_id
                        WHERE t.name LIKE ?1 ESCAPE '\\'
                    )
                 )",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&like], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for r in rows {
            pack_keys.insert(r.map_err(|e| e.to_string())?);
        }
    }
    if !pack_keys.is_empty() {
        // path_key -> parent_path，用于向上追溯祖先目录
        let mut ancestry: std::collections::HashMap<String, Option<String>> =
            std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT path_key, parent_path FROM items")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for r in rows {
                let (k, p) = r.map_err(|e| e.to_string())?;
                ancestry.insert(k, p);
            }
        }
        items.retain(|i| {
            if i.kind != "video" && i.kind != "image" {
                return true;
            }
            let mut cur = i.parent_path.clone();
            let mut seen = std::collections::HashSet::new();
            while let Some(p) = cur {
                if p.is_empty() || !seen.insert(p.clone()) {
                    break;
                }
                if pack_keys.contains(&p) {
                    return false; // 祖先目录命中 → 折叠
                }
                cur = ancestry.get(&p).cloned().unwrap_or(None);
            }
            true
        });
    }

    // Parent rows for the remaining matched single files, so the UI can show
    // e.g. "在《Season 1》中找到 3 个匹配" without another round-trip.
    let parents = attach_parents(
        conn,
        &items,
        &format!(
            "SELECT {ITEM_COLUMNS} FROM items
             WHERE path_key IN (
                 SELECT DISTINCT parent_path FROM items
                 WHERE missing = 0 AND kind IN ('video', 'image') AND (
                    name LIKE ?1 ESCAPE '\\'
                    OR id IN (
                        SELECT it.item_id FROM item_tags it
                        JOIN tags t ON t.id = it.tag_id
                        WHERE t.name LIKE ?1 ESCAPE '\\'
                    )
                 )
             )
             ORDER BY name COLLATE NOCASE"
        ),
        &[&like as &dyn rusqlite::ToSql],
    )?;

    Ok(SearchResults { items, parents })
}

#[tauri::command]
pub fn search_items(
    app: AppHandle,
    query: String,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<SearchResults, String> {
    with_conn(&app, |conn| {
        search_items_inner(conn, &query, kind.as_deref(), limit)
    })
}

pub fn get_progress_inner(conn: &Connection) -> Result<Vec<ProgressRow>, String> {
    let mut stmt = conn
        .prepare("SELECT item_id, kind, page, position, updated_at FROM progress")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ProgressRow {
                item_id: row.get(0)?,
                kind: row.get(1)?,
                page: row.get(2)?,
                position: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Upsert comic/video progress rows. Rows whose item no longer exists (FK
/// failure) are skipped so progress for out-of-library files fails silently.
pub fn save_progress_map_inner(
    conn: &Connection,
    entries: &[ProgressEntry],
) -> Result<usize, String> {
    let mut saved = 0;
    for e in entries {
        let kind = e.kind.as_deref().unwrap_or("comic");
        let res = conn.execute(
            "INSERT INTO progress (item_id, kind, page, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(item_id) DO UPDATE SET
                kind = excluded.kind,
                page = COALESCE(excluded.page, progress.page),
                position = COALESCE(excluded.position, progress.position),
                updated_at = excluded.updated_at",
            params![e.item_id, kind, e.page, e.position, e.ts],
        );
        match res {
            Ok(_) => saved += 1,
            Err(_) => { /* item missing: skip */ }
        }
    }
    Ok(saved)
}

pub fn get_favorites_inner(conn: &Connection) -> Result<Vec<FavoriteRow>, String> {
    let mut stmt = conn
        .prepare("SELECT path_key, name FROM items WHERE kind = 'favorite' AND missing = 0 ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(FavoriteRow {
                path_key: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn add_favorite_inner(conn: &Connection, path: &str, name: &str) -> Result<(), String> {
    let path_key = canon_key(path);
    let id = hash_hex(&path_key);
    let now = now_ms();
    conn.execute(
        "INSERT INTO items (id, kind, name, path_key, created_at, updated_at)
         VALUES (?1, 'favorite', ?2, ?3, ?4, ?4)
         ON CONFLICT(path_key) DO UPDATE SET
            name = excluded.name,
            missing = 0,
            updated_at = excluded.updated_at",
        params![id, name, path_key, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_favorite_inner(conn: &Connection, path: &str) -> Result<(), String> {
    let path_key = canon_key(path);
    let sep = if cfg!(target_os = "windows") { "\\" } else { "/" };
    conn.execute(
        "DELETE FROM items WHERE kind = 'favorite' AND path_key = ?1",
        params![path_key],
    )
    .map_err(|e| e.to_string())?;
    // Explicitly removing a favorite removes its subtree from the library too
    // (source files are untouched; progress rows cascade via the FK).
    conn.execute(
        "DELETE FROM items WHERE parent_path = ?1 OR parent_path LIKE ?1 || ?2 || '%'",
        params![path_key, sep],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear_library_inner(conn: &Connection) -> Result<usize, String> {
    // Progress rows cascade via the FK on items.id.
    let n = conn
        .execute("DELETE FROM items WHERE kind != 'favorite'", [])
        .map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
pub fn get_progress(app: AppHandle) -> Result<Vec<ProgressRow>, String> {
    with_conn(&app, get_progress_inner)
}

#[tauri::command]
pub fn save_progress_map(app: AppHandle, entries: Vec<ProgressEntry>) -> Result<usize, String> {
    with_tx(&app, |conn| save_progress_map_inner(conn, &entries))
}

#[tauri::command]
pub fn get_favorites(app: AppHandle) -> Result<Vec<FavoriteRow>, String> {
    with_conn(&app, get_favorites_inner)
}

#[tauri::command]
pub fn add_favorite(app: AppHandle, path: String, name: String) -> Result<(), String> {
    with_tx(&app, |conn| add_favorite_inner(conn, &path, &name))
}

#[tauri::command]
pub fn remove_favorite(app: AppHandle, path: String) -> Result<(), String> {
    with_tx(&app, |conn| remove_favorite_inner(conn, &path))
}

#[tauri::command]
pub fn clear_library(app: AppHandle) -> Result<usize, String> {
    with_tx(&app, clear_library_inner)
}

/// Core logic for force_rescan, kept free of transaction handling so it can be tested.
///
/// `library_meta.synced` is derived as
/// `EXISTS(SELECT 1 FROM items WHERE kind = 'favorite' AND updated_at != created_at)`.
/// Resetting `updated_at = created_at` on favorite rows marks the library as
/// never-scanned, so the frontend's next `loadLibrary` takes the `scanAll()` path.
pub fn force_rescan_inner(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "UPDATE items SET updated_at = created_at WHERE kind = 'favorite'",
        [],
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn force_rescan(app: AppHandle) -> Result<usize, String> {
    with_tx(&app, force_rescan_inner)
}

/// Core sync logic, kept free of transaction handling so it can be tested.
pub fn sync_favorite_inner(
    conn: &Connection,
    favorite: &ItemInput,
    entries: &[ItemInput],
) -> Result<SyncStats, String> {
    if favorite.path_key.trim().is_empty() {
        return Err("favorite pathKey is empty".to_string());
    }
    let now = now_ms();
    let fav_key = canon_key(&favorite.path_key);
    let fav_id = hash_hex(&fav_key);
    let sep = if cfg!(target_os = "windows") { "\\" } else { "/" };

    // 1. Favorite root itself. size/mtime/media_type/extra are persisted so the
    // frontend can serve unchanged subtrees from this index without re-reading
    // the disk. media_type/extra matter: a favorite whose root IS a media pack
    // (compact view) merges the pack fields into this row, and the fast path
    // re-checks that shape — without persisting them the row never converges
    // and every entry falls back to a full scan.
    let fav_extra = favorite
        .extra
        .as_ref()
        .map(serde_json::Value::to_string)
        .unwrap_or_else(|| "{}".to_string());
    conn.execute(
        "INSERT INTO items (id, kind, media_type, name, ext, path_key, parent_path, folder, size, mtime, extra, created_at, updated_at)
         VALUES (?1, 'favorite', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT(path_key) DO UPDATE SET
            media_type = excluded.media_type,
            name = excluded.name,
            missing = 0,
            size = excluded.size,
            mtime = excluded.mtime,
            extra = excluded.extra,
            updated_at = excluded.updated_at",
        params![
            fav_id,
            favorite.media_type,
            favorite.name,
            favorite.ext,
            fav_key,
            favorite.parent_path,
            favorite.folder,
            favorite.size,
            favorite.mtime,
            fav_extra,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    // 2. Everything under this favorite that was not seen this round becomes
    // missing. Manual books outside favorites are untouched (parent_path is
    // NULL and does not match the prefix).
    let missing = conn
        .execute(
            "UPDATE items SET missing = 1, updated_at = ?2
             WHERE kind != 'favorite' AND missing = 0
               AND (parent_path = ?1 OR parent_path LIKE ?1 || ?3 || '%')",
            params![fav_key, now, sep],
        )
        .map_err(|e| e.to_string())?;

    // 3. Upsert this round's scanned entries.
    for entry in entries {
        let path_key = canon_key(&entry.path_key);
        let id = hash_hex(&path_key);
        let extra = entry
            .extra
            .as_ref()
            .map(serde_json::Value::to_string)
            .unwrap_or_else(|| "{}".to_string());
        conn.execute(
            "INSERT INTO items (id, kind, media_type, name, ext, path_key, parent_path, folder, size, mtime, extra, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
             ON CONFLICT(path_key) DO UPDATE SET
                kind = excluded.kind,
                media_type = excluded.media_type,
                name = excluded.name,
                ext = excluded.ext,
                parent_path = excluded.parent_path,
                folder = excluded.folder,
                size = excluded.size,
                mtime = excluded.mtime,
                extra = excluded.extra,
                missing = 0,
                updated_at = excluded.updated_at",
            params![
                id,
                entry.kind,
                entry.media_type,
                entry.name,
                entry.ext,
                path_key,
                entry.parent_path,
                entry.folder,
                entry.size,
                entry.mtime,
                extra,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(SyncStats {
        favorites: 1,
        entries: entries.len(),
        missing,
    })
}

#[tauri::command]
pub fn sync_favorite(
    app: AppHandle,
    favorite: ItemInput,
    entries: Vec<ItemInput>,
) -> Result<SyncStats, String> {
    with_tx(&app, |conn| sync_favorite_inner(conn, &favorite, &entries))
}

/// 全量条目行，供 Home 等页面启动时直接重建视图模型。
pub fn list_items_inner(conn: &Connection) -> Result<Vec<ItemRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ITEM_COLUMNS} FROM items WHERE missing = 0 ORDER BY name"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_item)
        .map_err(|e| e.to_string())?;
    rows.map(|r| r.map_err(|e| e.to_string())).collect()
}

#[tauri::command]
pub fn list_items(app: AppHandle) -> Result<Vec<ItemRow>, String> {
    with_conn(&app, list_items_inner)
}

#[tauri::command]
pub fn library_meta(app: AppHandle) -> Result<LibraryMeta, String> {
    with_conn(&app, |conn| {
        let synced: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE kind = 'favorite' AND updated_at != created_at)",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(LibraryMeta {
            synced: synced != 0,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/001_init.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../migrations/003_tags.sql"))
            .unwrap();
        conn
    }

    fn item(path_key: &str, kind: &str, parent: Option<&str>) -> ItemInput {
        ItemInput {
            path_key: path_key.to_string(),
            kind: kind.to_string(),
            media_type: None,
            name: path_key.to_string(),
            ext: None,
            parent_path: parent.map(str::to_string),
            folder: Some("Fav".to_string()),
            size: None,
            mtime: None,
            extra: None,
        }
    }

    fn insert_item(
        conn: &Connection,
        id: &str,
        kind: &str,
        name: &str,
        path_key: &str,
        parent_path: Option<&str>,
        missing: i64,
    ) {
        let now = now_ms();
        conn.execute(
            "INSERT INTO items (id, kind, name, path_key, parent_path, missing, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, kind, name, path_key, parent_path, missing, now],
        )
        .unwrap();
    }

    fn list_rows(conn: &Connection) -> Vec<ItemRow> {
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, media_type, name, ext, path_key, parent_path, folder,
                        size, mtime, extra, created_at, updated_at
                 FROM items WHERE missing = 0",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                let extra: String = row.get(10)?;
                Ok(ItemRow {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    media_type: row.get(2)?,
                    name: row.get(3)?,
                    ext: row.get(4)?,
                    path_key: row.get(5)?,
                    parent_path: row.get(6)?,
                    folder: row.get(7)?,
                    size: row.get(8)?,
                    mtime: row.get(9)?,
                    extra: serde_json::from_str(&extra).unwrap_or(serde_json::Value::Null),
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    matched_tags: Vec::new(),
                })
            })
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }

    #[test]
    fn search_finds_kinds_and_groups_file_hits_under_parents() {
        let conn = open_db();
        insert_item(&conn, "fav", "favorite", "My Fav", "f:\\fav", None, 0);
        insert_item(&conn, "c1", "comic", "One Piece 100.cbz", "f:\\fav\\One Piece 100.cbz", Some("f:\\fav"), 0);
        insert_item(&conn, "p1", "pack", "Anime 2024", "f:\\fav\\Anime 2024", Some("f:\\fav"), 0);
        insert_item(&conn, "v1", "video", "EP 01.mkv", "f:\\fav\\Anime 2024\\EP 01.mkv", Some("f:\\fav\\Anime 2024"), 0);
        insert_item(&conn, "img1", "image", "cover art.jpg", "f:\\fav\\Anime 2024\\cover art.jpg", Some("f:\\fav\\Anime 2024"), 0);

        // Comic name search hits the file only.
        let res = search_items_inner(&conn, "one", None, None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].kind, "comic");
        assert!(res.parents.is_empty());

        // File-name search returns the file plus its parent pack.
        let res = search_items_inner(&conn, "ep 01", None, None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].kind, "video");
        assert_eq!(res.parents.len(), 1);
        assert_eq!(res.parents[0].path_key, "f:\\fav\\Anime 2024");

        // Favorite roots are never search targets.
        let res = search_items_inner(&conn, "my fav", None, None).unwrap();
        assert!(res.items.is_empty());
    }

    #[test]
    fn search_collapses_series_files_into_matched_parent() {
        let conn = open_db();
        // 结构 A：pack 直接装单集
        insert_item(&conn, "p1", "pack", "哆啦A梦", "f:\\video\\哆啦A梦", Some("f:\\video"), 0);
        insert_item(
            &conn,
            "v1",
            "video",
            "哆啦A梦 第01集.mkv",
            "f:\\video\\哆啦A梦\\哆啦A梦 第01集.mkv",
            Some("f:\\video\\哆啦A梦"),
            0,
        );
        insert_item(
            &conn,
            "v2",
            "video",
            "哆啦A梦 第02集.mkv",
            "f:\\video\\哆啦A梦\\哆啦A梦 第02集.mkv",
            Some("f:\\video\\哆啦A梦"),
            0,
        );
        // 结构 B：group -> 季子目录 -> 单集（子目录名不含系列名，是原 bug 的漏网场景）
        insert_item(&conn, "g1", "group", "蜡笔小新", "f:\\video\\蜡笔小新", Some("f:\\video"), 0);
        insert_item(
            &conn,
            "p2",
            "pack",
            "第1-100集",
            "f:\\video\\蜡笔小新\\第1-100集",
            Some("f:\\video\\蜡笔小新"),
            0,
        );
        insert_item(
            &conn,
            "v3",
            "video",
            "蜡笔小新 第001集.mkv",
            "f:\\video\\蜡笔小新\\第1-100集\\蜡笔小新 第001集.mkv",
            Some("f:\\video\\蜡笔小新\\第1-100集"),
            0,
        );
        insert_item(
            &conn,
            "v4",
            "video",
            "蜡笔小新 第002集.mkv",
            "f:\\video\\蜡笔小新\\第1-100集\\蜡笔小新 第002集.mkv",
            Some("f:\\video\\蜡笔小新\\第1-100集"),
            0,
        );
        // 独立文件：直接挂在收藏夹下，祖先链上无命中的目录，应单独返回
        insert_item(
            &conn,
            "v5",
            "video",
            "蜡笔小新 剧场版 大人帝国.mkv",
            "f:\\video\\蜡笔小新 剧场版 大人帝国.mkv",
            Some("f:\\video"),
            0,
        );

        // 搜系列名：group 命中，其下所有单集（含跨季目录）折叠，只保留目录和独立文件
        let res = search_items_inner(&conn, "蜡笔小新", None, None).unwrap();
        let names: Vec<&str> = res.items.iter().map(|i| i.name.as_str()).collect();
        assert!(names.contains(&"蜡笔小新"));
        assert!(!names.contains(&"蜡笔小新 第001集.mkv"));
        assert!(!names.contains(&"蜡笔小新 第002集.mkv"));
        assert!(names.contains(&"蜡笔小新 剧场版 大人帝国.mkv"));
        assert_eq!(res.items.len(), 2);

        // 搜具体集号：目录不命中，单集文件独立返回并带上父目录
        let res = search_items_inner(&conn, "第001集", None, None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].kind, "video");
        assert_eq!(res.parents.len(), 1);
        assert_eq!(res.parents[0].name, "第1-100集");

        // pack 直装单集：同样折叠
        let res = search_items_inner(&conn, "哆啦A梦", None, None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].kind, "pack");
    }

    #[test]
    fn search_escapes_like_wildcards_and_skips_missing() {
        let conn = open_db();
        insert_item(&conn, "pct", "comic", "100% real.cbz", "pct", None, 0);
        insert_item(&conn, "und", "comic", "x_a_c.cbz", "und", None, 0);
        insert_item(&conn, "plain", "comic", "abc.cbz", "plain", None, 0);
        insert_item(&conn, "gone", "comic", "Gone.cbz", "gone", None, 1);

        // Literal percent and underscore must match, not act as wildcards.
        assert_eq!(search_items_inner(&conn, "%", None, None).unwrap().items.len(), 1);
        assert_eq!(search_items_inner(&conn, "100%", None, None).unwrap().items.len(), 1);
        let res = search_items_inner(&conn, "a_c", None, None).unwrap();
        assert_eq!(res.items.len(), 1, "a_c must match only the literal underscore row");
        assert_eq!(res.items[0].name, "x_a_c.cbz");
        // With an unescaped _ the same query would also match abc.cbz.

        // Missing rows are invisible to search.
        assert!(search_items_inner(&conn, "gone", None, None).unwrap().items.is_empty());
    }

    #[test]
    fn search_kind_filter_and_limit() {
        let conn = open_db();
        insert_item(&conn, "v1", "video", "clip.mkv", "v1", None, 0);
        insert_item(&conn, "i1", "image", "clip.jpg", "i1", None, 0);

        let res = search_items_inner(&conn, "clip", Some("video"), None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].kind, "video");

        let res = search_items_inner(&conn, "clip", None, Some(1)).unwrap();
        assert_eq!(res.items.len(), 1);
    }

    #[test]
    fn sync_marks_missing_only_inside_favorite() {
        let conn = open_db();
        let now = now_ms();
        // Manual book outside any favorite: must never be marked missing.
        conn.execute(
            "INSERT INTO items (id, kind, name, path_key, parent_path, created_at, updated_at)
             VALUES ('manual', 'comic', 'm.cbz', 'manual', NULL, ?1, ?1)",
            params![now],
        )
        .unwrap();
        // A stale item under the favorite: should become missing after sync.
        conn.execute(
            "INSERT INTO items (id, kind, name, path_key, parent_path, created_at, updated_at)
             VALUES ('stale', 'comic', 'old.cbz', 'f:\\fav\\old.cbz', 'f:\\fav', ?1, ?1)",
            params![now],
        )
        .unwrap();

        let fav = ItemInput {
            path_key: "F:\\fav".to_string(),
            kind: "favorite".to_string(),
            media_type: None,
            name: "Fav".to_string(),
            ext: None,
            parent_path: None,
            folder: None,
            size: None,
            mtime: Some(1000),
            extra: None,
        };
        let entries = vec![item("F:\\fav\\a.cbz", "comic", Some("F:\\fav"))];

        sync_favorite_inner(&conn, &fav, &entries).unwrap();

        let manual_missing: i64 = conn
            .query_row("SELECT missing FROM items WHERE path_key='manual'", [], |r| r.get(0))
            .unwrap();
        let stale_missing: i64 = conn
            .query_row("SELECT missing FROM items WHERE path_key='f:\\fav\\old.cbz'", [], |r| r.get(0))
            .unwrap();
        let new_missing: i64 = conn
            .query_row("SELECT missing FROM items WHERE path_key='f:\\fav\\a.cbz'", [], |r| r.get(0))
            .unwrap();
        let fav_missing: i64 = conn
            .query_row("SELECT missing FROM items WHERE path_key='f:\\fav'", [], |r| r.get(0))
            .unwrap();

        assert_eq!(manual_missing, 0, "manual books must not be touched");
        assert_eq!(stale_missing, 1, "stale favorite item should be missing");
        assert_eq!(new_missing, 0);
        assert_eq!(fav_missing, 0);
    }

    #[test]
    fn sync_is_idempotent() {
        let conn = open_db();
        let fav = ItemInput {
            path_key: "F:\\fav".to_string(),
            kind: "favorite".to_string(),
            media_type: None,
            name: "Fav".to_string(),
            ext: None,
            parent_path: None,
            folder: None,
            size: None,
            mtime: Some(1000),
            extra: None,
        };
        let entries = vec![item("F:\\fav\\a.cbz", "comic", Some("F:\\fav"))];

        sync_favorite_inner(&conn, &fav, &entries).unwrap();
        sync_favorite_inner(&conn, &fav, &entries).unwrap();

        let items: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE missing=0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(items, 2); // favorite + comic, no duplicates
    }

    #[test]
    fn progress_roundtrip_and_fk_skip() {
        let conn = open_db();
        let now = now_ms();
        conn.execute(
            "INSERT INTO items (id, kind, name, path_key, created_at, updated_at)
             VALUES ('b1', 'comic', 'x.cbz', 'x.cbz', ?1, ?1)",
            params![now],
        )
        .unwrap();

        let entries = vec![
            ProgressEntry {
                item_id: "b1".to_string(),
                page: Some(7),
                position: None,
                kind: None,
                ts: 100,
            },
            ProgressEntry {
                item_id: "ghost".to_string(),
                page: Some(1),
                position: None,
                kind: Some("comic".to_string()),
                ts: 200,
            },
        ];
        assert_eq!(save_progress_map_inner(&conn, &entries).unwrap(), 1);

        let rows = get_progress_inner(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].item_id, "b1");
        assert_eq!(rows[0].kind, "comic");
        assert_eq!(rows[0].page, Some(7));
        assert_eq!(rows[0].updated_at, 100);
    }

    #[test]
    fn video_progress_roundtrip_and_fk_skip() {
        let conn = open_db();
        insert_item(
            &conn,
            "v1",
            "video",
            "ep01.mkv",
            "f:\\fav\\ep01.mkv",
            Some("f:\\fav"),
            0,
        );

        let entries = vec![
            ProgressEntry {
                item_id: "v1".to_string(),
                page: None,
                position: Some(123.5),
                kind: Some("video".to_string()),
                ts: 300,
            },
            ProgressEntry {
                item_id: "ghost-video".to_string(),
                page: None,
                position: Some(42.0),
                kind: Some("video".to_string()),
                ts: 400,
            },
        ];
        assert_eq!(save_progress_map_inner(&conn, &entries).unwrap(), 1);

        let rows = get_progress_inner(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].item_id, "v1");
        assert_eq!(rows[0].kind, "video");
        assert_eq!(rows[0].page, None);
        assert_eq!(rows[0].position, Some(123.5));
        assert_eq!(rows[0].updated_at, 300);
    }

    #[test]
    fn favorite_add_and_remove() {
        let conn = open_db();
        add_favorite_inner(&conn, "F:\\fav", "Fav").unwrap();
        let favs = get_favorites_inner(&conn).unwrap();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].name, "Fav");

        conn.execute(
            "INSERT INTO items (id, kind, name, path_key, parent_path, created_at, updated_at)
             VALUES ('c1', 'comic', 'a.cbz', 'f:\\fav\\a.cbz', 'f:\\fav', ?1, ?1)",
            params![now_ms()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO progress (item_id, kind, page, updated_at)
             VALUES ('c1', 'comic', 5, 1)",
            [],
        )
        .unwrap();

        remove_favorite_inner(&conn, "F:\\fav").unwrap();
        assert_eq!(get_favorites_inner(&conn).unwrap().len(), 0);
        let remains: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE path_key = 'f:\\fav\\a.cbz'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remains, 0, "subtree should be deleted");
        let progress: i64 = conn
            .query_row("SELECT COUNT(*) FROM progress WHERE item_id = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(progress, 0, "progress should cascade");
    }

    #[test]
    fn sync_persists_and_updates_dir_mtime() {
        let conn = open_db();
        let fav = ItemInput {
            path_key: "F:\\fav".to_string(),
            kind: "favorite".to_string(),
            media_type: None,
            name: "Fav".to_string(),
            ext: None,
            parent_path: None,
            folder: None,
            size: None,
            mtime: Some(1000),
            extra: None,
        };
        let pack = ItemInput {
            path_key: "F:\\fav\\Anime".to_string(),
            kind: "pack".to_string(),
            media_type: Some("video".to_string()),
            name: "Anime".to_string(),
            ext: Some("video".to_string()),
            parent_path: Some("F:\\fav".to_string()),
            folder: Some("Fav".to_string()),
            size: None,
            mtime: Some(2000),
            extra: Some(serde_json::json!({
                "count": 2,
                "videoCount": 2,
                "imageCount": 0,
                "childCount": 0
            })),
        };

        sync_favorite_inner(&conn, &fav, &[pack]).unwrap();
        let fav_mtime: Option<i64> = conn
            .query_row("SELECT mtime FROM items WHERE path_key='f:\\fav'", [], |r| r.get(0))
            .unwrap();
        let pack_mtime: Option<i64> = conn
            .query_row("SELECT mtime FROM items WHERE path_key='f:\\fav\\anime'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fav_mtime, Some(1000), "favorite mtime persisted");
        assert_eq!(pack_mtime, Some(2000), "pack dir mtime persisted");

        // A later scan with a bumped pack mtime must overwrite the stored one.
        let pack2 = ItemInput {
            path_key: "F:\\fav\\Anime".to_string(),
            kind: "pack".to_string(),
            media_type: Some("video".to_string()),
            name: "Anime".to_string(),
            ext: Some("video".to_string()),
            parent_path: Some("F:\\fav".to_string()),
            folder: Some("Fav".to_string()),
            size: None,
            mtime: Some(3000),
            extra: Some(serde_json::json!({
                "count": 2,
                "videoCount": 2,
                "imageCount": 0,
                "childCount": 0
            })),
        };
        sync_favorite_inner(&conn, &fav, &[pack2]).unwrap();
        let refreshed: Option<i64> = conn
            .query_row("SELECT mtime FROM items WHERE path_key='f:\\fav\\anime'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(refreshed, Some(3000), "mtime refreshed on re-sync");

        // Untouched subtree rows (returned by a future DB-serve pass) round-trip
        // through list_items unchanged, so the frontend can trust stored mtimes.
        let rows = list_rows(&conn);
        let row = rows
            .iter()
            .find(|r| r.path_key == "f:\\fav\\anime")
            .expect("pack row listed");
        assert_eq!(row.mtime, Some(3000));
    }

    #[test]
    fn force_rescan_marks_favorites_unsynced() {
        let conn = open_db();
        insert_item(&conn, "fav", "favorite", "My Fav", "f:\\fav", None, 0);
        insert_item(&conn, "c1", "comic", "c1.cbz", "f:\\fav\\c1.cbz", Some("f:\\fav"), 0);

        // 刚插入：created_at == updated_at → 未同步
        let synced: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE kind = 'favorite' AND updated_at != created_at)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(synced, 0);

        // 模拟一次扫描：favorite 行 updated_at 被推进 → synced = true
        conn.execute(
            "UPDATE items SET updated_at = created_at + 1 WHERE kind = 'favorite'",
            [],
        )
        .unwrap();
        let synced: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE kind = 'favorite' AND updated_at != created_at)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(synced, 1);

        // force_rescan 重置回未同步，仅影响 favorite 行
        let n = force_rescan_inner(&conn).unwrap();
        assert_eq!(n, 1, "one favorite row reset");
        let synced: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE kind = 'favorite' AND updated_at != created_at)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(synced, 0, "library no longer marked synced");
    }

    fn tag_item(conn: &Connection, item_id: &str, tag_name: &str) -> i64 {
        let now = now_ms();
        conn.execute(
            "INSERT INTO tags (name, created_at) VALUES (?1, ?2)",
            params![tag_name, now],
        )
        .unwrap();
        let tag_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
            params![item_id, tag_id, now],
        )
        .unwrap();
        tag_id
    }

    #[test]
    fn search_matches_tags_and_marks_matched_tags() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "Some Book.cbz", "p\\Some Book.cbz", Some("p"), 0);
        insert_item(&conn, "c2", "comic", "Another.cbz", "p\\Another.cbz", Some("p"), 0);
        tag_item(&conn, "c1", "追番");

        // 按标签名搜索：名称不含关键词的条目被标签命中，且带 matchedTags 标记
        let res = search_items_inner(&conn, "追番", None, None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].id, "c1");
        assert_eq!(res.items[0].matched_tags, vec!["追番".to_string()]);

        // 名称命中不打标签标记
        let res = search_items_inner(&conn, "some", None, None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].id, "c1");
        assert!(res.items[0].matched_tags.is_empty());
    }

    #[test]
    fn search_collapses_tag_matched_series_files() {
        let conn = open_db();
        insert_item(&conn, "p1", "pack", "Anime 2024", "f:\\fav\\Anime 2024", Some("f:\\fav"), 0);
        insert_item(
            &conn,
            "v1",
            "video",
            "EP 01.mkv",
            "f:\\fav\\Anime 2024\\EP 01.mkv",
            Some("f:\\fav\\Anime 2024"),
            0,
        );
        let tag_id = tag_item(&conn, "p1", "追番");
        // 单集也被打了同一标签：两者都命中时，文件折叠进标签命中的系列目录
        conn.execute(
            "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES ('v1', ?1, ?2)",
            params![tag_id, now_ms()],
        )
        .unwrap();

        let res = search_items_inner(&conn, "追番", None, None).unwrap();
        let kinds: Vec<&str> = res.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["pack"], "tag-matched series collapses its tagged files");
        assert_eq!(res.items[0].matched_tags, vec!["追番".to_string()]);
        assert!(res.parents.is_empty());
    }

    #[test]
    fn search_tag_hit_on_file_returns_parent() {
        let conn = open_db();
        insert_item(&conn, "p1", "pack", "Season 1", "f:\\fav\\Season 1", Some("f:\\fav"), 0);
        insert_item(
            &conn,
            "v1",
            "video",
            "EP 01.mkv",
            "f:\\fav\\Season 1\\EP 01.mkv",
            Some("f:\\fav\\Season 1"),
            0,
        );
        tag_item(&conn, "v1", "待看");

        // 只有文件被标签命中：返回文件 + 其父目录（供前端分组展示）
        let res = search_items_inner(&conn, "待看", None, None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].kind, "video");
        assert_eq!(res.items[0].matched_tags, vec!["待看".to_string()]);
        assert_eq!(res.parents.len(), 1);
        assert_eq!(res.parents[0].path_key, "f:\\fav\\Season 1");
    }
}
