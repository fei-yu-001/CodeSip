use crate::{
    db,
    error::{ApiError, Result, js_len, safe_int, version},
    files,
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value, json};
fn conflict() -> ApiError {
    ApiError::new(409, "批注已在其他设备更新或删除，请刷新后确认")
}
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(ApiError::new(400, "批注标识无效"));
    }
    Ok(())
}
fn annotation_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"path":r.get::<_,String>(1)?,"line":r.get::<_,i64>(2)?,"snippet":r.get::<_,String>(3)?,"note":r.get::<_,String>(4)?,"createdAt":r.get::<_,i64>(5)?,"updatedAt":r.get::<_,i64>(6)?}),
    )
}
const ANN_SELECT: &str =
    "SELECT id,path,line,snippet,note,created_at,updated_at,deleted FROM reader_annotations";
pub fn annotations(db: &Connection, uid: &str, lib: &str, path: &str) -> Result<Value> {
    db::library(db, uid, lib)?;
    let path = files::clean_path(path)?;
    let list: Vec<Value> = db
        .prepare(&format!(
            "{ANN_SELECT} WHERE library_id=? AND path=? AND deleted=0 ORDER BY line,created_at,id"
        ))?
        .query_map(params![lib, path], annotation_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(json!({"annotations":list}))
}
pub fn put_annotation(
    db: &Connection,
    uid: &str,
    lib: &str,
    id: &str,
    input: &Value,
) -> Result<Value> {
    db::library(db, uid, lib)?;
    validate_id(id)?;
    let path = files::clean_path(input["path"].as_str().unwrap_or(""))?;
    let invalid = || {
        ApiError::new(
            400,
            "批注内容为 1–10000 字，引用不超过 2000 字，行号须为有效正整数",
        )
    };
    let line = safe_int(&input["line"])
        .filter(|n| (1..=2000000).contains(n))
        .ok_or_else(invalid)?;
    let snippet = input["snippet"]
        .as_str()
        .filter(|s| js_len(s) <= 2000)
        .ok_or_else(invalid)?;
    let note = input["note"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && js_len(s) <= 10000)
        .ok_or_else(invalid)?
        .trim();
    let expected = version(input.get("expectedUpdatedAt"), "请提供批注的上次保存版本")?;
    let tx = db::transaction(db)?;
    let old = tx
        .query_row(
            &format!("{ANN_SELECT} WHERE library_id=? AND id=?"),
            params![lib, id],
            |r| Ok((annotation_row(r)?, r.get::<_, bool>(7)?)),
        )
        .optional()?;
    if let Some((ref previous, deleted)) = old {
        if deleted || previous["path"] != path {
            return Err(conflict());
        }
        if previous["line"] == line && previous["note"] == note && previous["snippet"] == snippet {
            tx.commit()?;
            return Ok(json!({"annotation":previous}));
        }
        if expected != previous["updatedAt"].as_i64() {
            return Err(conflict());
        }
    } else {
        if expected.is_some() {
            return Err(conflict());
        }
        if !db::file(&tx, uid, lib, &path)?.is_text {
            return Err(ApiError::new(400, "当前文件不支持文字批注"));
        }
        let file_count: i64 = tx.query_row(
            "SELECT count(*) FROM reader_annotations WHERE library_id=? AND path=? AND deleted=0",
            params![lib, path],
            |r| r.get(0),
        )?;
        let account_count:i64=tx.query_row("SELECT count(*) FROM reader_annotations a JOIN libraries l ON l.id=a.library_id WHERE l.user_id=?",[uid],|r|r.get(0))?;
        if file_count >= 500 || account_count >= 5000 {
            return Err(ApiError::new(413, "批注数量已达上限，暂时无法新增"));
        }
    }
    let timestamp = db::now().max(
        old.as_ref()
            .and_then(|(p, _)| p["updatedAt"].as_i64())
            .unwrap_or(0)
            + 1,
    );
    let created = old
        .as_ref()
        .and_then(|(p, _)| p["createdAt"].as_i64())
        .unwrap_or(timestamp);
    tx.execute("INSERT INTO reader_annotations(library_id,id,path,line,snippet,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(library_id,id) DO UPDATE SET line=excluded.line,snippet=excluded.snippet,note=excluded.note,updated_at=excluded.updated_at",params![lib,id,path,line,snippet,note,created,timestamp])?;
    tx.commit()?;
    Ok(
        json!({"annotation":{"id":id,"path":path,"line":line,"snippet":snippet,"note":note,"createdAt":created,"updatedAt":timestamp}}),
    )
}
pub fn delete_annotation(
    db: &Connection,
    uid: &str,
    lib: &str,
    id: &str,
    input: &Value,
) -> Result<Value> {
    db::library(db, uid, lib)?;
    validate_id(id)?;
    let expected = version(input.get("expectedUpdatedAt"), "请提供批注的上次保存版本")?
        .ok_or_else(|| ApiError::new(400, "请提供批注的上次保存版本"))?;
    let tx = db::transaction(db)?;
    let previous: Option<(i64, bool)> = tx
        .query_row(
            "SELECT updated_at,deleted FROM reader_annotations WHERE library_id=? AND id=?",
            params![lib, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((updated, false)) = previous {
        if updated != expected {
            return Err(conflict());
        }
        tx.execute("UPDATE reader_annotations SET deleted=1,note='',snippet='',updated_at=? WHERE library_id=? AND id=?",params![db::now().max(updated+1),lib,id])?;
    }
    tx.commit()?;
    Ok(json!({"ok":true}))
}
pub fn get_copy(db: &Connection, uid: &str, lib: &str, path: &str) -> Result<Value> {
    db::library(db, uid, lib)?;
    let path = files::clean_path(path)?;
    Ok(db.query_row("SELECT path,content,base_hash,updated_at FROM reader_document_copies WHERE library_id=? AND path=?",params![lib,path],|r|Ok(json!({"path":r.get::<_,String>(0)?,"content":r.get::<_,String>(1)?,"baseHash":r.get::<_,String>(2)?,"updatedAt":r.get::<_,i64>(3)?}))).optional()?.unwrap_or(Value::Null))
}
pub fn put_copy(db: &Connection, uid: &str, lib: &str, input: &Value) -> Result<Value> {
    let tx = db::transaction(db)?;
    let db = &*tx;
    let library = db::library(db, uid, lib)?;
    let path = files::clean_path(input["path"].as_str().unwrap_or(""))?;
    let lower = path.to_lowercase();
    if library["kind"] != "notes" || !(lower.ends_with(".md") || lower.ends_with(".mdown")) {
        return Err(ApiError::new(400, "仅支持编辑 Markdown 笔记的阅读版本"));
    }
    if !db::file(db, uid, lib, &path)?.is_text {
        return Err(ApiError::new(400, "这份文件不支持编辑"));
    }
    let content = input["content"]
        .as_str()
        .filter(|s| js_len(s) <= 500000 && s.len() <= 2 * 1024 * 1024)
        .ok_or_else(|| ApiError::new(400, "文档编辑内容过长，最多 50 万字且不超过 2 MB"))?;
    let base = input["baseHash"]
        .as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        .ok_or_else(|| ApiError::new(400, "原文版本无效"))?;
    let expected = version(input.get("expectedUpdatedAt"), "请提供上次保存的文档版本")?;
    let old = get_copy(&tx, uid, lib, &path)?;
    if old["content"] == content && old["baseHash"] == base {
        tx.commit()?;
        return Ok(json!({"copy":old}));
    }
    if old["updatedAt"].as_i64() != expected {
        return Err(ApiError::new(
            409,
            "文档已在其他设备修改，请选择要保留的版本",
        ));
    }
    let used:i64=tx.query_row("SELECT coalesce(sum(length(CAST(c.content AS BLOB))),0) FROM reader_document_copies c JOIN libraries l ON l.id=c.library_id WHERE l.user_id=?",[uid],|r|r.get(0))?;
    if used - old["content"].as_str().unwrap_or("").len() as i64 + content.len() as i64
        > 32 * 1024 * 1024
    {
        return Err(ApiError::new(413, "已保存的编辑版本超过账号空间限制"));
    }
    let updated = db::now().max(old["updatedAt"].as_i64().unwrap_or(0) + 1);
    tx.execute("INSERT INTO reader_document_copies(library_id,path,content,base_hash,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(library_id,path) DO UPDATE SET content=excluded.content,base_hash=excluded.base_hash,updated_at=excluded.updated_at",params![lib,path,content,base,updated])?;
    tx.commit()?;
    Ok(json!({"copy":{"path":path,"content":content,"baseHash":base,"updatedAt":updated}}))
}
