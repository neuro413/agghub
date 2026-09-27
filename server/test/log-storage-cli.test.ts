import './helpers/isolated'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const data = process.env.AGGHUB_DATA_DIR!
const backups = path.join(data, 'backups')
const filename = path.join(data, 'agghub.db')

function run(...args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.join(root, 'scripts/compact-logs.ts'), ...args], {
      env: { ...process.env, AGGHUB_BACKUP_DIR: backups }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
}

test('空间检查只读，整理拒绝占用中的库，停用后先备份再缩小且保留全部数据', async () => {
  const db = new Database(filename)
  db.pragma('journal_mode=WAL')
  db.exec('CREATE TABLE samples(id INTEGER PRIMARY KEY,data BLOB)')
  const insert = db.prepare('INSERT INTO samples(data) VALUES (?)')
  db.transaction(() => { for (let i = 0; i < 200; i++) insert.run(Buffer.alloc(3000, i)) })()
  db.exec('UPDATE samples SET data=NULL WHERE id%2=0')
  const before = db.pragma('page_count', { simple: true }) as number
  const snapshot = db.prepare('SELECT id,length(data) AS size FROM samples').all()
  const readonly = await run()
  assert.equal(readonly.code, 0, readonly.output)
  assert.equal(fs.existsSync(backups), false)
  assert.equal(db.pragma('page_count', { simple: true }), before)
  db.exec('BEGIN IMMEDIATE')
  try {
    const busy = await run('--apply')
    assert.notEqual(busy.code, 0)
    assert.equal(fs.existsSync(backups), false)
  } finally { db.exec('ROLLBACK'); db.close() }
  const applied = await run('--apply')
  assert.equal(applied.code, 0, applied.output)
  const files = fs.readdirSync(backups)
  assert.equal(files.length, 1)
  const backup = new Database(path.join(backups, files[0], 'agghub.db'), { readonly: true })
  const compacted = new Database(filename, { readonly: true })
  try {
    assert.deepEqual(backup.prepare('SELECT id,length(data) AS size FROM samples').all(), snapshot)
    assert.deepEqual(compacted.prepare('SELECT id,length(data) AS size FROM samples').all(), snapshot)
    assert.ok((compacted.pragma('page_count', { simple: true }) as number) < before)
  } finally { backup.close(); compacted.close() }
})
