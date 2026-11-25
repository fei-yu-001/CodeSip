PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('code','notes')),revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,path TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,is_text INTEGER NOT NULL,media_type TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(library_id,path));
      CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS library_owner ON libraries(user_id);
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);

CREATE TABLE IF NOT EXISTS reader_annotations(
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      id TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL,
      snippet TEXT NOT NULL, note TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(library_id,id)
    );
    CREATE INDEX IF NOT EXISTS annotation_file ON reader_annotations(library_id,path,deleted,line);
CREATE TABLE IF NOT EXISTS reader_document_copies(
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      path TEXT NOT NULL, content TEXT NOT NULL, base_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(library_id,path)
    );

      CREATE TABLE IF NOT EXISTS user_secrets (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        device_secret TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS server_changelog (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        is_deleted INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changelog_user_seq ON server_changelog(user_id, seq);
