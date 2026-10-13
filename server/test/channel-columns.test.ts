import './helpers/isolated'
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'

// 加列前的渠道表：启动时应补齐新列，已有行取默认值
const legacy = new Database(path.join(process.env.AGGHUB_DATA_DIR!, 'agghub.db'))
legacy.exec(`
CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, base_url TEXT, api_key TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '[]', model_mapping TEXT, priority INTEGER NOT NULL DEFAULT 0, weight INTEGER NOT NULL DEFAULT 1,
  status INTEGER NOT NULL DEFAULT 1, region TEXT, timeout_ms INTEGER, ua_override INTEGER NOT NULL DEFAULT 0, ua_value TEXT,
  strip_headers INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO channels (name, type, models, created_at, updated_at) VALUES ('old', 'openai', '["m"]', 0, 0);
`)
legacy.close()

test('已有渠道表补齐单 role 与分组列', async () => {
  const { db, getChannelById } = await import('../src/db')
  const columns = db.prepare("SELECT name FROM pragma_table_info('channels')").pluck().all()
  for (const name of ['single_role', 'single_role_merge_system', 'single_role_exclude_last_user', 'groups', 'ban_until']) assert.ok(columns.includes(name), name)
  const old = getChannelById(1)!
  assert.equal(old.name, 'old')
  assert.equal(old.single_role, null)
  assert.equal(old.single_role_merge_system, false)
  assert.equal(old.single_role_exclude_last_user, false)
  assert.deepEqual(old.groups, ['default'])
  assert.equal(old.ban_until, null)
  db.close()
})
