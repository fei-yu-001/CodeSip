use crate::error::{ApiError, Result, js_len};
use std::io::{Cursor, Read};
use unicode_normalization::UnicodeNormalization;
pub const MAX_FILE: usize = 8 * 1024 * 1024;
pub const MAX_LIBRARY: usize = 64 * 1024 * 1024;
pub const MAX_ARCHIVE: usize = 24 * 1024 * 1024;
pub const MAX_FILES: usize = 4000;
#[derive(Debug)]
pub struct ImportedFile {
    pub path: String,
    pub bytes: Vec<u8>,
}
pub fn clean_path(input: &str) -> Result<String> {
    let invalid = || ApiError::new(400, "文件路径无效");
    if input.is_empty()
        || js_len(input) > 700
        || input.starts_with('/')
        || input
            .chars()
            .any(|c| c == '\\' || c == ':' || c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err(invalid());
    }
    let normalized: String = input.nfc().collect();
    if normalized
        .split('/')
        .any(|p| p.is_empty() || p == "." || p == ".." || js_len(p) > 255)
    {
        return Err(invalid());
    }
    Ok(normalized)
}
pub fn excluded(path: &str) -> bool {
    path.split('/').any(|p| {
        [
            ".git",
            ".obsidian",
            "node_modules",
            "__MACOSX",
            ".DS_Store",
            ".hvigor",
            "oh_modules",
            ".env",
        ]
        .contains(&p)
            || p.starts_with(".env.")
            || p.starts_with("._")
    })
}
pub fn classify(path: &str, bytes: &[u8]) -> (bool, &'static str) {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let media = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        _ => None,
    };
    if let Some(media) = media
        && ext != "svg"
    {
        return (false, media);
    }
    let text =
        bytes.len() <= 2 * 1024 * 1024 && !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok();
    (
        text,
        media.unwrap_or(if text {
            "text/plain; charset=utf-8"
        } else {
            "application/octet-stream"
        }),
    )
}
pub fn read_archive(bytes: &[u8]) -> Result<Vec<ImportedFile>> {
    if bytes.len() > MAX_ARCHIVE {
        return Err(ApiError::new(413, "ZIP 不得超过 24 MB"));
    }
    let invalid = |_| ApiError::new(400, "ZIP 文件无效或不完整");
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(invalid)?;
    if archive.len() > MAX_FILES + 1000 {
        return Err(ApiError::new(413, "ZIP 内文件数量过多"));
    }
    let mut files = Vec::new();
    let mut names = std::collections::HashSet::new();
    let mut total = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(invalid)?;
        let raw = entry.name().map_err(invalid)?;
        let name = clean_path(raw.strip_suffix('/').unwrap_or(&raw))?;
        if entry.unix_mode().is_some_and(|m| m & 0xf000 == 0xa000) {
            return Err(ApiError::new(400, "不支持 ZIP 中的符号链接"));
        }
        if entry.is_dir() || excluded(&name) {
            continue;
        }
        if !names.insert(name.clone()) {
            return Err(ApiError::new(400, "ZIP 存在重复文件路径"));
        }
        if entry.size() > MAX_FILE as u64
            || total as u64 + entry.size() > MAX_LIBRARY as u64
            || files.len() >= MAX_FILES
        {
            return Err(ApiError::new(
                413,
                "解压后大小超限：单文件 8 MB，项目 64 MB，最多 4000 个文件",
            ));
        }
        let mut content = Vec::with_capacity(entry.size() as usize);
        (&mut entry)
            .take((MAX_FILE + 1) as u64)
            .read_to_end(&mut content)
            .map_err(|_| ApiError::new(400, "ZIP 文件内容不完整或不受支持"))?;
        total += content.len();
        if content.len() > MAX_FILE || total > MAX_LIBRARY {
            return Err(ApiError::new(413, "解压后文件过大"));
        }
        files.push(ImportedFile {
            path: name,
            bytes: content,
        });
    }
    if files.is_empty() {
        return Err(ApiError::new(400, "ZIP 中没有可阅读的文件"));
    }
    let prefix = format!("{}/", files[0].path.split('/').next().unwrap_or(""));
    if files.iter().all(|f| f.path.starts_with(&prefix)) {
        for file in &mut files {
            file.path = file.path[prefix.len()..].to_owned();
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_paths_and_binary_classification_preserve_boundaries() {
        for path in ["../x", "x//y", "C:/x", "x\\y", "/x", "x/./y", "x\0y"] {
            assert!(clean_path(path).is_err());
        }
        assert_eq!(clean_path("e\u{301}/笔记.md").unwrap(), "é/笔记.md");
        assert!(excluded("project/.env.local"));
        assert!(!excluded("project/environment.md"));
        assert_eq!(classify("image.png", b"text"), (false, "image/png"));
        assert_eq!(classify("unsafe.svg", b"<svg/>"), (true, "image/svg+xml"));
        assert_eq!(
            classify("binary.txt", b"\xff\xfe"),
            (false, "application/octet-stream")
        );
    }
}
