/** A custom MCP server's page: its account, form, connection test, and removal, with an enabled local command's risk confirmation. */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, IconPlusOutlineRegular, Input, RiskConfirmation, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProbeState } from './custom-servers-store.ts'
import type { ConnectorsLocaleKey } from './locales.ts'
import { validateDraft, type AuthKind, type DraftRow, type ServerDraft, type Transport } from '../server-form.ts'
import css from './CustomServers.module.css'

type T = Translate<ConnectorsLocaleKey>

function probeText(probe: ProbeState, t: T): string {
  switch (probe.status) {
    case 'running': return t('custom.probing')
    case 'passed': return t('custom.probePassed', { count: String(probe.tools) })
    case 'failed': return t('custom.probeFailed', { message: probe.message })
  }
}

function Rows({ label, addLabel, rows, t, onChange }: {
  readonly label: string
  readonly addLabel: string
  readonly rows: readonly DraftRow[]
  readonly t: T
  readonly onChange: (rows: readonly DraftRow[]) => void
}): ReactNode {
  const update = (index: number, change: Partial<DraftRow>): void => {
    onChange(rows.map((row, at) => at === index ? { ...row, ...change } : row))
  }
  return (
    <fieldset className={css.rows}>
      <legend className={css.label}>{label}</legend>
      {rows.map((row, index) => (
        <div key={index} className={css.row}>
          <Input aria-label={t('form.rowKey')} placeholder={t('form.rowKey')} value={row.key}
            onChange={(event) => { update(index, { key: event.target.value }) }} />
          <Input aria-label={t('form.rowValue')} type={row.secret ? 'password' : 'text'} value={row.value}
            placeholder={row.secret && row.ref !== undefined ? t('form.storedSecret') : t('form.rowValue')}
            onChange={(event) => { update(index, { value: event.target.value }) }} />
          <Checkbox checked={row.secret} label={t('form.rowSecret')} onChange={(secret) => { update(index, { secret, value: '', ref: undefined }) }} />
          <Button variant="ghost" size="sm" aria-label={t('form.removeRow')} onClick={() => { onChange(rows.filter((_, at) => at !== index)) }}>×</Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className={css.add} icon={<IconPlusOutlineRegular size={13} />} onClick={() => { onChange([...rows, { key: '', value: '', secret: false }]) }}>{addLabel}</Button>
    </fieldset>
  )
}

function Args({ args, t, onChange }: {
  readonly args: readonly string[]
  readonly t: T
  readonly onChange: (args: readonly string[]) => void
}): ReactNode {
  return (
    <fieldset className={css.rows}>
      <legend className={css.label}>{t('form.args')}</legend>
      {args.map((arg, index) => (
        <div key={index} className={css.argRow}>
          <Input aria-label={t('form.argLabel', { index: String(index + 1) })} value={arg}
            onChange={(event) => { onChange(args.map((value, at) => at === index ? event.target.value : value)) }} />
          <Button variant="ghost" size="sm" aria-label={t('form.removeRow')} onClick={() => { onChange(args.filter((_, at) => at !== index)) }}>×</Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className={css.add} icon={<IconPlusOutlineRegular size={13} />} onClick={() => { onChange([...args, '']) }}>{t('form.addArg')}</Button>
    </fieldset>
  )
}

/**
 * Edit a draft on the server's page; problems show after the first save attempt, and an enabled local command is
 * confirmed before saving. The connection test reads the saved entry, so it waits until the draft has no changes.
 * @param props - the initial draft, whether it is new, the other servers' names, whether a save runs, the saved
 * server's account section and latest test, and the callbacks; a new server has no test, and a new or inherited one no
 * removal.
 * @returns the page and its confirmation.
 */
export function ServerDetail({ initial, isNew, taken, saving, t, account, probe, onProbe, onDelete, onSave }: {
  readonly initial: ServerDraft
  readonly isNew: boolean
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
  const problems = validateDraft(draft, isNew ? taken : taken.filter(name => name !== initial.name))
  const changed = JSON.stringify(draft) !== JSON.stringify(initial)
  const set = (change: Partial<ServerDraft>): void => { setDraft({ ...draft, ...change }) }
  const submit = (): void => {
    setSubmitted(true)
    if (problems.length > 0) return
    if (draft.transport === 'stdio' && draft.enabled) {
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
        {onDelete === undefined ? null : <Button variant="ghost" onClick={onDelete}>{t('custom.remove')}</Button>}
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
    </div>
  )
}
