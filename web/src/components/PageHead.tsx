import type { ReactNode } from 'react'

/** 页头：标题 + 副标题 + 右侧操作区；sticky 时吸顶（设置页用，长页面滚动时保存按钮始终可见） */
export function PageHead({ title, sub, actions, sticky }: { title: string; sub?: ReactNode; actions?: ReactNode; sticky?: boolean }) {
  return (
    <div className={`ah-page-head${sticky ? ' is-sticky' : ''}`}>
      <div className="ah-page-head-text">
        <h1 className="ah-page-title">{title}</h1>
        {sub != null && sub !== '' && <div className="ah-page-sub">{sub}</div>}
      </div>
      {actions && <div className="ah-page-actions">{actions}</div>}
    </div>
  )
}
