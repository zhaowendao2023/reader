//! Tag commands: a shared tag vocabulary (`tags`) plus item→tag links
//! (`item_tags`). Links hang off `items.id` (= sha256(lowercased path)), which
//! is stable across rescan upserts, so tags survive re-indexing; the FKs
//! cascade so removing a favorite subtree or deleting a tag never leaves
//! orphan rows.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::AppDb;
use crate::paths::now_ms;
use crate::sync::{row_to_item, ItemRow, ITEM_COLUMNS};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TagRow {
    pub id: i64,
    pub name: String,
    /// Number of items currently carrying this tag (0 for tags with no items).
    pub count: i64,
    /// Tag kind: "" | author | series | character | genre（其他由前端推断/编辑）
    pub kind: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TagSample {
    pub tag_id: i64,
    /// 该标签下最多 SAMPLE_LIMIT 条目的名称（供前端推断角色/系列等类型）
    pub names: Vec<String>,
}

const SAMPLE_LIMIT: i64 = 60;
const SAMPLE_SQL: &str = "SELECT t.id, i.name
     FROM item_tags it
     JOIN tags t ON t.id = it.tag_id
     JOIN items i ON i.id = it.item_id
     WHERE it.tag_id IN ({}) AND i.kind = 'comic'
     ORDER BY i.name COLLATE NOCASE LIMIT ?";

/// 允许的 kind 取值
fn normalize_kind(raw: &str) -> String {
    match raw.trim() {
        "author" | "series" | "character" | "genre" => raw.trim().to_string(),
        _ => String::new(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagItemResults {
    /// Items carrying the tag (matched_tags = [tag name]).
    pub items: Vec<ItemRow>,
    /// Parent pack/group rows of matched video/image files, same shape as
    /// search results so the frontend can group single-file hits.
    pub parents: Vec<ItemRow>,
}

/// Normalizes a tag name: trims and collapses inner whitespace. Case
/// uniqueness is handled by the `COLLATE NOCASE` column (ASCII folding).
fn normalize_tag(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Returns the existing tag id for `name` (case-insensitive) or inserts it.
fn find_or_create_tag(conn: &Connection, name: &str) -> Result<i64, String> {
    let n = normalize_tag(name);
    if n.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
            params![n],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO tags (name, created_at) VALUES (?1, ?2)",
        params![n, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn list_tags_inner(conn: &Connection) -> Result<Vec<TagRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.kind, COUNT(it.item_id) AS item_count
             FROM tags t
             LEFT JOIN item_tags it ON it.tag_id = t.id
             GROUP BY t.id
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TagRow {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn get_item_tags_inner(conn: &Connection, path_key: &str) -> Result<Vec<TagRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.kind,
                    (SELECT COUNT(*) FROM item_tags x WHERE x.tag_id = t.id)
             FROM item_tags it
             JOIN tags t ON t.id = it.tag_id
             JOIN items i ON i.id = it.item_id
             WHERE i.path_key = ?1
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![path_key], |row| {
            Ok(TagRow {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 一次取回多个标签下的条目名称样本（漫画），供前端推断 kind。
pub fn get_tag_samples_inner(
    conn: &Connection,
    tag_ids: &[i64],
) -> Result<Vec<TagSample>, String> {
    if tag_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; tag_ids.len()].join(",");
    let sql = SAMPLE_SQL.replace("{}", &placeholders);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?;
    // 参数：tag_ids… + LIMIT
    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = tag_ids
        .iter()
        .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
        .collect();
    params_vec.push(Box::new(SAMPLE_LIMIT));
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params_vec.iter().map(|p| p.as_ref())),
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut map: std::collections::BTreeMap<i64, Vec<String>> = std::collections::BTreeMap::new();
    for r in rows {
        let (tid, name) = r.map_err(|e| e.to_string())?;
        let entry = map.entry(tid).or_default();
        if entry.len() < SAMPLE_LIMIT as usize {
            entry.push(name);
        }
    }
    Ok(map
        .into_iter()
        .map(|(tag_id, names)| TagSample { tag_id, names })
        .collect())
}

/// 设置标签的类型（kind），非法值视为清空为未分类。
pub fn set_tag_kind_inner(conn: &Connection, tag_id: i64, kind: &str) -> Result<(), String> {
    let k = normalize_kind(kind);
    conn.execute(
        "UPDATE tags SET kind = ?1 WHERE id = ?2",
        params![k, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Replaces the full tag set of one item: finds/creates each tag then
/// rewrites the item's links. Caller wraps in a transaction.
pub fn set_item_tags_inner(
    conn: &Connection,
    path_key: &str,
    tag_names: &[String],
) -> Result<Vec<TagRow>, String> {
    let item_id: String = conn
        .query_row(
            "SELECT id FROM items WHERE path_key = ?1",
            params![path_key],
            |r| r.get(0),
        )
        .map_err(|_| "条目不在库中，无法打标签".to_string())?;

    // Normalize + dedupe case-insensitively.
    let mut names: Vec<String> = Vec::new();
    for raw in tag_names {
        let n = normalize_tag(raw);
        if n.is_empty() {
            continue;
        }
        if !names.iter().any(|x| x.eq_ignore_ascii_case(&n)) {
            names.push(n);
        }
    }

    let tag_ids: Vec<i64> = names
        .iter()
        .map(|n| find_or_create_tag(conn, n))
        .collect::<Result<_, _>>()?;

    conn.execute("DELETE FROM item_tags WHERE item_id = ?1", params![item_id])
        .map_err(|e| e.to_string())?;
    for tid in &tag_ids {
        conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id, created_at)
             VALUES (?1, ?2, ?3)",
            params![item_id, tid, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }

    get_item_tags_inner(conn, path_key)
}

pub fn rename_tag_inner(conn: &Connection, tag_id: i64, new_name: &str) -> Result<(), String> {
    let n = normalize_tag(new_name);
    if n.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    let clash: Option<i64> = conn
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE AND id != ?2",
            params![n, tag_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if clash.is_some() {
        return Err("已存在同名标签".to_string());
    }
    conn.execute(
        "UPDATE tags SET name = ?1 WHERE id = ?2",
        params![n, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Deleting a tag removes its links via the FK cascade.
pub fn delete_tag_inner(conn: &Connection, tag_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Items carrying ALL of the given tag ids (AND intersection), with
/// matched_tags = every selected tag name (each returned item holds them all),
/// so the frontend renders them identically to search hits. Parent pack/group
/// rows of matched video/image files are returned for grouped display.
pub fn get_tag_items_inner(
    conn: &Connection,
    tag_ids: &[i64],
    limit: Option<i64>,
) -> Result<TagItemResults, String> {
    if tag_ids.is_empty() {
        return Ok(TagItemResults {
            items: Vec::new(),
            parents: Vec::new(),
        });
    }
    let limit = limit.unwrap_or(60).clamp(1, 200);

    // 选中标签名：返回的条目满足全部选中标签，所以直接全部标记
    let mut tag_names: Vec<String> = Vec::new();
    {
        let placeholders = vec!["?"; tag_ids.len()].join(",");
        let sql = format!("SELECT name FROM tags WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(tag_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            tag_names.push(r.map_err(|e| e.to_string())?);
        }
        tag_names.sort();
    }

    // 交集子查询（内联进外层语句时占位符是全局位置的 ?1..?N）：
    // 条目必须同时拥有每一个选中标签
    let placeholders = vec!["?"; tag_ids.len()].join(",");
    let sub_sql = format!(
        "SELECT item_id FROM item_tags
         WHERE tag_id IN ({placeholders})
         GROUP BY item_id
         HAVING COUNT(DISTINCT tag_id) = {}",
        tag_ids.len()
    );

    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = tag_ids
        .iter()
        .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
        .collect();
    let sql = format!(
        "SELECT {ITEM_COLUMNS} FROM items
         WHERE missing = 0 AND kind != 'favorite'
           AND id IN ({sub_sql})
         ORDER BY name COLLATE NOCASE LIMIT ?{}",
        tag_ids.len() + 1
    );
    params_vec.push(Box::new(limit as i64));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params_vec.iter().map(|p| p.as_ref())),
            row_to_item,
        )
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for r in rows {
        let mut row = r.map_err(|e| e.to_string())?;
        row.matched_tags = tag_names.clone();
        items.push(row);
    }

    // Parent pack/group rows of matched video/image files, same as search.
    let file_parent_keys: std::collections::HashSet<&str> = items
        .iter()
        .filter(|i| i.kind == "video" || i.kind == "image")
        .filter_map(|i| i.parent_path.as_deref())
        .collect();
    let parents = if file_parent_keys.is_empty() {
        Vec::new()
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ITEM_COLUMNS} FROM items
                 WHERE path_key IN (
                     SELECT DISTINCT parent_path FROM items
                     WHERE missing = 0 AND kind IN ('video', 'image')
                       AND id IN ({sub_sql})
                 )
                 ORDER BY name COLLATE NOCASE"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(tag_ids.iter()), row_to_item)
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            let row = r.map_err(|e| e.to_string())?;
            if file_parent_keys.contains(row.path_key.as_str()) {
                out.push(row);
            }
        }
        out
    };

    Ok(TagItemResults { items, parents })
}

#[tauri::command]
pub fn list_tags(app: AppHandle) -> Result<Vec<TagRow>, String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    list_tags_inner(&conn)
}

#[tauri::command]
pub fn get_item_tags(app: AppHandle, path_key: String) -> Result<Vec<TagRow>, String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_item_tags_inner(&conn, &path_key)
}

#[tauri::command]
pub fn set_item_tags(
    app: AppHandle,
    path_key: String,
    tags: Vec<String>,
) -> Result<Vec<TagRow>, String> {
    let db = app.state::<AppDb>();
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let out = set_item_tags_inner(&tx, &path_key, &tags)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
pub fn rename_tag(app: AppHandle, tag_id: i64, name: String) -> Result<(), String> {
    let db = app.state::<AppDb>();
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    rename_tag_inner(&tx, tag_id, &name)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_tag(app: AppHandle, tag_id: i64) -> Result<(), String> {
    let db = app.state::<AppDb>();
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    delete_tag_inner(&tx, tag_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_tag_items(
    app: AppHandle,
    tag_ids: Vec<i64>,
    limit: Option<i64>,
) -> Result<TagItemResults, String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_tag_items_inner(&conn, &tag_ids, limit)
}

#[tauri::command]
pub fn set_tag_kind(app: AppHandle, tag_id: i64, kind: String) -> Result<(), String> {
    let db = app.state::<AppDb>();
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    set_tag_kind_inner(&tx, tag_id, &kind)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_tag_samples(app: AppHandle, tag_ids: Vec<i64>) -> Result<Vec<TagSample>, String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_tag_samples_inner(&conn, &tag_ids)
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
        conn.execute_batch(include_str!("../migrations/004_tag_kind.sql"))
            .unwrap();
        conn
    }

    fn insert_item(
        conn: &Connection,
        id: &str,
        kind: &str,
        name: &str,
        path_key: &str,
        parent_path: Option<&str>,
    ) {
        let now = now_ms();
        conn.execute(
            "INSERT INTO items (id, kind, name, path_key, parent_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, kind, name, path_key, parent_path, now],
        )
        .unwrap();
    }

    #[test]
    fn set_and_get_item_tags_replace_and_dedupe() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "a.cbz", "p\\a.cbz", Some("p"));

        let tags = set_item_tags_inner(
            &conn,
            "p\\a.cbz",
            &[" 追番 ".to_string(), "日常".to_string(), "追番".to_string()],
        )
        .unwrap();
        assert_eq!(tags.len(), 2, "case/whitespace-identical names dedupe");

        let tags = get_item_tags_inner(&conn, "p\\a.cbz").unwrap();
        assert_eq!(tags.len(), 2);

        // Replace removes the old set entirely.
        set_item_tags_inner(&conn, "p\\a.cbz", &["完结".to_string()]).unwrap();
        let tags = get_item_tags_inner(&conn, "p\\a.cbz").unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "完结");
    }

    #[test]
    fn tags_share_vocabulary_case_insensitive() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "a.cbz", "p\\a.cbz", Some("p"));
        insert_item(&conn, "c2", "comic", "b.cbz", "p\\b.cbz", Some("p"));

        set_item_tags_inner(&conn, "p\\a.cbz", &["Action".to_string()]).unwrap();
        set_item_tags_inner(&conn, "p\\b.cbz", &["action".to_string()]).unwrap();

        let all = list_tags_inner(&conn).unwrap();
        assert_eq!(all.len(), 1, "same tag shared, not duplicated");
        assert_eq!(all[0].name, "Action");
        assert_eq!(all[0].count, 2);
    }

    #[test]
    fn set_item_tags_rejects_unknown_item() {
        let conn = open_db();
        let err = set_item_tags_inner(&conn, "ghost", &["x".to_string()]).unwrap_err();
        assert!(err.contains("不在库中"));
    }

    #[test]
    fn delete_tag_cascades_links() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "a.cbz", "p\\a.cbz", Some("p"));
        let tags = set_item_tags_inner(&conn, "p\\a.cbz", &["追番".to_string()]).unwrap();
        let tag_id = tags[0].id;

        delete_tag_inner(&conn, tag_id).unwrap();
        assert!(get_item_tags_inner(&conn, "p\\a.cbz").unwrap().is_empty());
        assert!(list_tags_inner(&conn).unwrap().is_empty());
    }

    #[test]
    fn item_delete_cascades_links() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "a.cbz", "p\\a.cbz", Some("p"));
        set_item_tags_inner(&conn, "p\\a.cbz", &["追番".to_string()]).unwrap();

        conn.execute("DELETE FROM items WHERE id = 'c1'", []).unwrap();
        // 标签是共享词表：条目删除只清链接，标签本身保留、计数归零
        assert!(get_item_tags_inner(&conn, "p\\a.cbz").unwrap().is_empty());
        let all = list_tags_inner(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "追番");
        assert_eq!(all[0].count, 0);
    }

    #[test]
    fn rename_tag_conflict_and_ok() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "a.cbz", "p\\a.cbz", Some("p"));
        let tags = set_item_tags_inner(
            &conn,
            "p\\a.cbz",
            &["旧名".to_string(), "占用".to_string()],
        )
        .unwrap();
        let old_id = tags.iter().find(|t| t.name == "旧名").unwrap().id;
        let taken_id = tags.iter().find(|t| t.name == "占用").unwrap().id;

        let err = rename_tag_inner(&conn, old_id, "占用").unwrap_err();
        assert!(err.contains("同名"));

        rename_tag_inner(&conn, old_id, "新名").unwrap();
        let names: Vec<String> = get_item_tags_inner(&conn, "p\\a.cbz")
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(names.contains(&"新名".to_string()));
        assert!(!names.contains(&"旧名".to_string()));
        // 只改这一个标签：另一个不受影响
        let _ = taken_id;
    }

    #[test]
    fn get_tag_items_lists_and_groups_files_under_parents() {
        let conn = open_db();
        insert_item(&conn, "p1", "pack", "Anime 2024", "p\\Anime 2024", Some("p"));
        insert_item(
            &conn,
            "v1",
            "video",
            "EP 01.mkv",
            "p\\Anime 2024\\EP 01.mkv",
            Some("p\\Anime 2024"),
        );
        insert_item(&conn, "c1", "comic", "One Piece 100.cbz", "p\\One Piece 100.cbz", Some("p"));

        // 给 pack 和单集分别打不同标签
        let pack_tags = set_item_tags_inner(&conn, "p\\Anime 2024", &["追番".to_string()]).unwrap();
        set_item_tags_inner(&conn, "p\\Anime 2024\\EP 01.mkv", &["完结".to_string()]).unwrap();

        let res = get_tag_items_inner(&conn, &[pack_tags[0].id], None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].kind, "pack");
        assert_eq!(res.items[0].matched_tags, vec!["追番".to_string()]);

        // 单集标签：返回文件 + 父目录
        let done = list_tags_inner(&conn).unwrap();
        let done_id = done.iter().find(|t| t.name == "完结").unwrap().id;
        let res = get_tag_items_inner(&conn, &[done_id], None).unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].kind, "video");
        assert_eq!(res.parents.len(), 1);
        assert_eq!(res.parents[0].path_key, "p\\Anime 2024");
    }

    #[test]
    fn get_tag_items_intersection_requires_all_selected() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "a.cbz", "p\\a.cbz", Some("p"));
        insert_item(&conn, "c2", "comic", "b.cbz", "p\\b.cbz", Some("p"));
        insert_item(&conn, "c3", "comic", "c.cbz", "p\\c.cbz", Some("p"));

        let tags_a = set_item_tags_inner(&conn, "p\\a.cbz", &["追番".to_string(), "完结".to_string()]).unwrap();
        let tags_b = set_item_tags_inner(&conn, "p\\b.cbz", &["追番".to_string()]).unwrap();
        let _tags_c = set_item_tags_inner(&conn, "p\\c.cbz", &["日常".to_string()]).unwrap();
        let zhui = tags_a.iter().find(|t| t.name == "追番").unwrap().id;
        let wan = tags_a.iter().find(|t| t.name == "完结").unwrap().id;
        let _b_zhui = tags_b[0].id;

        // 单选：拥有该标签的全部条目
        let res = get_tag_items_inner(&conn, &[zhui], None).unwrap();
        let ids: Vec<&str> = res.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "c2"]);

        // 多选交集：必须同时拥有两个标签 → 只有 c1
        let res = get_tag_items_inner(&conn, &[zhui, wan], None).unwrap();
        let ids: Vec<&str> = res.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["c1"]);
        assert_eq!(res.items[0].matched_tags, vec!["完结".to_string(), "追番".to_string()]);

        // 空选择：直接空结果
        let res = get_tag_items_inner(&conn, &[], None).unwrap();
        assert!(res.items.is_empty());
    }

    #[test]
    fn tag_kind_set_and_list_roundtrip() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "a.cbz", "p\\a.cbz", Some("p"));
        let tags = set_item_tags_inner(&conn, "p\\a.cbz", &["作者X".to_string()]).unwrap();
        let id = tags[0].id;
        assert_eq!(tags[0].kind, "", "新标签默认未分类");

        set_tag_kind_inner(&conn, id, "author").unwrap();
        let all = list_tags_inner(&conn).unwrap();
        assert_eq!(all[0].kind, "author");

        // 非法值 → 清空为未分类
        set_tag_kind_inner(&conn, id, "what?").unwrap();
        let all = list_tags_inner(&conn).unwrap();
        assert_eq!(all[0].kind, "", "非法 kind 归一为未分类");
    }

    #[test]
    fn tag_samples_return_names_per_tag() {
        let conn = open_db();
        insert_item(&conn, "c1", "comic", "角色A登场.cbz", "p\\a.cbz", Some("p"));
        insert_item(&conn, "c2", "comic", "角色A再临.cbz", "p\\b.cbz", Some("p"));
        insert_item(&conn, "v1", "video", "ep01.mkv", "p\\v\\ep01.mkv", Some("p\\v"));

        let t1 = set_item_tags_inner(&conn, "p\\a.cbz", &["角色A".to_string()]).unwrap()[0].id;
        set_item_tags_inner(&conn, "p\\b.cbz", &["角色A".to_string()]).unwrap();
        set_item_tags_inner(&conn, "p\\v\\ep01.mkv", &["角色A".to_string()]).unwrap();

        let samples = get_tag_samples_inner(&conn, &[t1]).unwrap();
        assert_eq!(samples.len(), 1);
        // 样本只取漫画条目
        assert_eq!(samples[0].names.len(), 2);
        assert!(samples[0].names.iter().all(|n| n.ends_with(".cbz")));
    }
}
