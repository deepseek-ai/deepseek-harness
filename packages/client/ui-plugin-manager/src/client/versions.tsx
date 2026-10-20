/**
 * A registry bundle's Versions section and its update dialog. The section summarizes the Host's version check in one
 * row and unfolds into the newer versions; the dialog confirms one update, follows the Host's steps, and reports how
 * the update ended, including the reinstallation of the removed version after a failed installation.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type {
  IncompatiblePlugin, PluginUpdateResult, PluginUpdateStep, PluginVersion, PluginVersionList, Registry, RegistryAttempt,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, Checkbox, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular,
  IconDownloadOutlineRegular, IconRefreshOutlineRegular, IconWarningOutlineRegular, Modal, StateDot, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { installable, updateCandidate, type PackageView, type UpdateState, type VersionCheck } from './manager-store.ts'
import { managementText, registryText, restartText, type Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/** The tone of a summary or outcome glyph. */
type Tone = 'info' | 'success' | 'warn' | 'error' | 'neutral'

/** Two digits of a date or time field. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** A version's local publication day as `YYYY-MM-DD`, which reads the same in every UI language. */
function publishedDate(version: PluginVersion): string | undefined {
  if (version.publishedAt === undefined) return undefined
  const day = new Date(version.publishedAt)
  return `${String(day.getFullYear())}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** The local time of day a check arrived, as 24-hour `HH:MM`. */
function checkedTime(checkedAt: number): string {
  const time = new Date(checkedAt)
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/** The registry by name: npm's own and the mainland mirror by theirs, pnpm's own configuration as the default, any other by host. */
function registryName(registry: Registry, t: Translate): string {
  return registryText(registry, t, null).name
}

/** The DSH requirements an incompatible version states, as one phrase: `engines.dsh` or DSH peer ranges. */
function peersText(incompatible: IncompatiblePlugin): string {
  return Object.entries(incompatible.requirements).map(([name, range]) => `${name} ${range}`).join(', ')
}

const PROBLEM_KEYS = {
  'network': 'versionsProblemNetwork',
  'not-found': 'versionsProblemNotFound',
  'unknown': 'versionsProblemUnknown',
} as const

function Glyph({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }): ReactNode {
  return <span className={css.versionGlyph} data-tone={tone} aria-hidden="true">{children}</span>
}

/** The summary row's glyph, title, the line under it, and how many newer versions it unfolds into. */
interface Summary {
  tone: Tone
  glyph: ReactNode
  title: string
  sub?: string
  newer: number
}

function summaryOf(check: VersionCheck | undefined, t: Translate): Summary {
  if (check === undefined || check.phase === 'checking') {
    return { tone: 'neutral', glyph: <StateDot state="ongoing" size={14} />, title: t('versionsChecking'), newer: 0 }
  }
  const { list } = check
  if (list.status === 'refused') {
    const failed = list.attempts.at(-1)
    return {
      tone: 'error', glyph: <IconCloseOutlineRegular size={14} />,
      title: t(list.problem === 'network' ? 'versionsFailedNetwork' : 'versionsFailedOther'),
      // A check the transport lost asked no registry the page knows of; its words stand alone.
      sub: failed?.problem === undefined ? list.reason : `${registryName(failed.registry, t)} ${t(PROBLEM_KEYS[failed.problem])}`,
      newer: 0,
    }
  }
  const candidate = updateCandidate(list)
  if (candidate !== undefined) {
    const date = publishedDate(candidate)
    return {
      tone: 'info', glyph: <IconDownloadOutlineRegular size={14} />, title: t('versionsAvailable', { version: candidate.version }),
      ...date === undefined ? {} : { sub: t('versionsPublished', { date }) }, newer: list.versions.length,
    }
  }
  if (list.versions.length === 0) {
    return { tone: 'success', glyph: <IconCheckOutlineRegular size={14} />, title: t('versionsLatest'), sub: t('versionsCheckedAt', { time: checkedTime(check.checkedAt) }), newer: 0 }
  }
  const blocked = list.versions.find(version => !version.prerelease && version.incompatible !== undefined)?.incompatible
  return blocked === undefined
    ? { tone: 'warn', glyph: <IconWarningOutlineRegular size={14} />, title: t('versionsNoneInstallable'), sub: t('versionsNoneInstallableDetail'), newer: list.versions.length }
    : {
      tone: 'warn', glyph: <IconWarningOutlineRegular size={14} />, title: t('versionsBlocked'), newer: list.versions.length,
      sub: t('versionsBlockedDetail', { version: blocked.version, peers: peersText(blocked), runtime: blocked.runtimeVersion }),
    }
}

/** One version row: its number and tags, why it cannot or should not be installed, its date, and its update action. */
function VersionRow({ version, installed, t, busy, onUpdate }: {
  readonly version: PluginVersion | { readonly version: string; readonly installedRow: true }
  readonly installed: string
  readonly t: Translate
  readonly busy: boolean
  readonly onUpdate: (version: string) => void
}): ReactNode {
  if ('installedRow' in version) {
    return (
      <li className={css.versionRow} data-plugin-version={version.version}>
        <div className={css.versionMain}>
          <div className={css.versionTitle}>
            <span className={css.versionNumber}>{version.version}</span>
            <Tag className={css.statusTag} tone="neutral">{t('versionsInstalledTag')}</Tag>
          </div>
        </div>
      </li>
    )
  }
  const usable = installable(version)
  const note = version.incompatible !== undefined ? t('versionsNeedsDsh', { peers: peersText(version.incompatible) })
    : !version.bundle ? t('versionsNotBundle') : version.deprecated
  const date = publishedDate(version)
  return (
    <li className={css.versionRow} data-plugin-version={version.version} {...usable ? {} : { 'data-blocked': '' }}>
      <div className={css.versionMain}>
        <div className={css.versionTitle}>
          <span className={css.versionNumber}>{version.version}</span>
          {version.tags.map(tag => <Tag key={tag} className={css.statusTag} tone="outline">{tag}</Tag>)}
          {version.prerelease ? <Tag className={css.statusTag} tone="outline">{t('versionsPrereleaseTag')}</Tag> : null}
          {version.deprecated === undefined ? null : <Tag className={css.statusTag} tone="warning">{t('versionsDeprecatedTag')}</Tag>}
        </div>
        {note === undefined ? null : <span className={css.versionNote} data-tone={usable && version.deprecated !== undefined ? 'warn' : undefined}>{note}</span>}
      </div>
      {date === undefined ? null : <span className={css.versionDate}>{date}</span>}
      <span className={css.versionAction}>
        {usable && version.version !== installed ? (
          <Button
            variant={version.deprecated === undefined && !version.prerelease ? 'outline' : 'ghost'}
            size="sm"
            disabled={busy}
            aria-label={t('versionsUpdateLabel', { version: version.version })}
            onClick={() => { onUpdate(version.version) }}
          >
            {t('update')}
          </Button>
        ) : null}
      </span>
    </li>
  )
}

/** The registries a refused check asked, each with what it answered. */
function AttemptRows({ attempts, t }: { readonly attempts: readonly RegistryAttempt[]; readonly t: Translate }): ReactNode {
  return (
    <ul className={css.versionRows}>
      {attempts.map((attempt, index) => (
        <li key={`${String(attempt.registry)}:${String(index)}`} className={css.versionRow}>
          <div className={css.versionMain}>
            <div className={css.versionTitle}>
              <span className={css.versionNumber}>{registryName(attempt.registry, t)}</span>
              <Tag className={css.statusTag} tone="outline">{t(index === 0 ? 'versionsPrimaryTag' : 'versionsFallbackTag')}</Tag>
              {attempt.problem === undefined ? null : <Tag className={css.statusTag} tone="danger">{t(PROBLEM_KEYS[attempt.problem])}</Tag>}
            </div>
            {attempt.reason === undefined ? null : <code className={css.versionLog}>{attempt.reason}</code>}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The unfolded list: newer versions, the installed one, and where and when the list was read. */
function VersionList({ list, checkedAt, t, busy, onUpdate }: {
  readonly list: Extract<PluginVersionList, { status: 'listed' }>
  readonly checkedAt: number
  readonly t: Translate
  readonly busy: boolean
  readonly onUpdate: (version: string) => void
}): ReactNode {
  const [prereleases, setPrereleases] = useState(false)
  const shown = list.versions.filter(version => prereleases || !version.prerelease)
  const fallback = list.attempts.length > 1 ? list.attempts[0] : undefined
  return (
    <div className={css.versionBody}>
      <ul className={css.versionRows}>
        {shown.map(version => (
          <VersionRow key={version.version} version={version} installed={list.installed} t={t} busy={busy} onUpdate={onUpdate} />
        ))}
        <VersionRow version={{ version: list.installed, installedRow: true }} installed={list.installed} t={t} busy={busy}
          onUpdate={onUpdate} />
      </ul>
      {list.omitted > 0 ? <p className={css.versionNote}>{t('versionsOmitted', { count: String(list.omitted) })}</p> : null}
      <div className={css.versionMeta}>
        <dl className={css.versionFact}>
          <dt>{t('versionsRegistry')}</dt>
          <dd>
            {registryName(list.registry, t)}
            {fallback === undefined ? null : (
              <Tooltip label={t('versionsFallbackHint', { registry: registryName(fallback.registry, t) })} side="top" portal>
                <span className={css.versionHint} tabIndex={0}><Tag className={css.statusTag} tone="outline">{t('versionsFallbackTag')}</Tag></span>
              </Tooltip>
            )}
          </dd>
        </dl>
        <dl className={css.versionFact}>
          <dt>{t('versionsCheckedAtLabel')}</dt>
          <dd>{checkedTime(checkedAt)}</dd>
        </dl>
        <span className={css.versionSpacer} />
        {list.versions.some(version => version.prerelease)
          ? <Checkbox checked={prereleases} onChange={setPrereleases} label={t('versionsShowPrerelease')} />
          : null}
      </div>
    </div>
  )
}

/**
 * The Versions section of an updatable bundle's page. It checks once when the page opens and folds the newer versions
 * behind a summary row.
 */
export function VersionSection({ pkg, check, t, busy, onEnsure, onCheck, onUpdate }: {
  readonly pkg: PackageView
  readonly check: VersionCheck | undefined
  readonly t: Translate
  readonly busy: boolean
  /** Check a package's versions unless a check already started. */
  readonly onEnsure: (packageName: string) => void
  readonly onCheck: () => void
  readonly onUpdate: (version: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const { name, updatable } = pkg
  useEffect(() => { if (updatable) onEnsure(name) }, [name, updatable, onEnsure])
  if (!updatable) return null
  const done = check?.phase === 'done' ? check : undefined
  const summary = summaryOf(check, t)
  const refused = done?.list.status === 'refused' ? done.list : undefined
  const listed = done?.list.status === 'listed' ? done.list : undefined
  const unfolds = summary.newer > 0 || (refused !== undefined && refused.attempts.length > 0)
  const expanded = open && unfolds
  const text = (
    <span className={css.versionSummaryText}>
      <span className={css.versionSummaryTitle}>{summary.title}</span>
      {summary.sub === undefined ? null : <span className={css.versionSummarySub}>{summary.sub}</span>}
    </span>
  )
  return (
    <section className={css.detailSection} data-plugin-versions>
      <div className={css.sectionHead}>
        <h4 className={css.sectionTitle}>{t('versionsTitle')}</h4>
        <span className={css.versionSpacer} />
        {refused === undefined ? (
          <Button variant="ghost" size="sm" icon={<IconRefreshOutlineRegular size={13} />} disabled={check?.phase !== 'done'} onClick={onCheck}>
            {t('versionsRecheck')}
          </Button>
        ) : null}
      </div>
      <div className={css.versionPanel}>
        {listed !== undefined && summary.newer > 0 ? (
          <button type="button" className={css.versionSummary} aria-expanded={expanded} onClick={() => { setOpen(!open) }}>
            <Glyph tone={summary.tone}>{summary.glyph}</Glyph>
            {text}
            <span className={css.versionSummaryEnd}>
              {expanded ? t('versionsCollapse') : t('versionsNewerCount', { count: String(summary.newer) })}
              <IconChevronDownOutlineRegular className={css.detailsChevron} aria-hidden="true" />
            </span>
          </button>
        ) : (
          <div className={css.versionSummary} role="status">
            <Glyph tone={summary.tone}>{summary.glyph}</Glyph>
            {text}
            {refused === undefined ? null : (
              <span className={css.versionSummaryEnd}>
                {unfolds ? (
                  <button type="button" className={css.detailsToggle} aria-expanded={expanded} onClick={() => { setOpen(!open) }}>
                    {t('versionsDetails')}
                    <IconChevronDownOutlineRegular className={css.detailsChevron} aria-hidden="true" />
                  </button>
                ) : null}
                <Button variant="outline" size="sm" onClick={onCheck}>{t('retry')}</Button>
              </span>
            )}
          </div>
        )}
        {expanded && listed !== undefined && done !== undefined
          ? <VersionList list={listed} checkedAt={done.checkedAt} t={t} busy={busy} onUpdate={onUpdate} />
          : null}
        {expanded && refused !== undefined
          ? <div className={css.versionBody}><AttemptRows attempts={refused.attempts} t={t} /></div>
          : null}
      </div>
    </section>
  )
}

/** The step labels of an update; the Host announces each step as it starts. */
function stepLabel(step: PluginUpdateStep, update: UpdateState, t: Translate): string {
  switch (step) {
    case 'checking': return t('updateStepChecking', { version: update.to })
    case 'removing': return t('updateStepRemoving', { version: update.from })
    case 'installing': return t('updateStepInstalling', { version: update.to, registry: registryName(update.registry, t) })
    case 'restoring': return t('updateStepRestoring', { version: update.from })
  }
}

/** Whether a change result left its operation undone. */
function failed(application: PluginUpdateResult['result']['application']): boolean {
  return application === 'failed' || application === 'cancelled'
}

/** The steps in the order the Host runs them. */
const STEP_ORDER: readonly PluginUpdateStep[] = ['checking', 'removing', 'installing', 'restoring']

/** The steps an answer implies, joined with the announced ones, so a lost announcement does not drop a step that ran. */
function settledSteps(announced: readonly PluginUpdateStep[], result: PluginUpdateResult): PluginUpdateStep[] {
  const implied = new Set<PluginUpdateStep>(['checking', ...announced])
  if (result.step === 'remove') implied.add('removing')
  if (result.step === 'install') implied.add('installing')
  if (result.restore !== undefined) implied.add('restoring')
  return STEP_ORDER.filter(step => implied.has(step))
}

/** How one step ended, or that it still runs. */
function stepState(step: PluginUpdateStep, update: UpdateState, last: boolean): 'running' | 'done' | 'failed' | 'unknown' {
  const result = update.result
  if (update.phase === 'running') return last ? 'running' : 'done'
  if (result === null) return last ? 'unknown' : 'done'
  switch (step) {
    case 'checking': return result.step === 'check' ? 'failed' : 'done'
    case 'removing': return result.step === 'remove' ? 'failed' : 'done'
    case 'installing': return failed(result.result.application) ? 'failed' : 'done'
    case 'restoring': return result.restore !== undefined && failed(result.restore.application) ? 'failed' : 'done'
  }
}

const STEP_GLYPHS = {
  running: <StateDot state="ongoing" size={12} />,
  done: <IconCheckOutlineRegular size={12} />,
  failed: <IconCloseOutlineRegular size={12} />,
  unknown: null,
} as const

/** What the update's outcome reads as: its glyph, title, and the sentence under it. */
function outcomeOf(update: UpdateState, title: string, t: Translate): Omit<Summary, 'sub' | 'newer'> & { detail: string } {
  const error = { tone: 'error' as const, glyph: <IconCloseOutlineRegular size={14} /> }
  const result = update.result
  // A finished update without the Host's answer carries the transport's words.
  if (result === null) return { ...error, title: t('updateLost'), detail: t('updateLostDetail', { reason: String(update.lost) }) }
  // A failed step always carries the Host's refusal; an absent one reads as the generic operation error.
  const reason = (change: PluginUpdateResult['result']): string => managementText({ code: 'operation-error', ...change.error, installing: true }, t)
  if (result.step === 'check') return { ...error, title: t('updateRefused', { version: update.to }), detail: reason(result.result) }
  if (result.step === 'remove') return { ...error, title: t('updateRemoveFailed', { version: update.from }), detail: reason(result.result) }
  if (!failed(result.result.application)) {
    return result.result.application === 'restart-required'
      ? { tone: 'warn', glyph: <IconWarningOutlineRegular size={14} />, title: t('updateRestart', { version: update.to }), detail: restartText('restartNotice', result.result.restartReason, t) }
      : { tone: 'success', glyph: <IconCheckOutlineRegular size={14} />, title: t('updateDone', { version: update.to }), detail: t('updateDoneDetail') }
  }
  // Without a reinstallation nothing was removed: the installation went over the running version and was rolled back.
  if (result.restore === undefined) {
    return { ...error, title: t('updateKept', { version: update.to }), detail: t('updateKeptDetail', { from: update.from, reason: reason(result.result) }) }
  }
  return failed(result.restore.application)
    ? { ...error, title: t('updateBroken'), detail: t('updateBrokenDetail', { from: update.from, to: update.to, name: title }) }
    : { ...error, title: t('updateRestored', { version: update.from }), detail: t('updateRestoredDetail', { from: update.from, to: update.to }) }
}

/** The update dialog: confirmation, then the Host's steps, then the outcome. */
export function UpdateDialog({ update, title, t, onRun, onClose, onToggleOutput }: {
  readonly update: UpdateState
  /** The package's display title. */
  readonly title: string
  readonly t: Translate
  readonly onRun: () => void
  readonly onClose: () => void
  readonly onToggleOutput: () => void
}): ReactNode {
  const running = update.phase === 'running'
  const steps = update.result === null ? update.steps : settledSteps(update.steps, update.result)
  const outcome = update.phase === 'done' ? outcomeOf(update, title, t) : undefined
  // The failed run's own output: the target's installation, else the removal or the reinstallation.
  const output = [update.result?.result, update.result?.restore]
    .map(change => change !== undefined && failed(change.application) ? change.packageResult?.output : undefined)
    .find(text => text !== undefined && text !== '')
  return (
    <Modal
      open
      onClose={() => { if (!running) onClose() }}
      title={t('updateTitle', { name: title })}
      closeLabel={t('close')}
      className={css.updateDialog as string}
      footer={update.phase === 'confirm' ? (
        <>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={onRun}>{t('update')}</Button>
        </>
      ) : running
        ? <Button variant="outline" disabled>{t('updateRunning')}</Button>
        : <Button variant="primary" onClick={onClose}>{t('updateFinish')}</Button>}
    >
      <div className={css.updateBody} data-plugin-update={update.phase}>
        {update.phase === 'confirm' ? (
          <>
            <div className={css.updateVersions}>
              <span className={css.versionNumber} data-old="">{update.from}</span>
              <IconChevronRightOutlineRegular size={14} aria-hidden="true" />
              <span className={css.versionNumber}>{update.to}</span>
            </div>
            <dl className={css.versionFact}>
              <dt>{t('updateSource')}</dt>
              <dd>{registryName(update.registry, t)}</dd>
            </dl>
            <p className={css.updateText}>{t('updateDescription', { from: update.from, to: update.to })}</p>
          </>
        ) : (
          <>
            {outcome === undefined ? null : (
              <div className={css.updateOutcome} role="status">
                <Glyph tone={outcome.tone}>{outcome.glyph}</Glyph>
                <span className={css.versionSummaryText}>
                  <span className={css.versionSummaryTitle}>{outcome.title}</span>
                  <span className={css.versionSummarySub}>{outcome.detail}</span>
                </span>
              </div>
            )}
            {output === undefined ? null : (
              <>
                <button type="button" className={css.detailsToggle} aria-expanded={update.outputOpen} onClick={onToggleOutput}>
                  {t('updateOutput')}
                  <IconChevronDownOutlineRegular className={css.detailsChevron} aria-hidden="true" />
                </button>
                {update.outputOpen ? <pre className={css.updateOutput}>{output}</pre> : null}
              </>
            )}
            <ol className={css.updateSteps}>
              {steps.map((step, index) => {
                const state = stepState(step, update, index === steps.length - 1)
                return (
                  <li key={step} className={css.updateStep} data-state={state}>
                    <span className={css.updateStepDot} aria-hidden="true">{STEP_GLYPHS[state]}</span>
                    <span>{stepLabel(step, update, t)}</span>
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </div>
    </Modal>
  )
}
