export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={`ah-toggle${checked ? ' is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    />
  )
}
