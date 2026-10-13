/** 模型名模式：精确名或含 * 的通配符（* 匹配任意长度字符），大小写敏感。Key 模型白名单与倍率表共用。 */
export function matchesPattern(pattern: string, model: string): boolean {
  if (!pattern.includes('*')) return pattern === model
  const parts = pattern.split('*')
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (!model.startsWith(first) || model.length < first.length + last.length || !model.endsWith(last)) return false
  let pos = first.length
  const end = model.length - last.length
  for (const middle of parts.slice(1, -1)) {
    const found = model.indexOf(middle, pos)
    if (found < 0 || found + middle.length > end) return false
    pos = found + middle.length
  }
  return true
}

/** 模式的具体程度：非通配字符数；精确名额外加权，保证总排在通配符之前 */
export function patternSpecificity(pattern: string): number {
  const literal = pattern.replace(/\*/g, '').length
  return pattern.includes('*') ? literal : literal + 1_000_000
}
