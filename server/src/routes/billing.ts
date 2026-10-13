import { Router } from 'express'

// 【签名桩】由「计费与限流」任务实现 POST /preview；挂载在 /api/billing（app.ts 已挂载）。
export const billingRouter = Router()
