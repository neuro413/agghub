import { createApp } from './app'
import { HOST, PORT, PUBLIC_HOST, PUBLIC_PORT } from './config'
import { cleanupOldLogs } from './stats/recorder'
import { recoverChannels } from './core/channelHealth'
import { cleanupSessions } from './core/sessions'

if (PUBLIC_PORT && PUBLIC_PORT === PORT) throw new Error('AGGHUB_PUBLIC_PORT 不能与 PORT 相同')

const lan = createApp('lan')
const onLanListening = () => {
  console.log(`🍊 AggHub 内网入口已启动: http://${HOST || 'localhost'}:${PORT}`)
}
if (HOST) lan.listen(PORT, HOST, onLanListening)
else lan.listen(PORT, onLanListening)

if (PUBLIC_PORT) {
  createApp('public').listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    console.log(`🌐 AggHub 公网入口已启动: http://${PUBLIC_HOST}:${PUBLIC_PORT}（/v1 需要 API Key，/ 为用户门户）`)
  })
}

// ── 定时清理过期日志 + 恢复到期熔断渠道 + 清理过期门户会话 ──
const maintain = () => {
  void cleanupOldLogs().catch(error => console.warn('[agghub] 清理过期日志失败:', error))
  try {
    recoverChannels()
  } catch (error) {
    console.warn('[agghub] 恢复熔断渠道失败:', error)
  }
  try {
    cleanupSessions()
  } catch (error) {
    console.warn('[agghub] 清理门户会话失败:', error)
  }
}
// 启动监听后再分批维护；小包尾部仍沿用一天等待期，GC 至少每六小时执行。
setImmediate(maintain)
setInterval(maintain, 60_000).unref()
