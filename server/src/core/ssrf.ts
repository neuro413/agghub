// 【签名桩】由「安全加固」任务实现；导出名称和参数类型不得修改，imageResolver.ts 按此调用。

/** IP 是否属于禁止公网调用方访问的地址（回环、私有、链路本地、CGNAT、组播、未指定、IPv6 ULA / 链路本地、IPv4 映射地址按内部 IPv4 判断） */
export function isBlockedAddress(_ip: string): boolean {
  return false
}
