import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR, DB_PATH } from '../server/src/config'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--apply')) throw new Error('用法：npm run logs:storage [-- --apply]')
const apply = args.includes('--apply')
const db = new Database(DB_PATH, { readonly: !apply, fileMustExist: true })
const measure = () => {
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const pages = db.pragma('page_count', { simple: true }) as number
  const freePages = db.pragma('freelist_count', { simple: true }) as number
  return {
    database_bytes: pages * pageSize,
    free_page_bytes: freePages * pageSize,
    tables: db.prepare(`SELECT name, SUM(pgsize) AS allocated_bytes, SUM(payload) AS payload_bytes,
      SUM(unused) AS unused_bytes FROM dbstat GROUP BY name ORDER BY allocated_bytes DESC`).all(),
  }
}

try {
  if (apply) {
    // 独占锁拿不到就退出，避免在运行中的网关旁执行整库重建。
    db.pragma('busy_timeout = 1000')
    db.pragma('locking_mode = EXCLUSIVE')
    db.exec('BEGIN EXCLUSIVE; COMMIT')
  } else db.pragma('query_only = ON')
  const before = measure()
  console.log(JSON.stringify({ before }, null, 2))
  if (apply) {
    const root = process.env.AGGHUB_BACKUP_DIR || path.join(DATA_DIR, 'backups')
    const directory = path.join(root, `agghub-before-vacuum-${Date.now()}-${randomUUID()}`)
    fs.mkdirSync(directory, { recursive: true })
    const backup = path.join(directory, 'agghub.db')
    await db.backup(backup)
    console.log(`已备份完整 SQLite 快照：${backup}`)
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')
    const after = measure()
    console.log(JSON.stringify({ after, reclaimed_bytes: before.database_bytes - after.database_bytes }, null, 2))
  } else {
    console.log('当前仅只读检查。需要整理时先停止服务，再执行 npm run logs:storage -- --apply；工具会先备份，再重建数据库。')
  }
} catch (error) {
  console.error('空间整理未完成；若数据库正在使用，请先停止服务。', error)
  process.exitCode = 1
} finally {
  db.close()
}
