use crate::{
    db,
    error::{ApiError, Result},
    files, reader, sync,
};
use axum::{
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request, State as AxumState},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Write,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tower::ServiceExt;

pub struct State {
    pub pool: db::Pool,
    pub setup: String,
    pub production: bool,
    pub origins: Vec<String>,
    pub static_dir: String,
    pub jobs: Arc<tokio::sync::Semaphore>,
    pub uploads: Arc<tokio::sync::Semaphore>,
    pub rates: Mutex<HashMap<(IpAddr, bool), (Instant, u32)>>,
    pub rate_limit: bool,
}
fn header<'a>(headers: &'a HeaderMap, key: &str) -> &'a str {
    headers.get(key).and_then(|s| s.to_str().ok()).unwrap_or("")
}
fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    header(headers, "cookie")
        .split(';')
        .find_map(|part| part.trim().strip_prefix("codesip_session="))
}
fn auth_route(path: &str) -> bool {
    matches!(
        path,
        "/api/auth/setup" | "/api/auth/login" | "/api/v1/auth/login"
    )
}
fn is_write(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}
fn check_origin(state: &State, method: &str, headers: &HeaderMap) -> Result<()> {
    if is_write(method)
        && !header(headers, "authorization").starts_with("Bearer ")
        && !state.origins.iter().any(|s| s == header(headers, "origin"))
    {
        return Err(ApiError::new(403, "请求来源无效，请从 CodeSip 页面操作"));
    }
    Ok(())
}
fn rate(state: &State, path: &str, headers: &HeaderMap, peer: SocketAddr) -> Result<()> {
    if !state.rate_limit {
        return Ok(());
    }
    let ip = if peer.ip() == IpAddr::from([127, 0, 0, 1]) {
        header(headers, "x-forwarded-for")
            .rsplit(',')
            .next()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(peer.ip())
    } else {
        peer.ip()
    };
    let mut rates = state.rates.lock().map_err(ApiError::internal)?;
    if rates.len() > 10000 {
        rates.retain(|_, v| v.0.elapsed() < Duration::from_secs(60));
        if rates.len() > 10000 {
            return Err(ApiError::new(429, "操作太频繁，请稍后再试"));
        }
    }
    let auth = auth_route(path);
    let count = rates.entry((ip, auth)).or_insert((Instant::now(), 0));
    if count.0.elapsed() >= Duration::from_secs(60) {
        *count = (Instant::now(), 0);
    }
    count.1 = count.1.saturating_add(1);
    if count.1 > if auth { 8 } else { 400 } {
        return Err(ApiError::new(429, "操作太频繁，请稍后再试"));
    }
    Ok(())
}
pub async fn handler(
    AxumState(state): AxumState<Arc<State>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let api = req.uri().path().starts_with("/api/");
    let mut response = match handle(state, peer, req).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    let h = response.headers_mut();
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("same-origin"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    if api {
        h.insert("cache-control", HeaderValue::from_static("no-store"));
    } else {
        h.insert("content-security-policy",HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"));
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert("retry-after", HeaderValue::from_static("60"));
    }
    response
}
async fn handle(state: Arc<State>, peer: SocketAddr, req: Request) -> Result<Response> {
    let path = req.uri().path().to_owned();
    let method = req.method().as_str().to_owned();
    check_origin(&state, &method, req.headers())?;
    if !path.starts_with("/api/") {
        let serve = tower_http::services::ServeDir::new(&state.static_dir)
            .append_index_html_on_directories(true)
            .fallback(tower_http::services::ServeFile::new(
                std::path::Path::new(&state.static_dir).join("index.html"),
            ));
        let response = serve.oneshot(req).await.map_err(ApiError::internal)?;
        let (mut parts, body) = response.into_parts();
        parts.headers.insert(
            "cache-control",
            HeaderValue::from_static(if path.starts_with("/assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            }),
        );
        return Ok(Response::from_parts(parts, Body::new(body)));
    }
    rate(&state, &path, req.headers(), peer)?;
    if path == "/api/health" && (method == "GET" || method == "HEAD") {
        let mut output = Output::json(
            json!({"status":"ok","app":"codesip","version":"0.1.0","runtime":"rust"}),
        )?;
        if method == "HEAD" {
            output.body.clear();
        }
        return Ok(output.response());
    }
    let upload = method == "POST" && (path == "/api/import" || path == "/api/v1/assets/upload");
    let upload_permit = if upload {
        Some(
            tokio::time::timeout(
                Duration::from_secs(10),
                state.uploads.clone().acquire_owned(),
            )
            .await
            .map_err(|_| ApiError::new(503, "服务繁忙，请稍后重试"))?
            .map_err(ApiError::internal)?,
        )
    } else {
        None
    };
    // Admission before reading bodies bounds request buffers and CPU work. Waiting
    // happens asynchronously; health and static files don't share these permits.
    let permit = tokio::time::timeout(Duration::from_secs(10), state.jobs.clone().acquire_owned())
        .await
        .map_err(|_| ApiError::new(503, "服务繁忙，请稍后重试"))?
        .map_err(ApiError::internal)?;
    let uri = req.uri().to_string();
    let headers = req.headers().clone();
    let max = if upload {
        files::MAX_ARCHIVE + 65536
    } else if method == "PUT" && path.ends_with("/document-copy") {
        3 * 1024 * 1024
    } else if path.contains("/annotations/") && method == "PUT" {
        64 * 1024
    } else if path.contains("/annotations/") && method == "DELETE" {
        1024
    } else {
        12 * 1024 * 1024
    };
    let bytes = tokio::time::timeout(Duration::from_secs(30), to_bytes(req.into_body(), max))
        .await
        .map_err(|_| ApiError::new(408, "请求超时，请重试"))?
        .map_err(|_| ApiError::new(413, "请求内容过大"))?;
    let mut attachment = None;
    if upload {
        let boundary = multer::parse_boundary(header(&headers, "content-type"))
            .map_err(|_| ApiError::new(400, "请选择上传文件"))?;
        let mut form =
            multer::Multipart::new(Body::from(bytes.clone()).into_data_stream(), boundary);
        let field = form
            .next_field()
            .await
            .map_err(|_| ApiError::new(400, "上传文件无效"))?
            .ok_or_else(|| ApiError::new(400, "请选择上传文件"))?;
        let name = field
            .file_name()
            .ok_or_else(|| ApiError::new(400, "请选择上传文件"))?
            .to_owned();
        let content = field
            .bytes()
            .await
            .map_err(|_| ApiError::new(400, "上传文件无效"))?;
        if content.len() > files::MAX_ARCHIVE {
            return Err(ApiError::new(413, "ZIP 不得超过 24 MB"));
        }
        if form
            .next_field()
            .await
            .map_err(|_| ApiError::new(400, "上传文件无效"))?
            .is_some()
        {
            return Err(ApiError::new(413, "每次只能上传一个文件"));
        }
        attachment = Some((name, content));
    }
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _upload_permit = upload_permit;
        let mut output = {
            let connection = state.pool.get();
            dispatch(
                &connection,
                &state,
                &method,
                &uri,
                &headers,
                &bytes,
                attachment,
            )?
        };
        if method == "GET" && output.reading {
            output.compress(header(&headers, "accept-encoding"))?;
        }
        if method == "HEAD" {
            output.body.clear();
        }
        Ok(output.response())
    })
    .await
    .map_err(ApiError::internal)?
}
struct Output {
    body: Vec<u8>,
    headers: Vec<(&'static str, String)>,
    reading: bool,
}
impl Output {
    fn json(value: Value) -> Result<Self> {
        Ok(Self {
            body: serde_json::to_vec(&value).map_err(ApiError::internal)?,
            headers: vec![("content-type", "application/json; charset=utf-8".into())],
            reading: false,
        })
    }
    fn binary(bytes: Vec<u8>, media: &str) -> Self {
        Self {
            body: bytes,
            headers: vec![("content-type", media.into())],
            reading: false,
        }
    }
    fn cookie(mut self, token: &str, production: bool) -> Self {
        self.headers.push((
            "set-cookie",
            format!(
                "codesip_session={token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict{}",
                if production { "; Secure" } else { "" }
            ),
        ));
        self
    }
    fn compress(&mut self, accept: &str) -> Result<()> {
        if self.body.len() < 1024
            || !self.headers.iter().any(|(k, v)| {
                *k == "content-type"
                    && (v.starts_with("text/") || v.starts_with("application/json"))
            })
        {
            return Ok(());
        }
        self.headers.push(("vary", "Accept-Encoding".into()));
        let mut weights = HashMap::new();
        let lower = accept.to_ascii_lowercase();
        for part in lower.split(',') {
            let mut tokens = part.trim().split(';');
            let name = tokens.next().unwrap_or("").trim();
            let q = tokens
                .find_map(|s| s.trim().strip_prefix("q="))
                .map(|q| q.parse::<f64>().unwrap_or(0.))
                .unwrap_or(1.);
            weights.insert(name, if (0.0..=1.0).contains(&q) { q } else { 0.0 });
        }
        if *weights
            .get("gzip")
            .or_else(|| weights.get("*"))
            .unwrap_or(&0.)
            <= 0.
        {
            return Ok(());
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(2));
        encoder.write_all(&self.body)?;
        let encoded = encoder.finish()?;
        if encoded.len() < self.body.len() {
            self.body = encoded;
            self.headers.push(("content-encoding", "gzip".into()));
        }
        Ok(())
    }
    fn response(self) -> Response {
        let mut response = Response::new(Body::from(self.body));
        for (key, value) in self.headers {
            if let Ok(value) = HeaderValue::from_str(&value) {
                response.headers_mut().insert(key, value);
            }
        }
        response
    }
}
fn dispatch(
    db: &Connection,
    state: &State,
    method: &str,
    uri: &str,
    headers: &HeaderMap,
    bytes: &[u8],
    attachment: Option<(String, axum::body::Bytes)>,
) -> Result<Output> {
    let (path, query) = uri.split_once('?').unwrap_or((uri, ""));
    let query: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    let q = |name: &str| query.get(name).map(String::as_str).unwrap_or("");
    let bearer = header(headers, "authorization").strip_prefix("Bearer ");
    let identity = if [
        "/api/status",
        "/api/auth/setup",
        "/api/auth/login",
        "/api/v1/auth/login",
    ]
    .contains(&path)
    {
        None
    } else {
        let identity =
            db::authenticate(db, bearer.or_else(|| session_cookie(headers)).unwrap_or(""))?;
        if let Some(id) = &identity.library_id
            && !(method == "GET" && path == format!("/api/libraries/{id}/manifest")
                || method == "POST" && uri == format!("/api/libraries/{id}/sync"))
        {
            return Err(ApiError::new(403, "此令牌仅能同步绑定的笔记库"));
        }
        Some(identity)
    };
    let input: Value = if attachment.is_some() || bytes.is_empty() {
        Value::Null
    } else {
        if !header(headers, "content-type")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
        {
            return Err(ApiError::new(415, "请求内容类型无效"));
        }
        serde_json::from_slice(bytes)?
    };
    let verb = if method == "HEAD" { "GET" } else { method };
    if verb == "GET" && path == "/api/status" {
        return Output::json(json!({"needsSetup":db::needs_setup(db)?}));
    }
    if method == "POST" && auth_route(path) {
        let user = if path == "/api/auth/setup" {
            if !db::needs_setup(db)? {
                return Err(ApiError::new(409, "账号已经建立，请登录"));
            }
            let token = input["setupToken"].as_str().unwrap_or("");
            if !bool::from(
                db::digest(token)
                    .as_bytes()
                    .ct_eq(db::digest(&state.setup).as_bytes()),
            ) {
                return Err(ApiError::new(403, "首次设置密钥不正确"));
            }
            db::create_user(db, &input)?
        } else {
            db::login(db, &input)?
        };
        let uid = user["id"].as_str().unwrap();
        let output = if path == "/api/v1/auth/login" {
            let secret = sync::register_device(db, uid, &input)?;
            let token = db::session(db, uid)?;
            Output::json(
                json!({"access_token":token,"refresh_token":token,"device_secret":secret,"user":user}),
            )?
        } else {
            Output::json(json!({"user":user}))?
        };
        return Ok(output.cookie(&db::session(db, uid)?, state.production));
    }
    let identity = identity.ok_or_else(|| ApiError::new(404, "接口不存在"))?;
    let uid = identity.user["id"].as_str().unwrap();
    match (verb, path) {
        ("GET", "/api/session") => return Output::json(json!({"user":identity.user})),
        ("POST", "/api/auth/logout") => {
            if let Some(token) = session_cookie(headers) {
                db.execute("DELETE FROM sessions WHERE hash=?", [db::digest(token)])?;
            }
            let mut output = Output::json(json!({"ok":true}))?;
            output.headers.push((
                "set-cookie",
                "codesip_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT".into(),
            ));
            return Ok(output);
        }
        ("GET", "/api/libraries") => {
            return Output::json(json!({"libraries":db::libraries(db,uid)?}));
        }
        ("POST", "/api/libraries") => {
            let tx = db::transaction(db)?;
            let library = db::create_library(&tx, uid, &input)?;
            tx.commit()?;
            return Output::json(json!({"library":library}));
        }
        ("GET", "/api/v1/sync/changes") => {
            return Output::json(sync::changes(
                db,
                uid,
                q("since_seq").parse().unwrap_or(0),
                q("limit").parse().ok().filter(|n| *n != 0).unwrap_or(200),
            )?);
        }
        ("POST", "/api/v1/sync/push") => return Output::json(sync::push(db, uid, &input)?),
        ("POST", "/api/v1/assets/check") => {
            return Output::json(sync::check_assets(db, uid, &input)?);
        }
        ("POST", "/api/v1/assets/upload") => {
            let (_, bytes) = attachment.ok_or_else(|| ApiError::new(400, "缺少资产文件"))?;
            let hash = if q("hash").is_empty() {
                db::digest(&bytes)
            } else {
                q("hash").into()
            };
            return Output::json(sync::save_asset(db, uid, &hash, &bytes)?);
        }
        ("POST", "/api/import") => {
            let (filename, bytes) =
                attachment.ok_or_else(|| ApiError::new(400, "请选择 ZIP 文件"))?;
            let files = files::read_archive(&bytes)?;
            let name = if q("name").is_empty() {
                if filename.to_lowercase().ends_with(".zip") {
                    &filename[..filename.len() - 4]
                } else {
                    &filename
                }
            } else {
                q("name")
            };
            let tx = db::transaction(db)?;
            let lib = db::create_library(
                &tx,
                uid,
                &json!({"name":name,"kind":if q("kind").is_empty(){"code"}else{q("kind")}}),
            )?;
            let id = lib["id"].as_str().unwrap();
            db::put_inner(&tx, id, &files, &[], 0)?;
            let lib = db::library(&tx, uid, id)?;
            tx.commit()?;
            return Output::json(json!({"library":lib}));
        }
        ("POST", "/api/demo") => {
            let examples: Vec<Value> = serde_json::from_str(include_str!("demo.json"))?;
            let tx = db::transaction(db)?;
            for (name, kind, range) in [
                ("一杯代码 · 示例项目", "code", 0..3),
                ("随手学 · 示例笔记", "notes", 3..5),
            ] {
                let lib = db::create_library(&tx, uid, &json!({"name":name,"kind":kind}))?;
                let files = examples[range]
                    .iter()
                    .map(|f| files::ImportedFile {
                        path: f["path"].as_str().unwrap().into(),
                        bytes: f["content"].as_str().unwrap().as_bytes().to_vec(),
                    })
                    .collect::<Vec<_>>();
                db::put_inner(&tx, lib["id"].as_str().unwrap(), &files, &[], 0)?;
            }
            tx.commit()?;
            return Output::json(json!({"libraries":db::libraries(db,uid)?}));
        }
        _ => {}
    }
    let segments = path
        .trim_start_matches('/')
        .split('/')
        .map(|s| {
            percent_encoding::percent_decode_str(s)
                .decode_utf8()
                .map(|s| s.into_owned())
                .map_err(|_| ApiError::new(400, "请求路径无效"))
        })
        .collect::<Result<Vec<_>>>()?;
    let segments = segments.iter().map(String::as_str).collect::<Vec<_>>();
    if let ["api", "v1", "assets", hash] = segments.as_slice()
        && verb == "GET"
    {
        return Ok(Output::binary(sync::asset(db, uid, hash)?, "image/png"));
    }
    if segments.len() >= 3 && segments[0] == "api" && segments[1] == "libraries" {
        let id = segments[2];
        if segments
            .get(3)
            .is_some_and(|s| *s == "annotations" || *s == "document-copy")
            && (session_cookie(headers).is_none()
                || headers.contains_key("authorization")
                || identity.library_id.is_some())
        {
            return Err(ApiError::new(403, "请通过网页登录后管理阅读内容"));
        }
        let action = segments.get(3).copied().unwrap_or("");
        if segments.len() == 5 && action == "annotations" {
            return Output::json(match verb {
                "PUT" => reader::put_annotation(db, uid, id, segments[4], &input)?,
                "DELETE" => reader::delete_annotation(db, uid, id, segments[4], &input)?,
                _ => return Err(ApiError::new(404, "接口不存在")),
            });
        }
        if segments.len() > 4 {
            return Err(ApiError::new(404, "接口不存在"));
        }
        let value = match (verb, action) {
            ("GET", "manifest") => {
                let mut output = Output::json(db::manifest(db, uid, id)?)?;
                output.reading = true;
                return Ok(output);
            }
            ("GET", "file") => {
                let file = db::file(db, uid, id, q("path"))?;
                let media = if file.is_text && !q("path").to_lowercase().ends_with(".svg") {
                    "text/plain; charset=utf-8"
                } else {
                    &file.media
                };
                let mut output = Output::binary(file.bytes, media);
                output.headers.push((
                    "content-security-policy",
                    "default-src 'none'; sandbox".into(),
                ));
                output.reading = true;
                return Ok(output);
            }
            ("GET", "search") => db::search(db, uid, id, q("q"))?,
            ("GET", "annotations") => reader::annotations(db, uid, id, q("path"))?,
            ("GET", "document-copy") => json!({"copy":reader::get_copy(db,uid,id,q("path"))?}),
            ("PUT", "document-copy") => reader::put_copy(db, uid, id, &input)?,
            ("POST", "sync") => db::sync(db, uid, id, &input)?,
            ("POST", "token") => json!({"token":db::issue_token(db,uid,id)?}),
            ("DELETE", "token") => {
                db::library(db, uid, id)?;
                db.execute("DELETE FROM tokens WHERE library_id=?", [id])?;
                json!({"ok":true})
            }
            ("DELETE", "") => {
                db::library(db, uid, id)?;
                db.execute("DELETE FROM libraries WHERE id=?", [id])?;
                json!({"ok":true})
            }
            _ => return Err(ApiError::new(404, "接口不存在")),
        };
        return Output::json(value);
    }
    Err(ApiError::new(404, "接口不存在"))
}
