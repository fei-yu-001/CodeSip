use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

#[derive(Debug)]
pub struct ApiError(pub u16, pub String);
pub type Result<T> = std::result::Result<T, ApiError>;
impl ApiError {
    pub fn new(code: u16, text: &str) -> Self {
        Self(code, text.into())
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        // Never log request bodies, SQL bindings, headers, tokens or note content.
        let _ = error;
        eprintln!("CodeSip internal operation failed");
        Self::new(500, "服务暂时无法完成请求，请稍后重试")
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        Self::internal(e)
    }
}
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(e)
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        Self::new(400, "请求数据格式不正确")
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.0).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({"error":self.1})),
        )
            .into_response()
    }
}
pub fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(400, "请求数据格式不正确"))
}
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}
pub fn js_slice(s: &str, limit: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(limit).collect::<Vec<_>>())
}
pub fn safe_int(v: &Value) -> Option<i64> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}
pub fn version(v: Option<&Value>, message: &str) -> Result<Option<i64>> {
    match v {
        Some(Value::Null) => Ok(None),
        Some(v) => safe_int(v)
            .filter(|n| *n >= 1)
            .map(Some)
            .ok_or_else(|| ApiError::new(400, message)),
        None => Err(ApiError::new(400, message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_integer_rejects_extreme_json_numbers_without_panicking() {
        for number in [i64::MIN, i64::MAX, 9_007_199_254_740_992] {
            assert_eq!(safe_int(&json!(number)), None);
        }
        assert_eq!(safe_int(&json!(1.0)), Some(1));
        assert_eq!(safe_int(&json!(1.5)), None);
        assert_eq!(
            safe_int(&json!(9_007_199_254_740_991i64)),
            Some(9_007_199_254_740_991)
        );
    }
}
