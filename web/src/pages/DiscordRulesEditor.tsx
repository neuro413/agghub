import { Fragment, useState } from 'react'
import { Button, IconButton } from '../components/Button'
import { Input } from '../components/Form'
import { IconPlus, IconTrash } from '../components/Icons'
import type { DiscordGuildCondition, DiscordRuleGroup } from '../types'

// ── Discord 登录门槛编辑器：满足任一规则组即可登录，组内每个服务器条件都要满足 ──

const newCondition = (): DiscordGuildCondition => ({ guild_id: '', all_roles: [], any_roles: [], deny_roles: [] })

/** 身份组 ID 输入：逗号（含全角）、空格或换行分隔 */
const parseIds = (text: string) => text.split(/[\s,，]+/).filter(Boolean)
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i])

const ROLE_FIELDS = [
  ['all_roles', '必须全部拥有'],
  ['any_roles', '至少拥有一个'],
  ['deny_roles', '拥有即拒绝'],
] as const

/** 保留正在输入的原文（如末尾的逗号），只把解析出的 ID 交给上层；外部改值（删除条目、保存后去重）时按新值显示 */
function IdsInput({ value, onChange, label }: { value: string[]; onChange: (ids: string[]) => void; label: string }) {
  const [text, setText] = useState(() => value.join(', '))
  const shown = sameIds(parseIds(text), value) ? text : value.join(', ')
  return (
    <Input
      aria-label={label}
      value={shown}
      onChange={(e) => {
        setText(e.target.value)
        onChange(parseIds(e.target.value))
      }}
      placeholder="留空不检查"
      autoComplete="off"
      spellCheck={false}
    />
  )
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: DiscordGuildCondition
  onChange: (condition: DiscordGuildCondition) => void
  /** 组内只剩一个条件时不能删，要删就删整个规则组 */
  onRemove?: () => void
}) {
  return (
    <div className="ah-dc-cond">
      <span className="ah-dc-label">服务器 ID</span>
      <div className="ah-dc-guild">
        <Input
          aria-label="服务器 ID"
          value={condition.guild_id}
          onChange={(e) => onChange({ ...condition, guild_id: e.target.value })}
          placeholder="123456789012345678"
          autoComplete="off"
          spellCheck={false}
        />
        {onRemove && (
          <IconButton title="删除服务器条件" danger onClick={onRemove}>
            <IconTrash size={14} />
          </IconButton>
        )}
      </div>
      {ROLE_FIELDS.map(([key, label]) => (
        <Fragment key={key}>
          <span className="ah-dc-label">{label}</span>
          <IdsInput label={label} value={condition[key]} onChange={(ids) => onChange({ ...condition, [key]: ids })} />
        </Fragment>
      ))}
    </div>
  )
}

export function DiscordRulesEditor({ rules, onChange }: { rules: DiscordRuleGroup[]; onChange: (rules: DiscordRuleGroup[]) => void }) {
  const updateGroup = (i: number, conditions: DiscordGuildCondition[]) => onChange(rules.map((g, j) => (j === i ? { conditions } : g)))
  return (
    <div className="ah-dc-rules">
      {rules.map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="ah-dc-or">或</div>}
          <div className="ah-dc-group">
            <div className="ah-dc-group-head">
              <span className="ah-dc-group-title">规则组 {i + 1}</span>
              <span className="ah-mini ah-faint">以下服务器条件需全部满足</span>
              <IconButton title="删除规则组" danger onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                <IconTrash size={15} />
              </IconButton>
            </div>
            {group.conditions.map((condition, j) => (
              <ConditionRow
                key={j}
                condition={condition}
                onChange={(c) => updateGroup(i, group.conditions.map((old, k) => (k === j ? c : old)))}
                onRemove={group.conditions.length > 1 ? () => updateGroup(i, group.conditions.filter((_, k) => k !== j)) : undefined}
              />
            ))}
            <div>
              <Button variant="soft" size="sm" icon={<IconPlus size={15} />} onClick={() => updateGroup(i, [...group.conditions, newCondition()])}>
                添加服务器条件
              </Button>
            </div>
          </div>
        </Fragment>
      ))}
      {!rules.length && <div className="ah-mini ah-faint">未设置门槛，任何 Discord 账号都能登录</div>}
      <div>
        <Button variant="soft" size="sm" icon={<IconPlus size={15} />} onClick={() => onChange([...rules, { conditions: [newCondition()] }])}>
          {rules.length ? '添加备选规则组' : '添加规则组'}
        </Button>
      </div>
    </div>
  )
}
