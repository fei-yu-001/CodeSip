
    asset_hash TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    byte_size INTEGER NOT NULL,
    content BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, asset_hash)