export const LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  channel_id INTEGER,
  channel_name TEXT,
  entry_format TEXT NOT NULL DEFAULT 'openai',
  model TEXT,
  upstream_model TEXT,
  status TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  is_stream INTEGER DEFAULT 0,
  is_retry INTEGER DEFAULT 0,
  error_message TEXT,
  preprocessed INTEGER DEFAULT 0,
  pseudo_thinking INTEGER DEFAULT 0,
  request_headers_ref BLOB,
  request_body_ref BLOB,
  response_body_ref BLOB,
  preprocessed_body_ref BLOB,
  thinking_inject_ref BLOB,
  upstream_response_body_ref BLOB
);
`

export const BLOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  hash BLOB PRIMARY KEY,
  raw_size INTEGER NOT NULL,
  codec INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS blob_edges (
  parent BLOB NOT NULL,
  child BLOB NOT NULL,
  PRIMARY KEY (parent, child)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_blob_edges_child ON blob_edges(child);
`

export const LOG_ADDITIONS: Record<string, string> = {
  request_id: 'TEXT',
  attempt_latency_ms: 'INTEGER',
  response_body_truncated: 'INTEGER NOT NULL DEFAULT 0',
  upstream_response_body_truncated: 'INTEGER NOT NULL DEFAULT 0',
}
