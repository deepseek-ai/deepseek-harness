// JsonBlock: collapsible JSON block (conversation side; independent from the RPC panel's PayloadJson to avoid cross-panel coupling).

import { useMemo, useState } from 'react'
import css from './JsonBlock.module.css'

const MAX_CHARS = 20_000

export function JsonBlock({ label, payload, defaultOpen = false, truncatedLabel }: {
  label: string
  payload: unknown
  defaultOpen?: boolean
  /** Footer appended when the body exceeds the char cap, given the full length (this package is cordis-free, so copy arrives via props). */
  truncatedLabel: (total: number) => string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const body = useMemo(() => {
    if (!open) return ''
    let s: string
    try {
      // lib typing hides stringify's undefined arm (undefined/function/symbol payloads).
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      s = JSON.stringify(payload, null, 2) ?? String(payload)
    } catch {
      s = String(payload)
    }
    return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n${truncatedLabel(s.length)}` : s
  }, [open, payload, truncatedLabel])
  return (
    <div className={css.root}>
      <button type="button" className={css.toggle} onClick={() => { setOpen(v => !v) }}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <pre className={css.body}>{body}</pre>}
    </div>
  )
}
