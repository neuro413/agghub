import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const data = process.env.AGGHUB_DATA_DIR
if (process.env.AGGHUB_TESTING !== '1' || !data) throw new Error('请通过 npm test 启动隔离测试')
const actual = fs.realpathSync(data).toLowerCase()
const forbidden = path.join(project, 'data').toLowerCase()
if (actual === forbidden || actual.startsWith(forbidden + path.sep)) throw new Error('禁止测试使用实际数据库')
