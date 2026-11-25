use crate::{
    db,
    error::{ApiError, Result, string},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
pub fn register_device(db: &Connection, uid: &str, input: &Value) -> Result<String> {
    let device = input["device_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown-device");
    let name = input["device_name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("My Device");
    let platform = input["platform"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("web");
    let tx = db::transaction(db)?;
    tx.execute("INSERT INTO user_secrets(user_id,device_secret) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING",params![uid,hex::encode(db::random(32))])?;
    let secret = tx.query_row(
        "SELECT device_secret FROM user_secrets WHERE user_id=?",
        [uid],
        |r| r.get(0),
    )?;
    tx.execute("INSERT INTO user_devices(device_id,user_id,device_name,platform,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET device_name=excluded.device_name,platform=excluded.platform,updated_at=excluded.updated_at",params![device,uid,name,platform,db::now()])?;
    tx.commit()?;
    Ok(secret)
}
pub fn changes(db: &Connection, uid: &str, since: i64, limit: i64) -> Result<Value> {
    let tx = db.unchecked_transaction()?;
    let latest: i64 = tx.query_row(
        "SELECT coalesce(max(seq),0) FROM server_changelog WHERE user_id=?",
        [uid],
        |r| r.get(0),
    )?;
    let limit = limit.clamp(1, 500) as usize;
    let mut items:Vec<Value>=tx.prepare("SELECT c.seq,c.note_id,c.file_path,c.content_hash,c.device_id,c.device_name,c.is_deleted,c.updated_at,n.content FROM server_changelog c LEFT JOIN server_notes n ON n.user_id=c.user_id AND n.note_id=c.note_id WHERE c.user_id=? AND c.seq>? ORDER BY c.seq ASC LIMIT ?")?.query_map(params![uid,since,(limit+1) as i64],|r|{
        let deleted=r.get::<_,i64>(6)?;
        let mut value=json!({"server_seq":r.get::<_,i64>(0)?,"note_id":r.get::<_,String>(1)?,"file_path":r.get::<_,String>(2)?,"content_hash":r.get::<_,String>(3)?,"device_id":r.get::<_,String>(4)?,"device_name":r.get::<_,String>(5)?,"is_deleted":deleted,"updated_at":r.get::<_,i64>(7)?});
        if deleted==0&& let Some(content)=r.get::<_,Option<String>>(8)? {value["content"]=json!(content);}
        Ok(value)
    })?.collect::<rusqlite::Result<_>>()?;
    let more = items.len() > limit;
    items.truncate(limit);
    tx.commit()?;
    Ok(json!({"items":items,"latest_seq":latest,"has_more":more}))
}
pub fn check_assets(db: &Connection, uid: &str, input: &Value) -> Result<Value> {
    let mut missing = Vec::new();
    let mut urls = serde_json::Map::new();
    if let Some(hashes) = input["hashes"].as_array() {
        for h in hashes {
            let h = h
                .as_str()
                .ok_or_else(|| ApiError::new(400, "资产标识无效"))?;
            if db
                .query_row(
                    "SELECT 1 FROM server_assets WHERE user_id=? AND asset_hash=?",
                    params![uid, h],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .is_none()
            {
                missing.push(h);
                urls.insert(
                    h.into(),
                    json!(format!(
                        "/api/v1/assets/upload?hash={}",
                        url::form_urlencoded::byte_serialize(h.as_bytes()).collect::<String>()
                    )),
                );
            }
        }
    }
    Ok(json!({"missing_hashes":missing,"upload_urls":urls}))
}
pub fn save_asset(db: &Connection, uid: &str, hash: &str, bytes: &[u8]) -> Result<Value> {
    if db::digest(bytes) != hash {
        return Err(ApiError::new(400, "资产内容校验失败"));
    }
    db.execute("INSERT INTO server_assets(asset_hash,user_id,byte_size,content,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,asset_hash) DO NOTHING",params![hash,uid,bytes.len() as i64,bytes,db::now()])?;
    Ok(json!({"ok":true,"hash":hash}))
}
pub fn asset(db: &Connection, uid: &str, hash: &str) -> Result<Vec<u8>> {
    db.query_row(
        "SELECT content FROM server_assets WHERE user_id=? AND asset_hash=?",
        params![uid, hash],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| ApiError::new(404, "资产不存在"))
}
pub fn push(db: &Connection, uid: &str, input: &Value) -> Result<Value> {
    let device = string(input, "device_id")?;
    if device.is_empty() {
        return Err(ApiError::new(400, "请求数据格式不正确"));
    }
    let notes = input["notes"]
        .as_array()
        .ok_or_else(|| ApiError::new(400, "请求数据格式不正确"))?;
    let tx = db::transaction(db)?;
    let name: String = tx
        .query_row(
            "SELECT device_name FROM user_devices WHERE user_id=? AND device_id=?",
            params![uid, device],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_else(|| device.into());
    let mut results = Vec::new();
    for note in notes {
        let id = string(note, "note_id")?;
        let path = string(note, "file_path")?;
        let deleted = note["is_deleted"].as_i64().unwrap_or(0) != 0;
        let content = if deleted {
            note["content"].as_str().unwrap_or("")
        } else {
            string(note, "content")?
        };
        let hash = if deleted {
            String::new()
        } else {
            db::digest(content)
        };
        let time = note["updated_at"]
            .as_i64()
            .filter(|n| *n != 0)
            .unwrap_or_else(db::now);
        tx.execute("INSERT INTO server_changelog(user_id,note_id,file_path,content_hash,device_id,device_name,is_deleted,updated_at) VALUES(?,?,?,?,?,?,?,?)",params![uid,id,path,hash,device,name,deleted,time])?;
        let seq = tx.last_insert_rowid();
        tx.execute("INSERT INTO server_notes(note_id,user_id,file_path,content_hash,content,is_deleted,server_seq,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,note_id) DO UPDATE SET file_path=excluded.file_path,content_hash=excluded.content_hash,content=excluded.content,is_deleted=excluded.is_deleted,server_seq=excluded.server_seq,updated_at=excluded.updated_at",params![id,uid,path,hash,content,deleted,seq,time])?;
        results.push(json!({"note_id":id,"server_seq":seq}));
    }
    tx.commit()?;
    Ok(json!({"results":results}))
}
