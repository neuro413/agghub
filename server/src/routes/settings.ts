import { Router } from 'express'
import { getSettings, setSettings } from '../db'
import { SettingsValidationError, validateSettingsPatch } from '../core/settingsValidation'
import { saveBackground, saveBrandIcon } from '../core/siteAssets'

export const settingsRouter = Router()

settingsRouter.get('/', (_req, res) => {
  res.json(getSettings())
})

// 上传门户品牌图标（data URI），保存后立即把图标设置指向上传地址
settingsRouter.put('/brand-icon', (req, res) => {
  try {
    setSettings({ portal_brand_icon: saveBrandIcon(req.body?.data) })
    res.json(getSettings())
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
})

// 上传门户背景图（data URI），保存后立即把背景设置指向上传地址
settingsRouter.put('/background', (req, res) => {
  try {
    setSettings({ portal_background: saveBackground(req.body?.data) })
    res.json(getSettings())
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
})

settingsRouter.put('/', (req, res, next) => {
  try {
    const patch = validateSettingsPatch(getSettings(), req.body)
    setSettings(patch)
    res.json(getSettings())
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      res.status(400).json({ error: error.message, fields: error.fields })
    } else next(error)
  }
})
