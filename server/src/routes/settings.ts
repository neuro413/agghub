import { Router } from 'express'
import { getSettings, setSettings } from '../db'
import { SettingsValidationError, validateSettingsPatch } from '../core/settingsValidation'

export const settingsRouter = Router()

settingsRouter.get('/', (_req, res) => {
  res.json(getSettings())
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
