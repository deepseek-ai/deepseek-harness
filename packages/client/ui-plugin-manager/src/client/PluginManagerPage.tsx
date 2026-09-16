/**
 * Global plugin management: cards for the profile's installed bundles and for
 * the official bundles the installation ships switched off, their row
 * switches, the install dialog with its guide and folded pnpm output, the
 * uninstall confirmation, and the toasts an action's outcome becomes. A
 * bundle's page lists the rows it contributes as the Host runs them.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { PluginInstallFailureKind } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconCheckOutline16, IconChevronDownOutline14, IconChevronLeftOutline14, IconCloseOutline16, IconCordisPluginOutline14,
  IconPluginPinwheelOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16, IconWarningOutline16,
  Input, Modal, StateDot, Switch, Tag, TerminalBlock, Toast,
  type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerLocaleKey } from './locales.ts'
import {
  isInstallPending, rowKey,
  type ConfirmState, type InstallInputError, type InstallState, type InstallSubject, type PackageRow, type PackageView,
  type PluginManagerFace,
} from './manager-store.ts'
import { managementText, noticeText, shortName, type Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/** Full component props assembled by the main slot renderer. */
export type PluginManagerPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'pluginManager'>
  & InjectFace<PluginManagerFace>

type RowPhase = NonNullable<PackageRow['phase']>

/** How long the list marks a package an install just enabled. */
const HIGHLIGHT_MS = 2_400

/** How long a toast holds: long enough to read a failure that names what broke. */
function toastHoldMs(text: string): number {
  return Math.min(8_000, Math.max(3_000, text.length * 80))
}

const PHASE_KEYS = {
  pending: 'rowPhasePending',
  loading: 'rowPhaseLoading',
  active: 'rowPhaseActive',
  failed: 'rowPhaseFailed',
  unloading: 'rowPhaseUnloading',
} satisfies Record<RowPhase, PluginManagerLocaleKey>

/** Status dot naming a live root-fiber phase: pending and unloading fibers do nothing; only loading is in progress. */
const PHASE_STATES = {
  pending: 'idle',
  loading: 'ongoing',
  active: 'done',
  failed: 'error',
  unloading: 'idle',
} satisfies Record<RowPhase, StateDotState>

/** The count line over a pack's components: the total, then only the states that occur. */
function partsSummary(rows: readonly PackageRow[], t: Translate): string {
  const failed = rows.filter(row => row.phase === 'failed').length
  const off = rows.filter(row => !row.enabled).length
  const running = rows.filter(row => row.enabled && row.phase === 'active').length
  return [
    t('partsCountTotal', { count: String(rows.length) }),
    ...running > 0 ? [t('partsCountRunning', { count: String(running) })] : [],
    ...off > 0 ? [t('partsCountOff', { count: String(off) })] : [],
    ...failed > 0 ? [t('partsCountFailed', { count: String(failed) })] : [],
  ].join(' · ')
}

/** Switching for a pack's rows: which rows have a write in flight, and the write. */
interface RowToggles {
  readonly busy: (row: PackageRow) => boolean
  readonly onSetEnabled: (row: PackageRow, enabled: boolean) => void
}

/** Rows beyond this count get a filter box above the list. */
const ROW_FILTER_THRESHOLD = 10

/** A row's switch: locked, saying why, when the Host refuses to address the row through the profile patch. */
function RowSwitch({ row, t, busy, onChange }: {
  readonly row: PackageRow
  readonly t: Translate
  readonly busy: boolean
  readonly onChange: (enabled: boolean) => void
}): ReactNode {
  const locked = row.readOnlyReason !== undefined || row.entryId === undefined
  return (
    <Switch
      checked={row.enabled}
      label={t('partToggle', { name: row.rowId })}
      disabled={busy || locked}
      {...row.readOnlyReason === undefined ? {} : { title: managementText({ code: row.readOnlyReason }, t) }}
      onChange={onChange}
    />
  )
}

/** What a row's state line says: off, or the phase its fiber is in. */
function rowStateText(row: PackageRow, t: Translate): string {
  if (!row.enabled) return t('partOff')
  return row.phase === null ? t('rowStateIdle') : t(PHASE_KEYS[row.phase])
}

/** The dot beside a row: its fiber phase, or idle. */
function rowDotState(row: PackageRow): StateDotState {
  if (!row.enabled || row.phase === null) return 'idle'
  return PHASE_STATES[row.phase]
}

/**
 * A pack's rows as a list in the order the pack declares them: a state dot,
 * the row id, one line saying its state, and, when the pack is on, a switch.
 * A pack like base carries close to a hundred rows, so a long list gets a filter.
 */
function RowsSection({ rows, t, toggle }: {
  readonly rows: readonly PackageRow[]
  readonly t: Translate
  readonly toggle?: RowToggles | undefined
}): ReactNode {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const shown = query === '' ? rows : rows.filter(row => row.rowId.toLowerCase().includes(query))
  return (
    <section className={css.detailSection} data-plugin-rows>
      <div className={css.sectionHead}>
        <h4 className={css.sectionTitle}>{t('partsLabel')}</h4>
        {rows.length === 0 ? null : <span className={css.sectionCount}>{partsSummary(rows, t)}</span>}
      </div>
      {rows.length === 0 ? <p className={css.status}>{t('partsEmpty')}</p> : null}
      {rows.length > ROW_FILTER_THRESHOLD
        ? (
          <Input
            type="search"
            className={css.partsFilter as string}
            placeholder={t('partsFilter')}
            aria-label={t('partsFilter')}
            value={filter}
            onChange={(event) => { setFilter(event.target.value) }}
          />
        )
        : null}
      {rows.length > 0 && shown.length === 0 ? <p className={css.status}>{t('partsFilterEmpty')}</p> : null}
      {shown.length === 0
        ? null
        : (
          <ul className={css.rows}>
            {shown.map(row => (
              <li
                key={row.rowId}
                className={css.row}
                data-plugin-row={row.entryId ?? row.rowId}
                {...row.phase === 'failed' ? { 'data-state': 'failed' } : row.enabled ? {} : { 'data-state': 'off' }}
              >
                <div className={css.rowLine}>
                  <span className={css.rowIcon} aria-hidden="true"><IconCordisPluginOutline14 /></span>
                  <div className={css.rowMain}>
                    <span className={css.rowId}>{row.rowId}</span>
                    <span className={css.rowModule}>{row.moduleName}</span>
                  </div>
                  <span className={css.rowState}>
                    <StateDot state={rowDotState(row)} size={8} />
                    {rowStateText(row, t)}
                  </span>
                  {toggle === undefined
                    ? null
                    : <RowSwitch row={row} t={t} busy={toggle.busy(row)} onChange={(enabled) => { toggle.onSetEnabled(row, enabled) }} />}
                </div>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/**
 * A bundle's enable switch on its card and its page: locked, saying why, for
 * one the Host protects; off and locked for one it cannot read.
 */
function EnableSwitch({ pkg, title, t, busy, onSetEnabled }: {
  readonly pkg: PackageView
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  return (
    <Switch
      checked={pkg.enabled}
      label={t('enableToggle', { name: title })}
      disabled={busy || pkg.readOnlyReason !== undefined || (!pkg.enabled && pkg.error !== undefined)}
      {...pkg.readOnlyReason === undefined ? {} : { title: managementText({ code: pkg.readOnlyReason }, t) }}
      onChange={onSetEnabled}
    />
  )
}

/** The status one card carries: running, off, or a problem the Host reported. */
function packageStatus(pkg: PackageView): 'running' | 'disabled' | 'problem' {
  if (pkg.error !== undefined) return 'problem'
  return pkg.enabled ? 'running' : 'disabled'
}

/** One package as a card that opens its page: its name, its one-liner, its tags, and its bundle switch. */
function PackageCard({ pkg, t, busy, highlighted, onOpen, onSetEnabled }: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly busy: boolean
  readonly highlighted: boolean
  readonly onOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  const title = shortName(pkg.name)
  const status = packageStatus(pkg)
  return (
    <li
      className={`${css.card} ${css.cardLink}`}
      data-plugin-package={pkg.name}
      data-plugin-status={status}
      {...highlighted ? { 'data-plugin-highlight': '' } : {}}
    >
      <div className={css.cardHead}>
        <span className={css.cardIcon} aria-hidden="true"><IconPluginPinwheelOutline16 size={20} /></span>
        <div className={css.cardMain}>
          <div className={css.titleRow}>
            <button type="button" className={`${css.cardTitle} ${css.cardOpen}`} aria-label={t('openDetail', { name: title })} onClick={onOpen}>{title}</button>
            {pkg.optional ? <Tag className={css.statusTag} tone="info">{t('statusOfficial')}</Tag> : null}
            {status === 'problem' ? <Tag className={css.statusTag} tone="danger">{t('statusProblem')}</Tag> : null}
          </div>
          {pkg.description === undefined ? null : <span className={css.cardDesc}>{pkg.description}</span>}
        </div>
        <div className={css.cardEnd}>
          <EnableSwitch pkg={pkg} title={title} t={t} busy={busy} onSetEnabled={onSetEnabled} />
        </div>
      </div>
    </li>
  )
}

/**
 * One package's page: the crumb back to the list; its icon with its switch
 * and, for a package the profile installed, uninstall; its title beside its
 * version tag, its official tag, and its problem tag; the
 * package name the title stands for, which is what installs it elsewhere;
 * its one-liner; the Host's problem when it reports one; and its rows with
 * their switches.
 */
function PackageDetail({
  pkg, t, busy, rowBusy,
  onBack, onSetEnabled, onUninstall, onSetRowEnabled,
}: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly busy: boolean
  /** Whether a row has a write in flight. */
  readonly rowBusy: (row: PackageRow) => boolean
  readonly onBack: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onUninstall: () => void
  readonly onSetRowEnabled: (row: PackageRow, enabled: boolean) => void
}): ReactNode {
  const title = shortName(pkg.name)
  const status = packageStatus(pkg)
  return (
    <div className={css.detail} data-plugin-detail={pkg.name}>
      <button type="button" className={css.crumb} aria-label={t('backToList')} onClick={onBack}>
        <IconChevronDownOutline14 className={css.crumbIcon} aria-hidden="true" />
        <span>{t('crumbRoot')}</span>
      </button>
      <div className={css.detailHead}>
        <span className={css.cardIcon} aria-hidden="true"><IconPluginPinwheelOutline16 size={20} /></span>
        <div className={css.detailActions}>
          {pkg.installed
            ? (
              <Button
                variant="outline"
                size="sm"
                className={css.danger}
                icon={<IconTrashOutline16 size={13} />}
                aria-label={t('uninstallLabel', { name: title })}
                disabled={busy || pkg.readOnlyReason !== undefined}
                onClick={onUninstall}
              >
                {t('uninstall')}
              </Button>
            )
            : null}
          <EnableSwitch pkg={pkg} title={title} t={t} busy={busy} onSetEnabled={onSetEnabled} />
        </div>
      </div>
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{title}</h3>
          {pkg.version === undefined ? null : <span className={css.versionTag} data-plugin-version>{t('versionTag', { version: pkg.version })}</span>}
          {pkg.optional ? <Tag className={css.statusTag} tone="info">{t('statusOfficial')}</Tag> : null}
          {status === 'problem' ? <Tag className={css.statusTag} tone="danger">{t('statusProblem')}</Tag> : null}
        </div>
        <p className={css.detailName}><code data-plugin-name>{pkg.name}</code></p>
        <p className={css.detailDesc}>{pkg.description ?? t('noDescription')}</p>
      </div>
      {pkg.error === undefined ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {managementText(pkg.error, t)}</p>}
      {pkg.readOnlyReason === undefined ? null : <p className={css.reason} role="status">{managementText({ code: pkg.readOnlyReason }, t)}</p>}
      <div className={css.detailSections}>
        <RowsSection
          rows={pkg.rows}
          t={t}
          toggle={pkg.enabled ? { busy: row => busy || rowBusy(row), onSetEnabled: onSetRowEnabled } : undefined}
        />
      </div>
    </div>
  )
}

/** Output lines an install run's terminal shows before its middle folds: the first and last six of a long pnpm log. */
const INSTALL_TERMINAL_LINES = 12

/** The install terminal's display copy, from the tab's dictionary. */
function terminalLabels(t: Translate): TerminalBlockLabels {
  return {
    /* v8 ignore next -- the Host reports a killed pnpm as a null exit code, never a signal name; the label interface needs one */
    signal: signal => t('terminalSignal', { signal }),
    exitCode: code => t('terminalExitCode', { code: String(code) }),
    noExitCode: t('terminalNoExitCode'),
    running: t('terminalRunning'),
    failed: t('terminalFailed'),
    done: t('terminalDone'),
    copy: t('terminalCopy'),
    copied: t('terminalCopied'),
    noOutput: t('terminalNoOutput'),
    collapseAria: t('terminalCollapseAria'),
    collapse: t('terminalCollapse'),
    expandAria: hidden => t('terminalExpandAria', { n: String(hidden) }),
    expand: hidden => t('terminalExpand', { n: String(hidden) }),
  }
}

/** The sentence under the field for a spec the check refused. */
const INPUT_PROBLEM_KEYS = {
  'invalid-spec': 'installProblemInvalid',
  'already-installed': 'installProblemInstalled',
  'not-found': 'installProblemNotFound',
  'not-a-package': 'installProblemNotPackage',
  'not-a-bundle': 'installProblemNotBundle',
  'network': 'installProblemNetwork',
  'unknown': 'installProblemUnknown',
} satisfies Record<InstallInputError['problem'], PluginManagerLocaleKey>

/** One row of the install guide: a spec form's title, its example, and where the person finds it. */
interface GuideExample {
  readonly key: string
  readonly titleKey: PluginManagerLocaleKey
  readonly exampleKey: PluginManagerLocaleKey
  readonly hintKey: PluginManagerLocaleKey
}

/** The spec forms the install guide shows, each with an example the person can drop into the field. */
const GUIDE_EXAMPLES = [
  { key: 'id', titleKey: 'installGuideIdTitle', exampleKey: 'installGuideIdExample', hintKey: 'installGuideIdHint' },
  { key: 'git', titleKey: 'installGuideGitTitle', exampleKey: 'installGuideGitExample', hintKey: 'installGuideGitHint' },
  { key: 'path', titleKey: 'installGuidePathTitle', exampleKey: 'installGuidePathExample', hintKey: 'installGuidePathHint' },
] as const satisfies readonly GuideExample[]

/** The one-line reading of a classified pnpm failure. */
const FAILURE_KIND_KEYS = {
  'pnpm-missing': 'installFailurePnpmMissing',
  'timeout': 'installFailureTimeout',
  'not-found': 'installFailureNotFound',
  'no-matching-version': 'installFailureNoMatchingVersion',
  'network': 'installFailureNetwork',
  'disk-full': 'installFailureDiskFull',
  'permission': 'installFailurePermission',
  'build-blocked': 'installFailureBuildBlocked',
  'integrity': 'installFailureIntegrity',
  'unknown': 'installFailureGeneric',
} satisfies Record<PluginInstallFailureKind, PluginManagerLocaleKey>

/** The heading of each screen past the spec. */
const SCREEN_TITLE_KEYS = {
  starting: 'installStarting',
  running: 'installingTitle',
  cancelling: 'installCancelling',
  applying: 'installApplying',
  done: 'installedTitle',
  failed: 'installFailedTitle',
} satisfies Record<Exclude<InstallState['phase'], 'idle' | 'checking'>, PluginManagerLocaleKey>

/** What the spec's kind reads as when the package carries no description of its own. */
const SUBJECT_KIND_KEYS = {
  registry: undefined,
  path: 'installSubjectPath',
  git: 'installSubjectGit',
  tarball: 'installSubjectTarball',
} satisfies Record<InstallSubject['kind'], PluginManagerLocaleKey | undefined>

/**
 * The failed screen's one line: a pnpm failure by its kind, a refusal by its
 * code, any other failure in the Host's words; the run's output stays behind the details.
 */
function failureText(failure: InstallState['failure'], t: Translate): string {
  if (failure === null) return t('installFailureGeneric')
  // Blocked scripts the Host could not name leave the person to allow them in the profile's pnpm settings by hand.
  if (failure.kind === 'build-blocked' && !failure.pendingBuilds?.length) return t('installFailureBuildBlockedManual')
  if (failure.kind !== undefined) return t(FAILURE_KIND_KEYS[failure.kind])
  if (failure.code !== undefined) return managementText({ code: failure.code, diagnostic: failure.reason }, t)
  return failure.reason === '' ? t('installFailureGeneric') : failure.reason
}

/** The package the install is about: its name, one-liner, and version, as the Host read them before installing. */
function SubjectCard({ subject, t }: { readonly subject: InstallSubject; readonly t: Translate }): ReactNode {
  const title = subject.name ?? subject.spec
  const kindKey = SUBJECT_KIND_KEYS[subject.kind]
  const description = subject.description ?? (kindKey === undefined ? undefined : t(kindKey))
  return (
    <div className={css.subject} data-install-subject={subject.spec}>
      <p className={css.subjectName}>{title}</p>
      {description === undefined ? null : <p className={css.subjectDesc}>{description}</p>}
      {subject.version === undefined ? null : <p className={css.subjectMeta}>{t('installVersion', { version: subject.version })}</p>}
    </div>
  )
}

/**
 * The install dialog: the spec and its check, then the installing, installed,
 * and failed screens over the same subject card. A failed run that left
 * install scripts undecided shows them for approval in place of plain retry.
 */
function InstallDialog({ install, t, onClose, onEditSpec, onRun, onCancel, onToggleDetails, onEnableNow, onApproveBuilds }: {
  readonly install: InstallState
  readonly t: Translate
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
  readonly onToggleDetails: () => void
  readonly onEnableNow: () => void
  readonly onApproveBuilds: () => void
}): ReactNode {
  const errorId = useId()
  const guideId = useId()
  const approvalId = useId()
  const [guideOpen, setGuideOpen] = useState(false)
  const { phase } = install
  if (phase === 'idle' || phase === 'checking') {
    const checking = phase === 'checking'
    const empty = install.spec.trim() === ''
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t('installTitle')}
        closeLabel={t('close')}
        description={t('installDescription')}
        className={css.installDialog as string}
        footer={(
          <Button variant="primary" className={css.wide} disabled={checking || empty} aria-busy={checking} onClick={onRun}>
            {checking ? <span className={css.spinner} aria-hidden="true" /> : null}
            {t(checking ? 'installChecking' : 'installRun')}
          </Button>
        )}
      >
        <div className={css.installBody}>
          <label className={css.installField}>
            <span>{t('installSpecLabel')}</span>
            <input
              type="text"
              value={install.spec}
              placeholder={t('installSpecPlaceholder')}
              disabled={checking}
              aria-invalid={install.inputError !== null}
              aria-describedby={install.inputError === null ? undefined : errorId}
              onChange={(event) => { onEditSpec(event.currentTarget.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !empty && !checking) onRun() }}
            />
          </label>
          {install.inputError === null
            ? null
            : <p id={errorId} className={css.inputError} role="alert">{t(INPUT_PROBLEM_KEYS[install.inputError.problem], { reason: install.inputError.reason })}</p>}
          <button
            type="button"
            className={css.guideToggle}
            aria-expanded={guideOpen}
            aria-controls={guideId}
            onClick={() => { setGuideOpen(open => !open) }}
          >
            <IconChevronDownOutline14 className={css.guideChevron} aria-hidden="true" />
            <span>{t(guideOpen ? 'installGuideHide' : 'installGuideToggle')}</span>
          </button>
          {guideOpen
            ? (
              <div id={guideId} className={css.guide} data-install-guide>
                <p className={css.guideIntro}>{t('installGuideIntro')}</p>
                <p className={css.guideNote}>{t('installGuideIdNote')}</p>
                <ol className={css.guideList}>
                  {GUIDE_EXAMPLES.map(({ key, titleKey, exampleKey, hintKey }, index) => (
                    <li key={key} className={css.guideItem}>
                      <span className={css.guideIndex} aria-hidden="true">{index + 1}</span>
                      <div className={css.guideMain}>
                        <span className={css.guideTitle}>{t(titleKey)}</span>
                        <code className={css.guideExample}>{t(exampleKey)}</code>
                        <span className={css.guideHint}>{t(hintKey)}</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('installGuideFillAria', { example: t(exampleKey) })}
                        disabled={checking}
                        onClick={() => { onEditSpec(t(exampleKey)) }}
                      >
                        {t('installGuideFill')}
                      </Button>
                    </li>
                  ))}
                </ol>
                <p className={css.guideSafety} role="note">
                  <IconWarningOutline16 size={14} aria-hidden="true" />
                  <span>{t('installGuideSafety')}</span>
                </p>
              </div>
            )
            : null}
        </div>
      </Modal>
    )
  }
  const heading = t(SCREEN_TITLE_KEYS[phase])
  const pending = isInstallPending(phase)
  // Only a run the Host acknowledged can be stopped; before that, and while it stops or applies, the controls wait.
  const stoppable = phase === 'running' || phase === 'failed'
  const unconfirmed = install.failure?.cancelUnconfirmed === true ? install.failure.reason : undefined
  const pendingBuilds = phase === 'failed' ? install.failure?.pendingBuilds ?? [] : []
  const approvable = pendingBuilds.length > 0
  const firstRun = install.runs[0]
  return (
    <Modal open={install.open} onClose={onClose} title={heading} headless className={css.installDialog as string}>
      <div className={css.wizard} data-install-phase={phase}>
        <div className={css.wizardHead}>
          {phase === 'done'
            ? <span />
            : (
              <button type="button" className={css.wizardBack} aria-label={t('installEditAria')} disabled={!stoppable} onClick={onCancel}>
                <IconChevronLeftOutline14 aria-hidden="true" />
                <span>{t('installEdit')}</span>
              </button>
            )}
          <button type="button" className={css.wizardClose} aria-label={t('close')} disabled={pending} onClick={onClose}>
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        <div className={css.wizardScroll}>
          <div className={css.wizardHero}>
            <span className={css.wizardIcon} data-tone={pending ? 'pending' : phase} aria-hidden="true">
              {pending
                ? <span className={css.spinnerLarge} />
                : phase === 'done' ? <IconCheckOutline16 size={28} /> : <IconWarningOutline16 size={28} />}
            </span>
            <h2 className={css.wizardTitle} role={phase === 'failed' ? 'alert' : 'status'}>{heading}</h2>
            {phase === 'failed' ? <p className={css.wizardSub}>{failureText(install.failure, t)}</p> : null}
            {unconfirmed === undefined ? null : <p className={css.wizardSub} role="alert">{t('installCancelUnconfirmed', { reason: unconfirmed })}</p>}
          </div>
          {install.subject === null ? null : <SubjectCard subject={install.subject} t={t} />}
          {approvable
            ? (
              <section className={css.approval} role="group" aria-labelledby={approvalId} data-install-approval>
                <h3 id={approvalId} className={css.approvalTitle}>{t('installApprovalTitle')}</h3>
                <p className={css.approvalText}>{t('installApprovalDescription')}</p>
                <ul className={css.approvalList}>
                  {pendingBuilds.map(name => <li key={name}><code>{name}</code></li>)}
                </ul>
                <p className={css.approvalText}>{t('installApprovalConsequence')}</p>
                <p className={css.approvalCaution}>{t('installApprovalCaution')}</p>
                <Button variant="primary" className={css.wide} onClick={onApproveBuilds}>{t('installApproveAndRetry')}</Button>
              </section>
            )
            : null}
          {phase === 'done' && install.installed === null
            ? <p className={css.result} role="status">{t('installDoneNothing')}</p>
            : null}
          {phase === 'done' && install.restartRequired
            ? <p className={css.resultWarn} role="status">{t('installDoneRestart')}</p>
            : null}
          {phase === 'done' && install.approvedBuilds.length > 0
            ? <p className={css.result} role="status">{t('installDoneApproved', { names: install.approvedBuilds.join(', ') })}</p>
            : null}
          <div className={css.wizardFoot}>
            <button type="button" className={css.detailsToggle} aria-expanded={install.detailsOpen} onClick={onToggleDetails}>
              <span>{t(install.detailsOpen ? 'installDetailsHide' : 'installDetailsShow')}</span>
              <IconChevronDownOutline14 className={css.detailsChevron} aria-hidden="true" />
            </button>
            {pending
              ? (
                <Button variant="outline" size="sm" disabled={phase !== 'running'} onClick={onCancel}>
                  {t(phase === 'cancelling' ? 'installCancelling' : 'installCancel')}
                </Button>
              )
              : null}
            {phase === 'failed' && !approvable ? <Button variant="primary" size="sm" onClick={onRun}>{t('installRetry')}</Button> : null}
          </div>
          {install.detailsOpen
            ? (
              <div className={css.detailsBody}>
                <p className={css.installLocation}>{firstRun === undefined ? t('terminalNoOutput') : t('installLocation', { dir: firstRun.cwd })}</p>
                {install.runs.map(run => (
                  <TerminalBlock
                    key={run.jobId}
                    command={run.command}
                    output={run.output}
                    running={run.exitCode === undefined}
                    exitCode={run.exitCode}
                    maxLines={INSTALL_TERMINAL_LINES}
                    labels={{ ...terminalLabels(t), ...phase === 'cancelling' ? { failed: t('installCancelledShort') } : {} }}
                    className={css.terminal}
                  />
                ))}
              </div>
            )
            : null}
          {phase !== 'done'
            ? null
            : install.installed !== null
              ? <Button variant="primary" className={css.wide} disabled={install.enabling} aria-busy={install.enabling} onClick={onEnableNow}>{t('installEnableNow')}</Button>
              : <Button variant="primary" className={css.wide} onClick={onClose}>{t('installClose')}</Button>}
        </div>
      </div>
    </Modal>
  )
}

/** The confirmation an uninstall waits on. */
function ConfirmDialog({ confirm, t, onConfirm, onCancel }: {
  readonly confirm: ConfirmState
  readonly t: Translate
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  const name = shortName(confirm.packageName)
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('confirmUninstallTitle', { name })}
      closeLabel={t('close')}
      description={t('confirmUninstallDescription')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" className={css.dangerButton} onClick={onConfirm}>
            {t('confirmUninstall')}
          </Button>
        </>
      )}
    />
  )
}

/** Render the plugin manager: the installed bundles, the install dialog, and the confirmation. */
export function PluginManagerPage(props: PluginManagerPageProps): ReactNode {
  const { t, ensure } = props
  const state = props.usePluginManager(snapshot => snapshot)
  // The package whose page is open; one that leaves the list (uninstalled) drops back to the cards.
  const [openPackage, setOpenPackage] = useState<string | null>(null)
  useEffect(() => { ensure() }, [ensure])
  // A package an install just enabled: scroll it into view and mark it for a moment.
  const { highlight, clearHighlight } = { highlight: state.highlight, clearHighlight: props.clearHighlight }
  useEffect(() => {
    if (highlight === null) return
    const card = document.querySelector(`[data-plugin-package="${highlight}"]`)
    if (card !== null && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(clearHighlight, HIGHLIGHT_MS)
    return () => { clearTimeout(timer) }
  }, [highlight, clearHighlight])
  const noticeLine = state.notice === null ? null : noticeText(state.notice, t)

  // The page manages what the person installed, what the installation ships for them to switch on, and a
  // selected name the Host cannot read; the installation's other bundles are inspected in the Settings
  // Plugins section's Plugin list tab.
  const listed = state.packages.filter(pkg => pkg.installed || pkg.optional || pkg.error !== undefined)
  const mine = listed.filter(pkg => pkg.installed || !pkg.optional)
  const builtin = listed.filter(pkg => pkg.optional && !pkg.installed)
  const loaded = state.status === 'ready' || state.status === 'error'
  const openPkg = openPackage === null ? undefined : listed.find(pkg => pkg.name === openPackage)
  const setRowEnabled = (row: PackageRow, enabled: boolean): void => {
    /* v8 ignore next -- a row without a live entry has its switch disabled */
    if (row.entryId !== undefined) props.setRowEnabled(row.entryId, enabled)
  }
  // One group of cards under its heading and count; the built-in group comes first, and a group with nothing in it takes no room.
  const renderGroup = (id: 'bundles' | 'builtin', heading: string, packages: readonly PackageView[]): ReactNode => packages.length === 0
    ? null
    : (
      <section className={css.group} data-plugin-scope="global" data-plugin-group={id}>
        <div className={css.groupHead}>
          <h3 className={css.groupTitle}>{heading}</h3>
          <span className={css.count} data-plugin-count={packages.length}>{packages.length}</span>
        </div>
        <ul className={css.cards}>
          {packages.map(pkg => (
            <PackageCard
              key={pkg.name}
              pkg={pkg}
              t={t}
              busy={state.busy.includes(pkg.name)}
              highlighted={state.highlight === pkg.name}
              onOpen={() => { setOpenPackage(pkg.name) }}
              onSetEnabled={(enabled) => { props.setEnabled(pkg.name, enabled) }}
            />
          ))}
        </ul>
      </section>
    )

  return (
    <section className={css.page} data-plugin-panel aria-busy={state.status === 'loading'}>
      {openPkg === undefined
        ? (
          <header className={css.pageHead}>
            <div>
              <h1 className={css.pageTitle}>{t('title')}</h1>
              <p className={css.pageIntro}>{t('intro')}</p>
            </div>
            <div className={css.toolbar}>
              <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} disabled={!loaded} onClick={props.refresh}>
                <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutline16 /></span>
              </button>
              <Button variant="primary" size="sm" icon={<IconPlusOutline16 size={13} />} disabled={!loaded} onClick={props.openInstall}>{t('addPlugin')}</Button>
            </div>
          </header>
        )
        : null}
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'unavailable' ? <p className={css.status} role="status">{t('unavailable')}</p> : null}
      {state.status === 'error'
        ? (
          <div className={css.failure}>
            <p role="alert">{t('error')}</p>
            <Button variant="outline" size="sm" onClick={props.refresh}>{t('retry')}</Button>
          </div>
        )
        : null}
      {state.notice === null || noticeLine === null
        ? null
        : (
          <Toast
            key={state.notice.seq}
            text={noticeLine}
            icon={<IconWarningOutline16 />}
            holdMs={toastHoldMs(noticeLine)}
            onDone={props.dismissNotice}
          />
        )}
      {loaded && openPkg !== undefined
        ? (
          <PackageDetail
            pkg={openPkg}
            t={t}
            busy={state.busy.includes(openPkg.name)}
            rowBusy={row => row.entryId !== undefined && state.busy.includes(rowKey(row.entryId))}
            onBack={() => { setOpenPackage(null) }}
            onSetEnabled={(enabled) => { props.setEnabled(openPkg.name, enabled) }}
            onUninstall={() => { props.uninstall(openPkg.name) }}
            onSetRowEnabled={setRowEnabled}
          />
        )
        : null}
      {loaded && openPkg === undefined
        ? listed.length === 0
          ? <p className={css.empty}>{t('empty')}</p>
          : (
            <>
              {renderGroup('builtin', t('builtinTitle'), builtin)}
              {renderGroup('bundles', t('bundlesTitle'), mine)}
            </>
          )
        : null}
      <InstallDialog
        install={state.install}
        t={t}
        onClose={props.closeInstall}
        onEditSpec={props.editInstallSpec}
        onRun={props.runInstall}
        onCancel={props.cancelInstall}
        onToggleDetails={props.toggleInstallDetails}
        onEnableNow={props.enableInstalled}
        onApproveBuilds={props.approveBuildsAndRetry}
      />
      {state.confirm === null
        ? null
        : (
          <ConfirmDialog
            confirm={state.confirm}
            t={t}
            onConfirm={props.confirm}
            onCancel={props.cancelConfirm}
          />
        )}
    </section>
  )
}
