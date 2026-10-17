import './helpers/isolated'
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'

// 旧版单服务器门槛：服务器 ID + 拥有任一即可的身份组
const legacy = new Database(path.join(process.env.AGGHUB_DATA_DIR!, 'agghub.db'))
legacy.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('discord_guild_id', '234567890123456789')
legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('discord_role_ids', JSON.stringify(['200000000000000001', '200000000000000002']))
legacy.close()

test('旧版服务器与身份组门槛迁移为一个规则组，旧设置删除', async () => {
  const { db, getSettings } = await import('../src/db')
  assert.deepEqual(getSettings().discord_rules, [{
    conditions: [{ guild_id: '234567890123456789', all_roles: [], any_roles: ['200000000000000001', '200000000000000002'], deny_roles: [] }],
  }])
  assert.equal(db.prepare("SELECT COUNT(*) FROM settings WHERE key IN ('discord_guild_id', 'discord_role_ids')").pluck().get(), 0)
  db.close()
})
