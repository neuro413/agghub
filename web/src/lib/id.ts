/** 普通内网 HTTP 也可使用的 UUID v4。 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function uniqueIds<T extends { id: string }>(items: T[], existing: string[] = []): T[] {
  const ids = new Set(existing)
  return items.map(item => {
    let id = item.id
    if (!id || ids.has(id)) id = newId()
    ids.add(id)
    return { ...item, id }
  })
}
