use crate::{
    error::{ApiError, Result, js_len, js_slice, safe_int, string},
    files::{self, ImportedFile, MAX_FILE, MAX_FILES, MAX_LIBRARY},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ops::{Deref, DerefMut},
    path::Path,
    sync::{Condvar, Mutex},
};
use subtle::ConstantTimeEq;

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}
pub fn random(size: usize) -> Vec<u8> {
    let mut b = vec![0; size];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}
pub fn transaction(db: &Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        db,
        TransactionBehavior::Immediate,
    )?)
}

// Connections are owned by blocking workers only. The HTTP runtime never waits
// on SQLite or executes scrypt, ZIP inflation, JSON serialization or gzip.
pub struct Pool {
    connections: Mutex<Vec<Connection>>,
    ready: Condvar,
}
pub struct Lease<'a> {
    pool: &'a Pool,
    connection: Option<Connection>,
}
impl Deref for Lease<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.connection.as_ref().unwrap()
    }
}
impl DerefMut for Lease<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.connection.as_mut().unwrap()
    }
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Some(c) = self.connection.take() {
            let mut all = self
                .pool
                .connections
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            all.push(c);
            self.pool.ready.notify_one();
        }
    }
}
impl Pool {
    pub fn open(filename: &str) -> Result<Self> {
        if filename != ":memory:"
            && let Some(parent) = Path::new(filename)
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(filename)?;
        initialize(&db)?;
        let mut connections = vec![db];
        if filename != ":memory:" {
            for _ in 1..4 {
                let c = Connection::open(filename)?;
                c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
                connections.push(c);
            }
        }
        Ok(Self {
            connections: Mutex::new(connections),
            ready: Condvar::new(),
        })
    }
    pub fn get(&self) -> Lease<'_> {
        let mut all = self.connections.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if let Some(c) = all.pop() {
                return Lease {
                    pool: self,
                    connection: Some(c),
                };
            }
            all = self.ready.wait(all).unwrap_or_else(|p| p.into_inner());
        }
    }
}
pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(include_str!("schema.sql"))?;
    let tx = transaction(db)?;
    for (name, def) in [
        ("user_devices", include_str!("user_devices.sql")),
        ("server_notes", include_str!("server_notes.sql")),
        ("server_assets", include_str!("server_assets.sql")),
    ] {
        tx.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {name} ({def})"))?;
        let columns: Vec<(String, i64)> = tx
            .prepare(&format!("PRAGMA table_info({name})"))?
            .query_map([], |r| Ok((r.get(1)?, r.get(5)?)))?
            .collect::<rusqlite::Result<_>>()?;
        if columns.iter().any(|(c, pk)| c == "user_id" && *pk > 0) {
            continue;
        }
        let fields = columns
            .iter()
            .map(|(c, _)| format!("\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(",");
        tx.execute_batch(&format!("CREATE TABLE {name}_account_migration ({def}); INSERT INTO {name}_account_migration ({fields}) SELECT {fields} FROM {name}; DROP TABLE {name}; ALTER TABLE {name}_account_migration RENAME TO {name};"))?;
    }
    tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_server_notes_user ON server_notes(user_id)")?;
    tx.commit()?;
    Ok(())
}
pub fn needs_setup(db: &Connection) -> Result<bool> {
    Ok(db.query_row("SELECT count(*) FROM users", [], |r| r.get::<_, i64>(0))? == 0)
}
pub fn hash_password(password: &str, salt: &str) -> Result<Vec<u8>> {
    let mut key = vec![0; 64];
    // Node crypto.scrypt defaults: N=16384, r=8, p=1, salt is the UTF-8 hex string.
    let params = scrypt::Params::new(14, 8, 1).map_err(ApiError::internal)?;
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut key)
        .map_err(ApiError::internal)?;
    Ok(key)
}
pub fn create_user(db: &Connection, input: &Value) -> Result<Value> {
    let username = input["username"].as_str().unwrap_or("");
    let password = input["password"].as_str().unwrap_or("");
    if !(3..=64).contains(&username.len())
        || !username
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.@-".contains(&c))
        || !(10..=256).contains(&js_len(password))
    {
        return Err(ApiError::new(
            400,
            "账号为 3–64 位字母、数字或邮箱，密码至少 10 位",
        ));
    }
    let salt = hex::encode(random(16));
    let key = hash_password(password, &salt)?;
    let tx = transaction(db)?;
    if !needs_setup(&tx)? {
        return Err(ApiError::new(409, "账号已经建立，请登录"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let username = username.to_lowercase();
    tx.execute(
        "INSERT INTO users VALUES(?,?,?)",
        params![id, username, format!("{salt}:{}", hex::encode(key))],
    )?;
    tx.commit()?;
    Ok(json!({"id":id,"username":username}))
}
pub fn login(db: &Connection, input: &Value) -> Result<Value> {
    let fail = || ApiError::new(401, "账号或密码不正确");
    let username = input["username"].as_str().ok_or_else(fail)?;
    let password = input["password"]
        .as_str()
        .filter(|s| js_len(s) <= 256)
        .ok_or_else(fail)?;
    let row = db
        .query_row(
            "SELECT id,username,password FROM users WHERE username=?",
            [username.to_lowercase()],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let fallback = format!("no-such-account:{}", "0".repeat(128));
    let stored = row.as_ref().map(|r| r.2.as_str()).unwrap_or(&fallback);
    let (salt, hex) = stored.split_once(':').ok_or_else(fail)?;
    let key = hash_password(password, salt)?;
    let expected = hex::decode(hex).map_err(|_| fail())?;
    if !bool::from(key.ct_eq(&expected)) {
        return Err(fail());
    }
    let (id, username, _) = row.ok_or_else(fail)?;
    Ok(json!({"id":id,"username":username}))
}
pub fn session(db: &Connection, user_id: &str) -> Result<String> {
    db.execute("DELETE FROM sessions WHERE expires < ?", [now()])?;
    let token = URL_SAFE_NO_PAD.encode(random(32));
    db.execute(
        "INSERT INTO sessions VALUES(?,?,?)",
        params![digest(&token), user_id, now() + 30 * 86400000],
    )?;
    Ok(token)
}
pub struct Identity {
    pub user: Value,
    pub library_id: Option<String>,
}
pub fn authenticate(db: &Connection, token: &str) -> Result<Identity> {
    let hash = digest(token);
    let user=db.query_row("SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE hash=? AND expires>?",params![hash,now()],|r|Ok(json!({"id":r.get::<_,String>(0)?,"username":r.get::<_,String>(1)?}))).optional()?;
    if let Some(user) = user {
        return Ok(Identity {
            user,
            library_id: None,
        });
    }
    let identity=db.query_row("SELECT u.id,u.username,t.library_id FROM tokens t JOIN users u ON u.id=t.user_id WHERE hash=?",[hash],|r|Ok(Identity{user:json!({"id":r.get::<_,String>(0)?,"username":r.get::<_,String>(1)?}),library_id:Some(r.get(2)?)})).optional()?;
    identity.ok_or_else(|| ApiError::new(401, "请登录 CodeSip"))
}
fn library_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"revision":r.get::<_,i64>(3)?,"updatedAt":r.get::<_,String>(4)?,"fileCount":r.get::<_,i64>(5)?,"totalBytes":r.get::<_,i64>(6)?}),
    )
}
const LIB_SELECT: &str = "SELECT l.id,l.name,l.kind,l.revision,l.updated_at,count(f.path),coalesce(sum(f.size),0) FROM libraries l LEFT JOIN files f ON f.library_id=l.id";
pub fn libraries(db: &Connection, uid: &str) -> Result<Vec<Value>> {
    Ok(db
        .prepare(&format!(
            "{LIB_SELECT} WHERE l.user_id=? GROUP BY l.id ORDER BY l.updated_at DESC"
        ))?
        .query_map([uid], library_row)?
        .collect::<rusqlite::Result<_>>()?)
}
pub fn library(db: &Connection, uid: &str, id: &str) -> Result<Value> {
    db.query_row(
        &format!("{LIB_SELECT} WHERE l.user_id=? AND l.id=? GROUP BY l.id"),
        params![uid, id],
        library_row,
    )
    .optional()?
    .ok_or_else(|| ApiError::new(404, "找不到这个项目"))
}
pub fn create_library(db: &Connection, uid: &str, input: &Value) -> Result<Value> {
    let name = input["name"].as_str().unwrap_or("");
    let kind = input["kind"].as_str().unwrap_or("");
    if name.trim().is_empty() || js_len(name) > 100 || !["code", "notes"].contains(&kind) {
        return Err(ApiError::new(400, "请填写项目名称并选择类型"));
    }
    if db.query_row(
        "SELECT count(*) FROM libraries WHERE user_id=?",
        [uid],
        |r| r.get::<_, i64>(0),
    )? >= 60
    {
        return Err(ApiError::new(413, "最多保存 60 个项目或笔记库"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO libraries VALUES(?,?,?,?,0,?)",
        params![id, uid, name.trim(), kind, iso_now()],
    )?;
    library(db, uid, &id)
}
pub fn manifest(db: &Connection, uid: &str, id: &str) -> Result<Value> {
    let tx = db.unchecked_transaction()?;
    let result = manifest_inner(&tx, uid, id)?;
    tx.commit()?;
    Ok(result)
}
fn manifest_inner(db: &Connection, uid: &str, id: &str) -> Result<Value> {
    let lib = library(db, uid, id)?;
    let files:Vec<Value>=db.prepare("SELECT path,hash,size,is_text,media_type FROM files WHERE library_id=? ORDER BY path")?.query_map([id],|r|Ok(json!({"path":r.get::<_,String>(0)?,"hash":r.get::<_,String>(1)?,"size":r.get::<_,i64>(2)?,"isText":r.get::<_,bool>(3)?,"mediaType":r.get::<_,String>(4)?})))?.collect::<rusqlite::Result<_>>()?;
    Ok(json!({"library":lib,"files":files}))
}
pub struct File {
    pub bytes: Vec<u8>,
    pub is_text: bool,
    pub media: String,
}
pub fn file(db: &Connection, uid: &str, id: &str, path: &str) -> Result<File> {
    library(db, uid, id)?;
    db.query_row(
        "SELECT content,is_text,media_type FROM files WHERE library_id=? AND path=?",
        params![id, files::clean_path(path)?],
        |r| {
            Ok(File {
                bytes: r.get(0)?,
                is_text: r.get(1)?,
                media: r.get(2)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| ApiError::new(404, "文件不存在或尚未同步"))
}
pub fn put_inner(
    db: &Connection,
    id: &str,
    files: &[ImportedFile],
    deleted: &[String],
    expected: i64,
) -> Result<Value> {
    let rev: Option<i64> = db
        .query_row("SELECT revision FROM libraries WHERE id=?", [id], |r| {
            r.get(0)
        })
        .optional()?;
    if rev != Some(expected) {
        return Err(ApiError::new(409, "内容已更新，请重新获取清单后重试"));
    }
    let mut seen = std::collections::HashSet::new();
    for f in files {
        let path = files::clean_path(&f.path)?;
        if files::excluded(&path) {
            return Err(ApiError::new(400, "此路径不参与同步"));
        }
        if !seen.insert(path) {
            return Err(ApiError::new(400, "存在重复文件"));
        }
        if f.bytes.len() > MAX_FILE {
            return Err(ApiError::new(413, "单个文件不得超过 8 MB"));
        }
    }
    let deleted = deleted
        .iter()
        .map(|p| files::clean_path(p))
        .collect::<Result<Vec<_>>>()?;
    if deleted.iter().any(|p| seen.contains(p)) {
        return Err(ApiError::new(400, "同一个文件不能同时写入和删除"));
    }
    for f in files {
        let (text, media) = files::classify(&f.path, &f.bytes);
        db.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?) ON CONFLICT(library_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,is_text=excluded.is_text,media_type=excluded.media_type,content=excluded.content",params![id,files::clean_path(&f.path)?,digest(&f.bytes),f.bytes.len() as i64,text,media,f.bytes])?;
    }
    for path in deleted {
        db.execute(
            "DELETE FROM files WHERE library_id=? AND path=?",
            params![id, path],
        )?;
    }
    let (count, size) = db.query_row(
        "SELECT count(*),coalesce(sum(size),0) FROM files WHERE library_id=?",
        [id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;
    if count > MAX_FILES as i64 || size > MAX_LIBRARY as i64 {
        return Err(ApiError::new(413, "项目最多 4000 个文件，合计 64 MB"));
    }
    let account:i64=db.query_row("SELECT coalesce(sum(f.size),0) FROM files f JOIN libraries l ON f.library_id=l.id WHERE l.user_id=(SELECT user_id FROM libraries WHERE id=?)",[id],|r|r.get(0))?;
    if account > 512 * 1024 * 1024 {
        return Err(ApiError::new(
            413,
            "账号存储已达 512 MB，请删除不再需要的副本",
        ));
    }
    db.execute(
        "UPDATE libraries SET revision=revision+1,updated_at=? WHERE id=?",
        params![iso_now(), id],
    )?;
    Ok(json!({"revision":expected+1}))
}
pub fn remove_file(db: &Connection, uid: &str, id: &str, input: &Value) -> Result<Value> {
    let revision = safe_int(&input["baseRevision"])
        .filter(|value| *value >= 0)
        .ok_or_else(|| ApiError::new(400, "文件删除请求格式无效"))?;
    let path = files::clean_path(string(input, "path")?)?;
    let tx = transaction(db)?;
    library(&tx, uid, id)?;
    // Check the displayed version before deleting either notes or imported code.
    // Reader annotations and personal copies remain recoverable on reimport.
    file(&tx, uid, id, &path)?;
    put_inner(&tx, id, &[], &[path], revision)?;
    let result = manifest_inner(&tx, uid, id)?;
    tx.commit()?;
    Ok(result)
}
pub fn sync(db: &Connection, uid: &str, id: &str, patch: &Value) -> Result<Value> {
    let lib = library(db, uid, id)?;
    if lib["kind"] != "notes" {
        return Err(ApiError::new(403, "同步令牌仅用于笔记库"));
    }
    let bad = || ApiError::new(400, "同步请求格式无效");
    let revision = safe_int(&patch["baseRevision"]).ok_or_else(bad)?;
    let upserts = patch["upserts"]
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(bad)?;
    let deleted = patch["deleted"]
        .as_array()
        .filter(|a| a.len() <= MAX_FILES)
        .ok_or_else(bad)?
        .iter()
        .map(|v| v.as_str().ok_or_else(bad).and_then(files::clean_path))
        .collect::<Result<Vec<_>>>()?;
    let mut files = Vec::new();
    for item in upserts {
        let content = item["content"]
            .as_str()
            .filter(|s| s.len() <= MAX_FILE.div_ceil(3) * 4)
            .ok_or_else(|| ApiError::new(400, "文件内容编码无效"))?;
        let bytes = STANDARD
            .decode(content)
            .map_err(|_| ApiError::new(400, "文件内容编码无效"))?;
        if STANDARD.encode(&bytes) != content {
            return Err(ApiError::new(400, "文件内容编码无效"));
        }
        files.push(ImportedFile {
            path: files::clean_path(string(item, "path")?)?,
            bytes,
        });
    }
    let tx = transaction(db)?;
    let result = put_inner(&tx, id, &files, &deleted, revision)?;
    tx.commit()?;
    Ok(result)
}
pub fn issue_token(db: &Connection, uid: &str, id: &str) -> Result<String> {
    if library(db, uid, id)?["kind"] != "notes" {
        return Err(ApiError::new(400, "请选择笔记库"));
    }
    let token = format!("csp_{}", URL_SAFE_NO_PAD.encode(random(32)));
    let tx = transaction(db)?;
    tx.execute("DELETE FROM tokens WHERE library_id=?", [id])?;
    tx.execute(
        "INSERT INTO tokens VALUES(?,?,?,?,?)",
        params![
            uuid::Uuid::new_v4().to_string(),
            digest(&token),
            uid,
            id,
            iso_now()
        ],
    )?;
    tx.commit()?;
    Ok(token)
}
pub fn search(db: &Connection, uid: &str, id: &str, query: &str) -> Result<Value> {
    library(db, uid, id)?;
    let q = query.trim().to_lowercase();
    if !(1..=200).contains(&js_len(&q)) {
        return Err(ApiError::new(400, "搜索词需要 1–200 个字符"));
    }
    let rows:Vec<(String,Vec<u8>)>=db.prepare("SELECT path,content FROM files WHERE library_id=? AND is_text=1 AND (instr(lower(path),?)>0 OR instr(lower(CAST(content AS TEXT)),?)>0) LIMIT 60")?.query_map(params![id,q,q],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let results: Vec<Value> = rows
        .into_iter()
        .map(|(path, bytes)| {
            let text = String::from_utf8_lossy(&bytes);
            let line = text
                .split('\n')
                .enumerate()
                .find(|(_, s)| s.to_lowercase().contains(&q));
            let (n, snippet) = line
                .map(|(n, s)| (n + 1, js_slice(s.trim(), 220)))
                .unwrap_or((1, path.clone()));
            json!({"path":path,"line":n,"snippet":snippet})
        })
        .collect();
    Ok(json!({"results":results}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_migration_rolls_back_every_account_table() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("schema.sql")).unwrap();
        db.execute("INSERT INTO users VALUES('owner','synthetic','unused')", [])
            .unwrap();
        for (name, key, definition) in [
            (
                "user_devices",
                "device_id",
                include_str!("user_devices.sql"),
            ),
            ("server_notes", "note_id", include_str!("server_notes.sql")),
            (
                "server_assets",
                "asset_hash",
                include_str!("server_assets.sql"),
            ),
        ] {
            let definition = definition.replace(
                &format!("{key} TEXT NOT NULL"),
                &format!("{key} TEXT PRIMARY KEY"),
            );
            let definition = definition
                .split("PRIMARY KEY(user_id,")
                .next()
                .unwrap()
                .trim_end()
                .trim_end_matches(',');
            db.execute_batch(&format!("CREATE TABLE {name} ({definition})"))
                .unwrap();
        }
        db.execute(
            "INSERT INTO user_devices VALUES('same','owner','original','web',1)",
            [],
        )
        .unwrap();
        db.execute_batch("CREATE TABLE server_notes_account_migration(collision TEXT)")
            .unwrap();
        assert!(initialize(&db).is_err());
        let owner_key: i64 = db
            .query_row(
                "SELECT pk FROM pragma_table_info('user_devices') WHERE name='user_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner_key, 0);
        let name: String = db
            .query_row(
                "SELECT device_name FROM user_devices WHERE user_id='owner'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "original");
        assert!(
            !db.prepare("SELECT 1 FROM sqlite_master WHERE name='user_devices_account_migration'")
                .unwrap()
                .exists([])
                .unwrap()
        );
    }
}
