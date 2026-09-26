import fs from 'node:fs'
import path from 'node:path'
import { expect, type Browser, type Page, type Route } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../server/src/config'

function settingsFixture(): any {
  return structuredClone(DEFAULT_SETTINGS)
}
const sampleLog = (id: number, model = 'synthetic') => ({ id, model, created_at: Date.now(), status: 'success', status_code: 200, channel_name: 'mock', entry_format: 'openai', total_tokens: 2, latency_ms: 12, request_body: '{"messages":[]}' })
const origin = 'http://agghub-fix.test'
const reply = (route: Route, data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
const navigate = (page: Page, label: string) => page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click()

export async function runRegressions(browser: Browser, dist: string, artifacts: string, staticBase: string) {
  const results: { name: string; passed: boolean; error?: string }[] = []
  async function scenario(name: string, run: (page: Page, fixture: any, custom: { handle?: (route: Route, url: URL) => Promise<boolean> }) => Promise<void>) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const settings = settingsFixture()
    const custom: { handle?: (route: Route, url: URL) => Promise<boolean> } = {}
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) { await route.abort(); return }
      if (custom.handle && await custom.handle(route, url)) return
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/settings') {
          if (route.request().method() === 'PUT') Object.assign(settings, route.request().postDataJSON(), { access_token: (route.request().postDataJSON().access_token ?? settings.access_token).trim() })
          return reply(route, settings)
        }
        if (url.pathname === '/api/channels') return reply(route, [{ id: 1, name: '测试渠道', type: 'openai', models: ['listed'], model_mapping: { 'alias-only': 'real-model' }, priority: 0, weight: 1, status: 1 }])
        if (url.pathname === '/api/logs/facets') return reply(route, { models: [], channels: [] })
        if (url.pathname === '/api/logs') return reply(route, { total: 0, items: [] })
        if (url.pathname === '/api/thinking') return reply(route, { total: 0, items: [] })
        return reply(route, { ok: true })
      }
      const file = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      if (!file.startsWith(path.resolve(dist) + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' })
      const response = await route.fetch({ url: staticBase + url.pathname, maxRedirects: 0 })
      await route.fulfill({ response })
    })
    try {
      await page.goto(origin)
      await run(page, settings, custom)
      expect(errors).toEqual([])
      results.push({ name, passed: true })
      console.log(`通过：${name}`)
    } catch (error) {
      results.push({ name, passed: false, error: String(error) })
      console.error(`失败：${name}\n${error}`)
      await page.screenshot({ path: path.join(artifacts, `failure-${results.length}.png`), fullPage: true })
      fs.writeFileSync(path.join(artifacts, `failure-${results.length}.html`), await page.content())
    } finally { await context.close() }
  }

  await scenario('D23/R05: 非安全 HTTP 三类规则新增、mapping 别名和失效限定项', async (page, settings) => {
    settings.preprocess_rules = [{ id: 'existing', enabled: true, source: 'regex', pattern: 'x', flags: 'g', replacement: '', models: ['missing-model'] }]
    await navigate(page, '预处理')
    expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: 'undefined' })
    const buttons = page.getByRole('button', { name: '新增规则', exact: true })
    await expect(buttons).toHaveCount(3)
    for (let i = 0; i < 3; i++) await buttons.nth(i).click()
    await expect(page.locator('.ah-pp-rule')).toHaveCount(4)
    await expect(page.getByRole('button', { name: 'alias-only', exact: true }).first()).toBeVisible()
    await page.locator('.ah-pp-rule').filter({ hasText: 'x' }).last().locator('.ah-pp-rule-head').click().catch(() => {})
    await expect(page.getByRole('button', { name: 'missing-model（已失效，可移除）', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'missing-model（已失效，可移除）', exact: true }).click()
  })

  await scenario('D23: 缺 ID 和重复 ID 导入后独立保存', async (page, settings) => {
    await navigate(page, '预处理')
    const rules = [{ id: 'duplicate', pattern: 'a' }, { id: 'duplicate', pattern: 'b' }, { pattern: 'c' }]
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(rules)) })
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect.poll(() => settings.preprocess_rules.length).toBe(3)
    expect(new Set(settings.preprocess_rules.map((rule: any) => rule.id)).size).toBe(3)
  })

  await scenario('D24/D26: 复制降级成功、失败不假报成功，令牌保存规范化', async (page) => {
    await navigate(page, '设置')
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      document.execCommand = () => false
    })
    await page.getByRole('button', { name: '复制', exact: true }).first().click()
    await expect(page.getByText('复制失败，请选择左侧地址手动复制')).toBeVisible()
    await expect(page.getByText('地址已复制', { exact: true })).toHaveCount(0)
    await page.evaluate(() => { document.execCommand = () => true })
    await page.getByRole('button', { name: '复制', exact: true }).first().click()
    await expect(page.getByText('地址已复制', { exact: true })).toBeVisible()
    await page.locator('input[type=password]').fill(' synthetic-token ')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('agghub_token'))).toBe('synthetic-token')
  })

  await scenario('D25: 日志 51→50 和清空自动回合法页', async (page, _settings, custom) => {
    let total = 51
    custom.handle = async (route, url) => {
      if (url.pathname === '/api/logs') {
        if (route.request().method() === 'DELETE') { total = 0; await reply(route, { ok: true }); return true }
        const offset = Number(url.searchParams.get('offset'))
        await reply(route, { total, items: Array.from({ length: Math.min(50, Math.max(0, total - offset)) }, (_, index) => sampleLog(offset + index + 1)) }); return true
      }
      if (/\/api\/logs\/\d+$/.test(url.pathname) && route.request().method() === 'DELETE') { total--; await reply(route, { ok: true }); return true }
      return false
    }
    page.on('dialog', dialog => dialog.accept())
    await navigate(page, '请求日志')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.locator('.ah-logt-row')).toHaveCount(1)
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.locator('.ah-logt-row')).toHaveCount(50)
    await page.getByRole('button', { name: '清空', exact: true }).click()
    await expect(page.locator('.ah-logt-row')).toHaveCount(0)
    await expect(page.getByText('暂无请求日志', { exact: true })).toBeVisible()
  })

  await scenario('D25: 思维链 31→30 自动回前页', async (page, settings, custom) => {
    settings.drop_thinking = true
    settings.pseudo_thinking_enabled = true
    let total = 31
    custom.handle = async (route, url) => {
      if (url.pathname !== '/api/thinking') return false
      if (route.request().method() === 'DELETE') { total--; await reply(route, { ok: true, deleted: 1 }); return true }
      const offset = Number(url.searchParams.get('offset'))
      await reply(route, { total, items: Array.from({ length: Math.min(30, Math.max(0, total - offset)) }, (_, index) => ({ signature: `sig-${offset + index}`, preview: '合成思维链', length: 10, created_at: 0 })) }); return true
    }
    await navigate(page, '预处理')
    await page.getByRole('button', { name: /查看.*思维链|查看存储|已保存思维链/ }).click()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.locator('.ah-pp-picker-row')).toHaveCount(1)
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.locator('.ah-pp-picker-row')).toHaveCount(30)
  })

  await scenario('R04: 日志慢旧响应无法覆盖新搜索结果', async (page, _settings, custom) => {
    let release: (() => void) | undefined
    let waiting = false
    custom.handle = async (route, url) => {
      if (url.pathname !== '/api/logs') return false
      const query = url.searchParams.get('q')
      if (query === 'old') { waiting = true; await new Promise<void>(resolve => { release = resolve }) }
      await reply(route, { total: 1, items: [sampleLog(1, query || 'initial')] }).catch(() => {})
      return true
    }
    await navigate(page, '请求日志')
    const search = page.getByPlaceholder('搜索模型 / 渠道 / 错误信息…')
    await search.fill('old')
    await expect.poll(() => waiting).toBe(true)
    await search.fill('new')
    await expect(page.locator('.ah-logt-model')).toContainText('new')
    release!()
    await page.waitForTimeout(80)
    await expect(page.locator('.ah-logt-model')).toContainText('new')
  })

  await scenario('R04: 统计范围切换拒绝慢旧响应', async (page, _settings, custom) => {
    let release: (() => void) | undefined
    let waiting = false
    custom.handle = async (route, url) => {
      if (url.pathname !== '/api/stats') return false
      const range = url.searchParams.get('range')
      if (range === '7d') { waiting = true; await new Promise<void>(resolve => { release = resolve }) }
      await reply(route, { range, overview: { total: range === '30d' ? 333 : 111, success: 1, error: 0, success_rate: 1, total_tokens: 0, avg_latency: 0 }, trend: [], by_channel: [], by_model: [] }).catch(() => {})
      return true
    }
    await navigate(page, '统计')
    await page.getByRole('button', { name: '7 天', exact: true }).click()
    await expect.poll(() => waiting).toBe(true)
    await page.getByRole('button', { name: '30 天', exact: true }).click()
    await expect(page.getByText('333', { exact: true })).toBeVisible()
    release!()
    await page.waitForTimeout(80)
    await expect(page.getByText('333', { exact: true })).toBeVisible()
  })

  await scenario('D01/G6: 标签非法显示错误，保存期间输入禁用', async (page, settings, custom) => {
    settings.pseudo_thinking_open_tag = ''
    await navigate(page, '预处理')
    await expect(page.getByRole('alert')).toContainText('标签须非空')
    await navigate(page, '设置')
    let release: (() => void) | undefined
    custom.handle = async (route, url) => {
      if (url.pathname === '/api/settings' && route.request().method() === 'PUT') { await new Promise<void>(resolve => { release = resolve }); await reply(route, settings); return true }
      return false
    }
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.locator('input[type=password]')).toBeDisabled()
    release!()
    await expect(page.locator('input[type=password]')).toBeEnabled()
  })
  await scenario('D23: 非安全 HTTP 可视化选中文本创建规则', async (page, settings, custom) => {
    custom.handle = async (route, url) => {
      if (url.pathname === '/api/logs') { await reply(route, { total: 1, items: [sampleLog(1)] }); return true }
      if (url.pathname === '/api/logs/1') { await reply(route, { ...sampleLog(1), request_body: JSON.stringify({ messages: [{ role: 'user', content: '可视化样本文本' }] }) }); return true }
      return false
    }
    await navigate(page, '预处理')
    await page.getByRole('button', { name: '可视化', exact: true }).click()
    await page.getByRole('button', { name: '从请求日志选择', exact: true }).click()
    await page.locator('.ah-pp-picker-row').click()
    const text = page.locator('.ah-pp-blk-body')
    await expect(text).toHaveText('可视化样本文本')
    await text.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByRole('button', { name: '添加为规则', exact: true }).click()
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect.poll(() => settings.preprocess_rules.length).toBe(1)
    expect(settings.preprocess_rules[0].source).toBe('visual')
    expect(settings.preprocess_rules[0].id).toMatch(/^[a-f0-9-]{36}$/)
  })

  await scenario('D24: Clipboard 拒绝时降级，成功时内容确实送入复制接口', async page => {
    await navigate(page, '设置')
    await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('拒绝剪贴板权限') } } }); document.execCommand = () => false`)
    await page.getByRole('button', { name: '复制', exact: true }).first().click()
    await expect(page.getByText('复制失败，请选择左侧地址手动复制')).toBeVisible()
    await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text } } })`)
    await page.getByRole('button', { name: '复制', exact: true }).first().click()
    await expect.poll(() => page.evaluate(() => (window as any).copiedText)).toBe(origin + '/v1')
  })

  await scenario('R04: 删除中切换搜索，完成后只刷新当前筛选', async (page, _settings, custom) => {
    let release: (() => void) | undefined
    let started = false
    custom.handle = async (route, url) => {
      if (url.pathname === '/api/logs/1' && route.request().method() === 'DELETE') {
        started = true
        await new Promise<void>(resolve => { release = resolve })
        await reply(route, { ok: true }); return true
      }
      if (url.pathname === '/api/logs') { await reply(route, { total: 1, items: [sampleLog(1, url.searchParams.get('q') || 'initial')] }); return true }
      return false
    }
    page.on('dialog', dialog => dialog.accept())
    await navigate(page, '请求日志')
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => started).toBe(true)
    await page.getByPlaceholder('搜索模型 / 渠道 / 错误信息…').fill('current-filter')
    await expect(page.locator('.ah-logt-model')).toContainText('current-filter')
    release!()
    await expect(page.getByText('已删除', { exact: true })).toBeVisible()
    await page.waitForTimeout(80)
    await expect(page.locator('.ah-logt-model')).toContainText('current-filter')
  })
  return results
}
