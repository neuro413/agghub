import type { Request, Response } from 'express'

/** /v1/messages 开头的路径用 Anthropic 错误格式，其余用 OpenAI 格式；用 req.originalUrl 判断（去掉 ? 后的查询串） */
export function isAnthropicPath(req: Request): boolean {
  return (req.originalUrl || '').split('?')[0].startsWith('/v1/messages')
}

/** 按入口格式输出错误；已发出响应头时不再处理 */
export function sendEntryError(req: Request, res: Response, status: number, openaiType: string, anthropicType: string, message: string): void {
  if (res.headersSent) return
  if (isAnthropicPath(req)) {
    res.status(status).json({ type: 'error', error: { type: anthropicType, message } })
  } else {
    res.status(status).json({ error: { message, type: openaiType, code: openaiType } })
  }
}
