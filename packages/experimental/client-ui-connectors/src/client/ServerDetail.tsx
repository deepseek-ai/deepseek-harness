/**
 * A custom MCP server's page: why it did not start, its account, form, connection test, and removal, with the risk
 * confirmation of a local command the save starts.
 */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, IconPlusOutlineRegular, Input, Modal, RiskConfirmation, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ProbeState } from './custom-servers-store.ts'
import type { ConnectorsLocaleKey } from './locales.ts'
import { validateDraft, type AuthKind, type DraftRow, type ServerDraft, type Transport } from '../server-form.ts'
import type { CustomServerStatus } from '../types.ts'
import css from './CustomServers.module.css'

type T = Translate<ConnectorsLocaleKey>

function probeText(probe: ProbeState, t: T): string {
  switch (probe.status) {
    case 'running': return t('custom.probing')
    case 'passed': return t('custom.probePassed', { count: String(probe.tools) })
    case 'failed': return t('custom.probeFailed', { message: probe.message })
  }
}

/**
 * Keys that stay with the rows of an editable list while rows are added or removed. `add` and `remove` change the list
 * and its keys together; nothing else may change the list's length.
 */
function useRowKeys<Row>(rows: readonly Row[], onChange: (rows: readonly Row[]) => void): {
  readonly keys: readonly number[]
  readonly add: (row: Row) => void
  readonly remove: (index: number) => void
} {
  const [state, setState] = useState(() => ({ next: rows.length, keys: rows.map((_, index) => index) }))
  return {
    keys: state.keys,
    add: (row) => {
      setState(({ next, keys }) => ({ next: next + 1, keys: [...keys, next] }))
      onChange([...rows, row])
    },
    remove: (index) => {
      setState(({ next, keys }) => ({ next, keys: keys.filter((_, at) => at !== index) }))
      onChange(rows.filter((_, at) => at !== index))
    },
  }
}

function Rows({ label, addLabel, rows, t, onChange }: {
  readonly label: string
  readonly addLabel: string
  readonly rows: readonly DraftRow[]
  readonly t: T
  readonly onChange: (rows: readonly DraftRow[]) => void
}): ReactNode {
  const { keys, add, remove } = useRowKeys(rows, onChange)
  const update = (index: number, change: Partial<DraftRow>): void => {
    onChange(rows.map((row, at) => at === index ? { ...row, ...change } : row))
  }
  return (
    <fieldset className={css.rows}>
      <legend className={css.label}>{label}</legend>
      {rows.map((row, index) => (
        <div key={keys[index]} className={css.row}>
          <Input aria-label={t('form.rowKey')} placeholder={t('form.rowKey')} value={row.key}
            onChange={(event) => { update(index, { key: event.target.value }) }} />
          <Input aria-label={t('form.rowValue')} type={row.secret ? 'password' : 'text'} value={row.value}
            placeholder={row.secret && row.ref !== undefined ? t('form.storedSecret') : t('form.rowValue')}
            onChange={(event) => { update(index, { value: event.target.value }) }} />
          <Checkbox checked={row.secret} label={t('form.rowSecret')} onChange={(secret) => { update(index, { secret, value: '', ref: undefined }) }} />
          <Button variant="ghost" size="sm" aria-label={t('form.removeRow')} onClick={() => { remove(index) }}>×</Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className={css.add} icon={<IconPlusOutlineRegular size={13} />}
        onClick={() => { add({ key: '', value: '', secret: false }) }}>
        {addLabel}
      </Button>
    </fieldset>
  )
}

function Args({ args, t, onChange }: {
  readonly args: readonly string[]
  readonly t: T
  readonly onChange: (args: readonly string[]) => void
}): ReactNode {
  const { keys, add, remove } = useRowKeys(args, onChange)
  return (
    <fieldset className={css.rows}>
      <legend className={css.label}>{t('form.args')}</legend>
      {args.map((arg, index) => (
        <div key={keys[index]} className={css.argRow}>
          <Input aria-label={t('form.argLabel', { index: String(index + 1) })} value={arg}
            onChange={(event) => { onChange(args.map((value, at) => at === index ? event.target.value : value)) }} />
          <Button variant="ghost" size="sm" aria-label={t('form.removeRow')} onClick={() => { remove(index) }}>×</Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className={css.add} icon={<IconPlusOutlineRegular size={13} />} onClick={() => { add('') }}>
        {t('form.addArg')}
      </Button>
    </fieldset>
  )
}

/**
 * Edit a draft on the server's page; problems show after the first save attempt. A save starts a new server and a
 * server that is switched on, so saving a local command asks for the risk confirmation unless the server is switched
 * off. The connection test reads the saved entry, so it waits until the draft has no changes. The removal asks first.
 * @param props - the initial draft, the saved server's status and entry (undefined for a new server), the other
 * servers' names, whether a save runs, the saved server's account section and latest test, and the callbacks; only a
 * server that is on has a test, and a new or inherited one has no removal.
 * @returns the page and its confirmations.
 */
export function ServerDetail({ initial, status, entry, taken, saving, t, account, probe, onProbe, onDelete, onSave }: {
  readonly initial: ServerDraft
  readonly status: CustomServerStatus | undefined
  readonly entry: Readonly<Record<string, JsonValue>> | undefined
  readonly taken: readonly string[]
  readonly saving: boolean
  readonly t: T
  readonly account: ReactNode
  readonly probe: ProbeState | undefined
  readonly onProbe: (() => void) | undefined
  readonly onDelete: (() => void) | undefined
  readonly onSave: (draft: ServerDraft) => void
}): ReactNode {
  const [draft, setDraft] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [removing, setRemoving] = useState(false)
  const isNew = status === undefined
  const problems = validateDraft(draft, taken, entry)
  const changed = JSON.stringify(draft) !== JSON.stringify(initial)
  const set = (change: Partial<ServerDraft>): void => { setDraft({ ...draft, ...change }) }
  const submit = (): void => {
    setSubmitted(true)
    if (problems.length > 0) return
    if (draft.transport === 'stdio' && status?.state !== 'off') {
      setAcknowledged(false)
      setConfirming(true)
      return
    }
    onSave(draft)
  }
  const field = (
    label: ConnectorsLocaleKey, value: string, onChange: (value: string) => void,
    extra: { disabled?: boolean; type?: string; placeholder?: string } = {},
  ): ReactNode => (
    <label className={css.field}>
      <span className={css.label}>{t(label)}</span>
      <Input value={value} onChange={(event) => { onChange(event.target.value) }} {...extra} />
    </label>
  )
  return (
    <div className={css.detail} data-custom-server-page={isNew ? '' : initial.name}>
      <h3 className={css.detailTitle}>{isNew ? t('form.addTitle') : t('form.editTitle', { name: initial.name })}</h3>
      {status?.state === 'failed' ? <p className={css.failure}>{t('custom.failed', { message: status.error })}</p> : null}
      {account}
      <div className={css.form}>
        {field('form.name', draft.name, (name) => { set({ name }) }, { disabled: !isNew })}
        <div className={css.field}>
          <span className={css.label}>{t('form.transport')}</span>
          <SegmentedControl<Transport> id="connectors-server-transport" className={css.segments} label={t('form.transport')}
            value={draft.transport} options={[{ value: 'stdio', label: t('form.stdio') }, { value: 'streamable-http', label: t('form.remote') }]}
            onChange={(transport) => { set({ transport }) }} />
        </div>
        {draft.transport === 'stdio'
          ? (
            <>
              {field('form.command', draft.command, (command) => { set({ command }) })}
              <Args args={draft.args} t={t} onChange={(args) => { set({ args }) }} />
              <Rows label={t('form.env')} addLabel={t('form.addEnv')} rows={draft.env} t={t} onChange={(env) => { set({ env }) }} />
              {field('form.cwd', draft.cwd, (cwd) => { set({ cwd }) })}
            </>
          )
          : (
            <>
              {field('form.url', draft.url, (url) => { set({ url }) }, { placeholder: t('form.urlPlaceholder') })}
              <div className={css.field}>
                <span className={css.label}>{t('form.auth')}</span>
                <SegmentedControl<AuthKind> id="connectors-server-auth" className={css.segments} label={t('form.auth')} value={draft.auth}
                  options={[{ value: 'none', label: t('form.authNone') }, { value: 'token', label: t('form.authToken') }, { value: 'oauth', label: t('form.authOAuth') }]}
                  onChange={(auth) => { set({ auth }) }} />
              </div>
              {draft.auth === 'token'
                ? field('form.token', draft.token, (token) => { set({ token }) },
                  { type: 'password', ...draft.tokenRef === undefined ? {} : { placeholder: t('form.storedSecret') } })
                : null}
              {draft.auth === 'oauth'
                ? (
                  <>
                    {field('form.clientId', draft.clientId, (clientId) => { set({ clientId }) })}
                    {field('form.scope', draft.scope, (scope) => { set({ scope }) })}
                  </>
                )
                : null}
              <Rows label={t('form.headers')} addLabel={t('form.addHeader')} rows={draft.headers} t={t} onChange={(headers) => { set({ headers }) }} />
            </>
          )}
        {submitted && problems.length > 0
          ? <ul className={css.problems} role="alert">{problems.map(problem => <li key={problem}>{t(`problem.${problem}`)}</li>)}</ul>
          : null}
      </div>
      <div className={css.footer}>
        {onDelete === undefined ? null : <Button variant="ghost" onClick={() => { setRemoving(true) }}>{t('custom.remove')}</Button>}
        <div className={css.footerEnd}>
          {probe === undefined ? null : <span className={css.probe}>{probeText(probe, t)}</span>}
          {onProbe === undefined
            ? null
            : <Button variant="outline" disabled={changed || probe?.status === 'running'} onClick={onProbe}>{t('custom.probe')}</Button>}
          <Button variant="primary" disabled={saving} onClick={submit}>{t('form.save')}</Button>
        </div>
      </div>
      <RiskConfirmation open={confirming} title={t('stdio.title')} description={t('stdio.body', { command: draft.command.trim() })}
        acknowledgeLabel={t('stdio.acknowledge')} cancelLabel={t('form.cancel')} closeLabel={t('close')} confirmLabel={t('stdio.confirm')}
        acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} onCancel={() => { setConfirming(false) }}
        onConfirm={() => { setConfirming(false); onSave(draft) }} />
      {onDelete === undefined || !removing
        ? null
        : (
          <Modal open title={t('custom.removeTitle', { name: initial.name })} closeLabel={t('close')} onClose={() => { setRemoving(false) }}
            footer={<>
              <Button variant="ghost" onClick={() => { setRemoving(false) }}>{t('form.cancel')}</Button>
              <Button variant="primary" data-modal-autofocus onClick={() => { setRemoving(false); onDelete() }}>{t('custom.remove')}</Button>
            </>}>
            <p>{t('custom.removeBody')}</p>
          </Modal>
        )}
    </div>
  )
}
