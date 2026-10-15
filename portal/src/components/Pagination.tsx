import { Button } from './ui'
import { IconChevronLeft, IconChevronRight } from './Icons'

/** 页码序列：首尾 + 当前页前后各一页，其余折叠为省略号 */
function pageList(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const set = new Set([1, pages, page - 1, page, page + 1].filter(p => p >= 1 && p <= pages))
  const sorted = [...set].sort((a, b) => a - b)
  const out: (number | '…')[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('…')
    out.push(p)
  })
  return out
}

export function Pagination({ page, size, total, onPage, onSize }: {
  page: number
  size: number
  total: number
  onPage: (page: number) => void
  onSize: (size: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / size))
  return (
    <div className="pt-pagination">
      <span className="total">共 <span className="mono">{total}</span> 条</span>
      <select className="pt-input" value={size} onChange={e => onSize(Number(e.target.value))} aria-label="每页条数">
        {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n} 条/页</option>)}
      </select>
      <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="上一页"><IconChevronLeft /></Button>
      {pageList(page, pages).map((p, i) =>
        p === '…'
          ? <span key={`e${i}`} className="pt-page-ellipsis">…</span>
          : <Button key={p} variant={p === page ? 'default' : 'outline'} className={`pt-page-btn${p === page ? ' is-current' : ''}`} onClick={() => onPage(p)}>{p}</Button>,
      )}
      <Button variant="outline" size="icon" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="下一页"><IconChevronRight /></Button>
    </div>
  )
}
