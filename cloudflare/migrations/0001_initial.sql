CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL,
    role TEXT UNIQUE NOT NULL CHECK (role IN ('First base', 'Third base')),
    seen_at TEXT NOT NULL,
    web_subscription TEXT
);
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    received_at TEXT,
    acknowledged_at TEXT,
    push_status TEXT NOT NULL
);
CREATE INDEX messages_sender ON messages(sender_id, created_at DESC);
CREATE INDEX messages_recipient ON messages(recipient_id, created_at DESC);
CREATE INDEX messages_created ON messages(created_at);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE INDEX rate_limits_window ON rate_limits(window_start);
