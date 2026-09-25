export const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
export const MAX_ARRAY_INDEX = 10000

export function isArrayIndex(segment: string): boolean {
  return /^(0|[1-9]\d*)$/.test(segment) && Number(segment) <= MAX_ARRAY_INDEX
}

/** 路径与 JSON 数据分开处理，schema 中同名的数据字段可继续原样保存。 */
export function parseSafePath(key: unknown): string[] {
  if (typeof key !== 'string' || !key.trim()) throw new Error('参数路径不能为空')
  const segments = key.split('.').map(s => s.trim())
  if (segments.length > 64 || segments.some(s => !s || s.length > 256)) throw new Error('参数路径含空段或超过长度限制')
  for (const segment of segments) {
    if (DANGEROUS_KEYS.has(segment)) throw new Error(`禁止访问原型路径段 ${segment}`)
    if (/^\d+$/.test(segment) && !isArrayIndex(segment)) throw new Error(`数组下标必须为 0～${MAX_ARRAY_INDEX} 的规范整数`)
  }
  return segments
}
