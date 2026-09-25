import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const loader = pathToFileURL(require.resolve('tsx')).href
const testRoot = process.env.AGGHUB_TEST_ROOT || (process.platform === 'win32' ? 'E:/LLM工作区/回收站' : os.tmpdir())
fs.mkdirSync(testRoot, { recursive: true })
const artifacts = fs.mkdtempSync(path.join(testRoot, 'agghub-tests-'))
const filters = process.argv.slice(2)
const quiet = process.env.AGGHUB_TEST_QUIET === '1'
function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(dir, entry.name)
    return entry.isDirectory() ? collect(name) : entry.name.endsWith('.test.ts') ? [name] : []
  })
}
const files = collect(path.join(root, 'server/test')).filter(file => !filters.length || filters.some(f => file.includes(f))).sort()
if (!files.length) throw new Error('没有匹配的测试文件')
console.log(`测试产物（保留，不自动删除）：${artifacts}`)
const results = []
for (const [index, file] of files.entries()) {
  const data = path.join(artifacts, `${index}-${path.basename(file, '.test.ts')}`)
  fs.mkdirSync(data)
  const actual = fs.realpathSync(data).toLowerCase()
  const production = path.resolve(root, 'data').toLowerCase()
  if (actual === production || actual.startsWith(production + path.sep)) throw new Error('测试目录不得位于实际 data 内')
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', loader, '--test', '--test-concurrency=1', file], {
      cwd: root, env: { ...process.env, TEMP: data, TMP: data, TMPDIR: data, TSX_DISABLE_CACHE: '1', AGGHUB_TESTING: '1', AGGHUB_DATA_DIR: data, AGGHUB_BACKUP_DIR: path.join(data, 'backups') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
    child.stdout.on('data', chunk => { output += chunk; if (!quiet) process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { output += chunk; if (!quiet) process.stderr.write(chunk) })
    child.on('error', error => { output += String(error) })
    child.on('close', code => {
      clearTimeout(timer)
      fs.writeFileSync(path.join(data, 'output.log'), output)
      const count = name => Number(output.match(new RegExp(`# ${name} (\\d+)`))?.[1] || 0)
      resolve({ file: path.relative(root, file), code, timedOut, tests: count('tests'), passed: count('pass'), failed: count('fail') })
    })
  })
  results.push(result)
  if (quiet) console.log(`${result.code === 0 && !result.timedOut ? '通过' : '失败'}：${result.file}（${result.passed}/${result.tests}）`)
}
fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2))
console.log(`合计 ${results.reduce((n, result) => n + result.tests, 0)} 项测试，通过 ${results.reduce((n, result) => n + result.passed, 0)} 项；结果：${path.join(artifacts, 'results.json')}`)
if (results.some(r => r.code !== 0 || r.timedOut)) process.exitCode = 1
