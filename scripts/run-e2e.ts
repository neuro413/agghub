import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { runRegressions } from '../tests/e2e/regression'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = process.env.AGGHUB_TEST_ROOT || (process.platform === 'win32' ? 'E:/LLM工作区/回收站' : os.tmpdir())
fs.mkdirSync(temporary, { recursive: true })
const artifacts = fs.mkdtempSync(path.join(temporary, 'agghub-e2e-'))
const dist = path.join(artifacts, 'web-dist')
console.log(`浏览器测试与隔离构建产物：${artifacts}`)
await build({ root: path.join(root, 'web'), configFile: false, plugins: [react()], build: { outDir: dist, emptyOutDir: false } })
const executablePath = process.env.AGGHUB_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(file => fs.existsSync(file))
if (!executablePath) throw new Error('没有可复用浏览器，请设置 AGGHUB_CHROME；未自动下载浏览器')
process.env.TEMP = process.env.TMP = process.env.TMPDIR = artifacts
const persistent = await chromium.launchPersistentContext(path.join(artifacts, 'chrome-profile'), { executablePath, headless: true })
const browser = persistent.browser()!
const app = express()
app.use(express.static(dist))
const server = app.listen(0, '127.0.0.1')
try {
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const staticBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fs.writeFileSync(path.join(artifacts, 'environment.json'), JSON.stringify({ node: process.version, chrome: browser.version(), executablePath, staticBase }, null, 2))
  const results = await runRegressions(browser, dist, artifacts, staticBase)
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2))
  if (results.some(result => !result.passed)) process.exitCode = 1
} finally {
  await persistent.close()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
