// 按行对比两段文本（正则包试运行的改写前后对比用）

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/** 中间差异段的行数乘积超过这个值时不做逐行对齐，直接整段显示为「删除 + 新增」 */
const MAX_CELLS = 6_000_000

export function diffLines(a: string[], b: string[]): DiffLine[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ type: 'same', text }))
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const n = x.length
  const m = y.length
  if (n * m > MAX_CELLS) {
    for (const text of x) out.push({ type: 'del', text })
    for (const text of y) out.push({ type: 'add', text })
  } else if (n || m) {
    // 最长公共子序列：lcs[i][j] = x[i..] 与 y[j..] 的公共行数
    const width = m + 1
    const lcs = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = x[i] === y[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push({ type: 'same', text: x[i] })
        i++
        j++
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) out.push({ type: 'del', text: x[i++] })
      else out.push({ type: 'add', text: y[j++] })
    }
    while (i < n) out.push({ type: 'del', text: x[i++] })
    while (j < m) out.push({ type: 'add', text: y[j++] })
  }
  for (const text of a.slice(a.length - tail)) out.push({ type: 'same', text })
  return out
}

export type DiffRow = DiffLine | { type: 'gap'; count: number }

/** 只保留改动行及其前后 context 行，其余未改动的行折叠成一条间隔 */
export function collapseDiff(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Uint8Array(lines.length)
  lines.forEach((line, index) => {
    if (line.type === 'same') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = 1
  })
  const rows: DiffRow[] = []
  let hidden = 0
  // 折叠掉的行太少时直接显示，一条「2 行未改动」并不比这两行本身短
  const flush = (end: number) => {
    if (hidden > 2) rows.push({ type: 'gap', count: hidden })
    else for (let k = end - hidden; k < end; k++) rows.push(lines[k])
    hidden = 0
  }
  lines.forEach((line, index) => {
    if (keep[index]) {
      flush(index)
      rows.push(line)
    } else hidden++
  })
  flush(lines.length)
  return rows
}
