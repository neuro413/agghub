import { useMemo } from 'react'
import type { ReactNode } from 'react'

// 通知与公告用的 Markdown 子集：标题、段落、换行、粗体、斜体、删除线、行内代码、代码块、链接、自动链接、
// 有序/无序列表、引用、分割线。全部生成 React 元素，原始 HTML 按文本显示；链接只放行 http(s) / mailto / 站内路径

const ROOT_CLASS = 'ah-md'
const HEADINGS = ['h3', 'h4', 'h5'] as const

// 依次为：行内代码、粗体、删除线、斜体（只认星号，避免把 snake_case 模型名当成斜体）、链接、裸网址、换行
const INLINE = /`([^`\n]+)`|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|\*([^*\s](?:[^*\n]*[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+)|\n/g

function safeHref(url: string): string | null {
  if (/^(https?:|mailto:)/i.test(url)) return url
  if ((url.startsWith('/') && !url.startsWith('//')) || url.startsWith('#')) return url
  return null
}

function link(href: string, children: ReactNode, key: string): ReactNode {
  const external = /^(https?:|mailto:)/i.test(href)
  return <a key={key} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const start = m.index!
    if (start > last) out.push(text.slice(last, start))
    const k = `${key}-${n++}`
    let end = start + m[0].length
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>)
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k)}</strong>)
    else if (m[3] !== undefined) out.push(<del key={k}>{inline(m[3], k)}</del>)
    else if (m[4] !== undefined) out.push(<em key={k}>{inline(m[4], k)}</em>)
    else if (m[5] !== undefined) {
      const href = safeHref(m[6])
      out.push(href ? link(href, inline(m[5], k), k) : <span key={k}>{inline(m[5], k)}</span>)
    } else if (m[7] !== undefined) {
      // 网址末尾的标点通常属于句子
      const url = m[7].replace(/[.,;:!?'()[\]]+$/, '')
      if (/^https?:\/\/./i.test(url)) {
        out.push(link(url, url, k))
        end = start + url.length
      } else out.push(m[7])
    } else out.push(<br key={k} />)
    last = end
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function listMarker(line: string): { ordered: boolean; start: number; text: string } | null {
  const m = line.match(/^\s{0,3}(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/)
  return m ? { ordered: !m[1], start: m[2] ? Number(m[2]) : 1, text: m[3] } : null
}

const isFence = (line: string) => /^\s*(```|~~~)/.test(line)
const isHeading = (line: string) => /^#{1,6}\s/.test(line)
const isRule = (line: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
const isQuote = (line: string) => /^\s*>/.test(line)
const startsBlock = (line: string) => isFence(line) || isHeading(line) || isRule(line) || isQuote(line) || !!listMarker(line)

function blocks(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const k = `${key}.${out.length}`
    if (!line.trim()) {
      i++
      continue
    }
    if (isFence(line)) {
      const fence = line.trim().slice(0, 3)
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++])
      i++ // 跳过结束标记；没有结束标记时一直到末尾
      out.push(<pre key={k}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      const Tag = HEADINGS[Math.min(heading[1].length, HEADINGS.length) - 1]
      out.push(<Tag key={k}>{inline(heading[2], k)}</Tag>)
      i++
      continue
    }
    if (isRule(line)) {
      out.push(<hr key={k} />)
      i++
      continue
    }
    if (isQuote(line)) {
      const body: string[] = []
      while (i < lines.length && isQuote(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(<blockquote key={k}>{blocks(body, k)}</blockquote>)
      continue
    }
    const list = listMarker(line)
    if (list) {
      const items: string[] = []
      while (i < lines.length) {
        const marker = listMarker(lines[i])
        if (marker && marker.ordered === list.ordered) items.push(marker.text)
        else if (!marker && /^\s+\S/.test(lines[i])) items[items.length - 1] += '\n' + lines[i].trim() // 缩进的续行
        else break
        i++
      }
      const children = items.map((text, n) => <li key={n}>{inline(text, `${k}.${n}`)}</li>)
      out.push(list.ordered ? <ol key={k} start={list.start}>{children}</ol> : <ul key={k}>{children}</ul>)
      continue
    }
    // 段落：到空行或下一个块为止，段内换行保留
    const body: string[] = []
    do {
      body.push(lines[i++])
    } while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]))
    out.push(<p key={k}>{inline(body.join('\n'), k)}</p>)
  }
  return out
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  const nodes = useMemo(() => blocks(content.replace(/\r\n?/g, '\n').split('\n'), 'md'), [content])
  return <div className={className ? `${ROOT_CLASS} ${className}` : ROOT_CLASS}>{nodes}</div>
}
