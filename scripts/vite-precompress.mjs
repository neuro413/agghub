/** 构建期预压缩：对 dist/assets 下的静态资源生成 .gz 与 .br 副本。 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const TARGET = /\.(js|css|svg|json|txt|wasm)$/
const MIN_SIZE = 1024

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(dir, entry.name)
    return entry.isDirectory() ? collect(name) : [name]
  })
}

/** @returns {import('vite').Plugin} */
export function precompress() {
  let outDir = ''

  return {
    name: 'agghub-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const assetsDir = path.join(outDir, 'assets')
      if (!fs.existsSync(assetsDir)) return

      let count = 0
      for (const file of collect(assetsDir)) {
        if (!TARGET.test(file) || /\.(gz|br)$/.test(file)) continue
        const buf = fs.readFileSync(file)
        if (buf.length < MIN_SIZE) continue
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync(buf, { level: 9 }))
        fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(buf, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
          },
        }))
        count++
      }
      console.log(`[agghub-precompress] 已预压缩 ${count} 个文件`)
    },
  }
}
