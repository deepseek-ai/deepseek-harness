/**
 * Global plugin management: the Official group's cards for the bundles the
 * installation ships switched off and for the official plugins that register
 * their configuration, the Installed group's cards for the profile's bundles,
 * their row switches, the install dialog with its guide and folded pnpm
 * output, the uninstall confirmation, and the toasts an action's outcome
 * becomes. A bundle's page lists the rows it contributes as the Host runs
 * them; a plugin's configuration renders on its own page through the slots
 * the page declares.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PluginInstallFailureKind, Registry } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconCheckCircleFillRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineMedium,
  IconChevronRightOutlineRegular, IconCloseOutlineMedium,
  IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular,
  IconWarningOutlineRegular, Input, Modal,
  PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkSubagent, PluginArtworkTerminal,
  StateDot, Switch, Tag, TerminalBlock, Toast, useAnchoredPosition, useDismissOnOutsidePointer,
  type IconProps, type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createNavigationStore } from './navigation-store.ts'
import { rowConfigKey, type OfficialItem } from './config-ledger.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import {
  asksMirror, githubRecoveryRegistry, isInstallPending, offeredRegistries, rowKey,
  type InstallInputError, type InstallState, type InstallSubject, type PackageRow, type PackageView,
  type PluginManagerFace, type RegistryChoice,
} from './manager-store.ts'
import { managementText, noticeText, packageText, registryText, rowText, type Translate } from './presentation.ts'
import type { PluginPackageRef, PluginRowRef, PluginsSubject } from './slot-contract.ts'
import type { ConfigPageForm } from './slot-contract.ts'
import css from './PluginManagerPage.module.css'

/** Full component props assembled by the main slot renderer. */
export type PluginManagerPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'pluginManager'>
  & PropsRenderSlots<
    | 'plugins.item' | 'plugins.bundle.config' | 'plugins.row.config' | 'plugins.bundle.activation'
    | 'plugins.detail.actions' | 'plugins.detail.badge' | 'plugins.detail.section'
  >
  & InjectFace<PluginManagerFace>
  & PropsStore<ReturnType<typeof createNavigationStore>>

/** The page's slot renderer, narrowed to the configuration slots. */
type RenderConfig = PluginManagerPageProps['renderSlot']
type ResolveText = PluginManagerFace['resolveText']

type RowPhase = NonNullable<PackageRow['phase']>

/** How long the list marks a package an install just enabled. */
const HIGHLIGHT_MS = 2_400

/** Built-in profile bundles stay out of this page even when the profile declares them as dependencies. */
const BUILTIN_PROFILE_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-minimal',
])

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

/** Status dot naming a root-fiber phase; loading and unloading are live transitions. */
const PHASE_STATES = {
  pending: 'idle',
  loading: 'ongoing',
  active: 'done',
  failed: 'error',
  unloading: 'ongoing',
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

/** Configuration for a pack's rows: which rows registered a page of their own, and opening it. */
interface RowConfigure {
  readonly has: (row: PackageRow) => boolean
  readonly open: (row: PackageRow) => void
}

/** Rows beyond this count get a filter box above the list. */
const ROW_FILTER_THRESHOLD = 10

/** The size the 36-viewBox plugin artwork renders at inside a card's 48px frame. */
const CARD_ARTWORK_SIZE = 36

/** The size the artwork renders at inside a row's 40px frame. */
const ROW_ARTWORK_SIZE = 30

/** The artwork of the official plugins that registered their configuration, by registration id. */
const ITEM_ARTWORK = new Map<string, (props: IconProps) => ReactNode>([
  ['shell', PluginArtworkTerminal],
  ['agent-loop', PluginArtworkLoop],
  ['subagent', PluginArtworkSubagent],
  ['web-search', PluginArtworkSearch],
])

/** An official plugin's card and page artwork; plugins without their own get the default. */
function itemArtwork(id: string): ReactNode {
  const Artwork = ITEM_ARTWORK.get(id) ?? PluginArtworkDefault
  return <Artwork size={CARD_ARTWORK_SIZE} />
}

/** Manifest images remain isolated from the page DOM; a failed decode keeps the position's default artwork. */
function PackageArtwork({ src, row = false, size = row ? ROW_ARTWORK_SIZE : CARD_ARTWORK_SIZE }: {
  readonly src: string | undefined
  readonly row?: boolean
  readonly size?: number
}): ReactNode {
  const [failedSource, setFailedSource] = useState<string>()
  const Fallback = row ? PluginArtworkSubagent : PluginArtworkDefault
  return src === undefined || src === failedSource
    ? <Fallback size={size} />
    : <img className={css.packageImage} src={src} width={size} height={size} alt="" onError={() => { setFailedSource(src) }} />
}

/** A row's switch: locked, saying why, when the Host refuses to address the row through the profile patch. */
function RowSwitch({ row, title, t, busy, onChange }: {
  readonly row: PackageRow
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly onChange: (enabled: boolean) => void
}): ReactNode {
  const locked = row.readOnlyReason !== undefined || row.entryId === undefined
  return (
    <Switch
      checked={row.enabled}
      label={t('partToggle', { name: title })}
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

/** A Host metadata diagnostic does not change the package's management permissions. */
function MetadataError({ error, t }: { readonly error: string | undefined; readonly t: Translate }): ReactNode {
  return error === undefined ? null : <p className={css.reason} role="status" data-package-meta-error>{t('metadataError', { error })}</p>
}

/**
 * A pack's rows as a list in the order the pack declares them: a state dot,
 * the row id, one line saying its state, a configure control for a row that
 * registered a page, and, when the pack is on, a switch. A pack like base
 * carries close to a hundred rows, so a long list gets a filter.
 */
function RowsSection({ rows, t, resolveText, toggle, configure }: {
  readonly rows: readonly PackageRow[]
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly toggle?: RowToggles | undefined
  readonly configure?: RowConfigure | undefined
}): ReactNode {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const localized = rows.map(row => ({ row, ...rowText(row, resolveText) }))
  const shown = query === '' ? localized : localized.filter(({ row, title, description }) =>
    [title, description, row.rowId, row.moduleName].some(value => value?.toLowerCase().includes(query)))
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
            {shown.map(({ row, title, description }) => (
              <li
                key={row.rowId}
                className={css.row}
                data-plugin-row={row.entryId ?? row.rowId}
                {...row.phase === 'failed' ? { 'data-state': 'failed' } : row.enabled ? {} : { 'data-state': 'off' }}
              >
                <div className={css.rowLine}>
                  <span className={css.rowIcon} aria-hidden="true"><PackageArtwork key={row.meta?.icon} src={row.meta?.icon} row /></span>
                  <div className={css.rowMain}>
                    {configure?.has(row) === true
                      ? (
                        <button type="button" className={css.rowOpen} aria-label={t('configureRow', { name: title })} onClick={() => { configure.open(row) }}>
                          <span className={css.rowId}>{title}</span>
                          <IconChevronRightOutlineRegular className={css.rowOpenIcon} aria-hidden="true" />
                        </button>
                      )
                      : <span className={css.rowId}>{title}</span>}
                    {description === undefined ? null : <span className={css.rowModule}>{description}</span>}
                    {title === row.rowId ? null : <code className={css.rowModule}>{row.rowId}</code>}
                    {title === row.moduleName ? null : <code className={css.rowModule}>{row.moduleName}</code>}
                  </div>
                  <span className={css.rowState}>
                    <StateDot state={rowDotState(row)} />
                    {rowStateText(row, t)}
                  </span>
                  {toggle === undefined
                    ? null
                    : <RowSwitch
                      row={row} title={title} t={t} busy={toggle.busy(row)}
                      onChange={(enabled) => { toggle.onSetEnabled(row, enabled) }}
                    />}
                </div>
                <MetadataError error={row.meta?.error} t={t} />
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

/** The head every card shares: the artwork, the name that opens the page beside its tags, its one-liner, and what sits at the end. */
function CardHead({ title, t, onOpen, icon, tags, description, end }: {
  readonly title: string
  readonly t: Translate
  readonly onOpen: () => void
  readonly icon: ReactNode
  readonly tags?: ReactNode
  readonly description: ReactNode
  readonly end?: ReactNode
}): ReactNode {
  const descriptionId = useId()
  return (
    <div className={css.cardHead}>
      <span className={css.cardIcon} aria-hidden="true">{icon}</span>
      <div className={css.cardMain}>
        <div className={css.titleRow}>
          <button type="button" className={`${css.cardTitle} ${css.cardOpen}`} aria-label={t('openDetail', { name: title })} aria-describedby={description === undefined ? undefined : descriptionId} onClick={onOpen}>{title}</button>
          {tags}
        </div>
        {description === undefined ? null : <span className={css.cardDesc} id={descriptionId}>{description}</span>}
      </div>
      {end === undefined ? null : <div className={css.cardEnd}>{end}</div>}
    </div>
  )
}

/** The top every page shares: the crumb that leads back, then the icon with the page's actions at its right. */
function DetailTop({ crumbLabel, crumbText, onBack, icon, actions }: {
  readonly crumbLabel: string
  readonly crumbText: string
  readonly onBack: () => void
  readonly icon: ReactNode
  readonly actions?: ReactNode
}): ReactNode {
  return (
    <div className={css.detailTop} data-window-drag>
      <button type="button" className={css.crumb} aria-label={crumbLabel} onClick={onBack}>
        <IconChevronDownOutlineRegular className={css.crumbIcon} aria-hidden="true" />
        <span>{crumbText}</span>
      </button>
      <div className={css.detailHead}>
        <span className={css.cardIcon} aria-hidden="true">{icon}</span>
        {actions}
      </div>
    </div>
  )
}

/** One package as a card that opens its page: its name, its one-liner, its tags, and its bundle switch. */
function PackageCard({ pkg, t, resolveText, busy, highlighted, onOpen, onSetEnabled }: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly busy: boolean
  readonly highlighted: boolean
  readonly onOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  const { title, description, beta } = packageText(pkg, resolveText)
  const status = packageStatus(pkg)
  return (
    <li
      className={`${css.card} ${css.cardLink}`}
      data-plugin-package={pkg.name}
      data-plugin-status={status}
      {...highlighted ? { 'data-plugin-highlight': '' } : {}}
    >
      <CardHead
        title={title}
        t={t}
        onOpen={onOpen}
        icon={<PackageArtwork key={pkg.meta?.icon} src={pkg.meta?.icon} />}
        tags={(
          <>
            {beta ? <Tag className={css.statusTag} tone="info">{t('statusBeta')}</Tag> : null}
            {status === 'problem' ? <Tag className={css.statusTag} tone="danger">{t('statusProblem')}</Tag> : null}
          </>
        )}
        description={description}
        end={<EnableSwitch pkg={pkg} title={title} t={t} busy={busy} onSetEnabled={onSetEnabled} />}
      />
      <MetadataError error={pkg.meta?.error} t={t} />
    </li>
  )
}

/**
 * One official plugin as a card that opens its page: its icon, its title from
 * the registration, and the one-liner the entry renders in its summary view.
 */
function ItemCard({ item, t, onOpen, renderSlot }: {
  readonly item: OfficialItem
  readonly t: Translate
  readonly onOpen: () => void
  readonly renderSlot: RenderConfig
}): ReactNode {
  return (
    <li className={`${css.card} ${css.cardLink}`} data-plugin-item={item.id}>
      <CardHead title={item.label} t={t} onOpen={onOpen} icon={itemArtwork(item.id)} description={renderSlot('plugins.item', { view: 'summary' }, { only: item.id })} />
    </li>
  )
}

/** One row as the detail slots see it. */
function rowRef(row: PackageRow): PluginRowRef {
  return { rowId: row.rowId, moduleName: row.moduleName, enabled: row.enabled }
}

/** One bundle as the detail slots see it. */
function packageRef(pkg: PackageView): PluginPackageRef {
  return {
    name: pkg.name,
    ...pkg.version === undefined ? {} : { version: pkg.version },
    installed: pkg.installed,
    enabled: pkg.enabled,
    rows: pkg.rows.map(rowRef),
  }
}

/**
 * An official plugin's page: the crumb back to the cards, its icon with the
 * contributed actions, its title with the contributed badges over its
 * one-liner, the form the entry renders, and the contributed sections.
 */
function ItemDetail({ item, t, onBack, renderSlot, form }: {
  readonly item: OfficialItem
  readonly t: Translate
  readonly onBack: () => void
  readonly renderSlot: RenderConfig
  readonly form: ConfigPageForm | undefined
}): ReactNode {
  const subject: PluginsSubject = { kind: 'item', id: item.id }
  return (
    <div className={css.detail} data-plugin-item-detail={item.id}>
      <DetailTop
        crumbLabel={t('backToList')}
        crumbText={t('crumbRoot')}
        onBack={onBack}
        icon={itemArtwork(item.id)}
        actions={<div className={css.detailActions}>{renderSlot('plugins.detail.actions', { subject })}</div>}
      />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{item.label}</h3>
          {renderSlot('plugins.detail.badge', { subject })}
        </div>
        <p className={css.detailDesc}>{renderSlot('plugins.item', { view: 'summary' }, { only: item.id })}</p>
      </div>
      <div className={css.detailSections}>
        <section className={css.detailSection} data-plugin-config>
          {renderSlot('plugins.item', { view: 'page', form }, { only: item.id })}
        </section>
        {renderSlot('plugins.detail.section', { subject })}
      </div>
    </div>
  )
}

/**
 * A row's configuration page keeps its technical identity beside local package
 * text and the form supplied by its configuration entry.
 */
function RowDetail({ pkg, row, t, resolveText, onBack, renderSlot, form }: {
  readonly pkg: PackageView
  readonly row: PackageRow
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly onBack: () => void
  readonly renderSlot: RenderConfig
  readonly form: ConfigPageForm | undefined
}): ReactNode {
  const { title } = packageText(pkg, resolveText)
  const { title: rowTitle, description } = rowText(row, resolveText)
  const key = rowConfigKey(pkg.name, row.rowId)
  const subject: PluginsSubject = { kind: 'row', pkg: packageRef(pkg), row: rowRef(row) }
  return (
    <div className={css.detail} data-plugin-row-detail={key}>
      <DetailTop
        crumbLabel={t('backToPackage', { name: title })}
        crumbText={title}
        onBack={onBack}
        icon={<PackageArtwork key={row.meta?.icon} src={row.meta?.icon} row size={CARD_ARTWORK_SIZE} />}
        actions={<div className={css.detailActions}>{renderSlot('plugins.detail.actions', { subject })}</div>}
      />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{rowTitle}</h3>
          {renderSlot('plugins.detail.badge', { subject })}
        </div>
        {rowTitle === row.rowId ? null : <p className={css.detailName}><code>{row.rowId}</code></p>}
        <p className={css.detailName}><code>{row.moduleName}</code></p>
        <p className={css.detailDesc}>{description ?? renderSlot('plugins.row.config', { view: 'summary' }, { entryKey: key })}</p>
      </div>
      <MetadataError error={row.meta?.error} t={t} />
      <div className={css.detailSections} data-plugin-config>
        {renderSlot('plugins.row.config', { view: 'page', form }, { entryKey: key })}
        {renderSlot('plugins.detail.section', { subject })}
      </div>
    </div>
  )
}

/**
 * One package's page: the crumb back to the list; its icon with its switch
 * and, for a package the profile installed, uninstall; its title beside its
 * version tag, its beta tag, and its problem tag; the package name the title
 * stands for, which is what installs it elsewhere; its one-liner; the Host's
 * problem when it reports one; the configuration the bundle registered for
 * itself; and its rows with their switches and configure controls.
 */
function PackageDetail({
  pkg, t, resolveText, busy, rowBusy, configured, configure, renderSlot,
  onBack, onSetEnabled, onUninstall, onSetRowEnabled,
}: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly busy: boolean
  /** Whether a row has a write in flight. */
  readonly rowBusy: (row: PackageRow) => boolean
  /** Whether the bundle registered a configuration of its own. */
  readonly configured: boolean
  readonly configure: RowConfigure
  readonly renderSlot: RenderConfig
  readonly onBack: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onUninstall: () => void
  readonly onSetRowEnabled: (row: PackageRow, enabled: boolean) => void
}): ReactNode {
  const { title, description, beta } = packageText(pkg, resolveText)
  const status = packageStatus(pkg)
  const subject: PluginsSubject = { kind: 'bundle', pkg: packageRef(pkg) }
  return (
    <div className={css.detail} data-plugin-detail={pkg.name}>
      <DetailTop
        crumbLabel={t('backToList')}
        crumbText={t('crumbRoot')}
        onBack={onBack}
        icon={<PackageArtwork key={pkg.meta?.icon} src={pkg.meta?.icon} />}
        actions={(
          <div className={css.detailActions}>
            {renderSlot('plugins.detail.actions', { subject })}
            {pkg.installed
              ? (
                <Button
                  variant="outline"
                  size="sm"
                  className={css.danger}
                  icon={<IconTrashOutlineRegular size={13} />}
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
        )}
      />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{title}</h3>
          {pkg.version === undefined ? null : <Tag className={css.versionTag} tone="neutral">{t('versionTag', { version: pkg.version })}</Tag>}
          {beta ? <Tag className={css.statusTag} tone="info">{t('statusBeta')}</Tag> : null}
          {status === 'problem' ? <Tag className={css.statusTag} tone="danger">{t('statusProblem')}</Tag> : null}
          {renderSlot('plugins.detail.badge', { subject })}
        </div>
        <p className={css.detailName}><code data-plugin-name>{pkg.name}</code></p>
        {description === undefined ? null : <p className={css.detailDesc}>{description}</p>}
      </div>
      <MetadataError error={pkg.meta?.error} t={t} />
      {pkg.error === undefined ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {managementText(pkg.error, t)}</p>}
      {pkg.readOnlyReason === undefined ? null : <p className={css.reason} role="status">{managementText({ code: pkg.readOnlyReason }, t)}</p>}
      <div className={css.detailSections}>
        {configured
          ? (
            <section className={css.detailSection} data-plugin-config>
              {renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })}
            </section>
          )
          : null}
        <RowsSection
          rows={pkg.rows}
          t={t}
          resolveText={resolveText}
          toggle={pkg.enabled ? { busy: row => busy || rowBusy(row), onSetEnabled: onSetRowEnabled } : undefined}
          configure={configure}
        />
        {renderSlot('plugins.detail.section', { subject })}
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
  unconfirmed: 'installUnconfirmedTitle',
  unknown: 'installUnknownTitle',
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

/** The registries asked, by name, in the dictionary's list form. */
function registryList(registries: readonly Registry[], t: Translate, resolved: string | null): string {
  return registries.map(registry => registryText(registry, t, resolved).name).join(t('registryListSeparator'))
}

/** An option's label: the registry's name with the host it names, unless the host is the name. */
function registryOption(registry: Registry, t: Translate, resolved: string | null): string {
  const { name, host } = registryText(registry, t, resolved)
  return name === host ? name : t('registryWithHost', { name, host })
}

/**
 * The failed screen's one line: a pnpm failure by its kind, a refusal by its
 * code, any other failure in the Host's words; the run's output stays behind the details.
 * A run the Host laid at the spec's own host says so; one it laid at a registry
 * names every registry asked when there were several.
 */
function failureText(failure: InstallState['failure'], t: Translate, install?: Pick<InstallState, 'attempts' | 'subject' | 'registries'>): string {
  if (failure === null) return t('installFailureGeneric')
  // A compatibility refusal is the package's own answer, whatever pnpm's exit classified the run as.
  if (failure.code === 'incompatible-version') {
    return managementText({ code: failure.code, ...failure.incompatible === undefined ? {} : { incompatible: failure.incompatible } }, t)
  }
  // Blocked scripts the Host could not name leave the person to allow them in the profile's pnpm settings by hand.
  if (failure.kind === 'build-blocked' && !failure.pendingBuilds?.length) return t('installFailureBuildBlockedManual')
  const host = install?.subject?.host
  if (failure.failedAt === 'spec-host' && host !== undefined) return t('installFailureNetworkHost', { host })
  const asked = install?.attempts?.registries ?? []
  if (failure.failedAt === 'registry' && (failure.kind === 'network' || failure.kind === 'timeout') && asked.length > 1) {
    return t('installFailureNetworkAll', { registries: registryList(asked, t, install?.registries?.resolved ?? null) })
  }
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
function InstallDialog({
  install, t, onClose, onEditSpec, onRun, onCancel, onReconcile, onToggleDetails, onEnableNow, onApproveBuilds,
  onToggleRegistry, onChooseRegistry, onChangeRegistry, onUseGithubMirror,
}: {
  readonly install: InstallState
  readonly t: Translate
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
  readonly onReconcile: () => void
  readonly onToggleDetails: () => void
  readonly onEnableNow: () => void
  readonly onApproveBuilds: () => void
  readonly onToggleRegistry: () => void
  readonly onChooseRegistry: (choice: RegistryChoice) => void
  /** From the failed screen: back to the spec with the registry options unfolded. */
  readonly onChangeRegistry: () => void
  readonly onUseGithubMirror: () => void
}): ReactNode {
  const errorId = useId()
  const guideId = useId()
  const approvalId = useId()
  const registryId = useId()
  const registryErrorId = useId()
  const [guideOpen, setGuideOpen] = useState(false)
  const { phase } = install
  // The registry options float over the dialog from their toggle, so unfolding them never adds to its height;
  // the store folds them when a run starts, so they show at the spec only.
  const registryToggleRef = useRef<HTMLButtonElement | null>(null)
  const registryPanelRef = useRef<HTMLFieldSetElement | null>(null)
  const registryShown = install.registryOpen && phase === 'idle'
  const registryPosition = useAnchoredPosition({
    open: registryShown, anchorRef: registryToggleRef, panelRef: registryPanelRef, align: 'end', gap: 6, margin: 12,
  })
  // The hook only ever asks to close.
  useDismissOnOutsidePointer(registryToggleRef, registryShown, onToggleRegistry, registryPanelRef)
  useEffect(() => {
    if (!registryShown) return
    // Escape folds the options and goes no further: the dialog under them listens for the same key.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onToggleRegistry()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [registryShown, onToggleRegistry])
  if (githubRecoveryRegistry(install) !== undefined) {
    const anotherWay = asksMirror(install)
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t(install.failure?.kind === 'timeout' ? 'installGithubTimeoutTitle' : 'installGithubFailedTitle')}
        closeLabel={t('close')}
        description={t('installGithubFailedDescription')}
        footer={(
          <>
            <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                // The mirror is already asked, so the form opens with the guide to the other kinds of spec.
                if (anotherWay) setGuideOpen(true)
                onUseGithubMirror()
              }}
            >
              {t(anotherWay ? 'installTryAnotherWay' : 'installUseGithubMirror')}
            </Button>
          </>
        )}
      />
    )
  }
  if (phase === 'idle' || phase === 'checking') {
    const checking = phase === 'checking'
    const empty = install.spec.trim() === ''
    const choice = install.registry
    const resolved = install.registries?.resolved ?? null
    const chosenTitle = choice.kind === 'custom' ? t('registryCustom') : registryText(choice.registry, t, resolved).name
    const inputProblem = install.inputError
    // A check no registry answered names every registry asked; any other refusal reads by its problem.
    const askedByCheck = inputProblem?.registries ?? []
    const inputSentence = inputProblem === null
      ? null
      : inputProblem.problem === 'network' && askedByCheck.length > 1
        ? t('installProblemNetworkAll', { registries: registryList(askedByCheck, t, resolved) })
        : t(INPUT_PROBLEM_KEYS[inputProblem.problem], { reason: inputProblem.reason })
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t('installTitle')}
        closeLabel={t('close')}
        {...install.mirrorRecovery ? {} : { description: t('installDescription') }}
        className={css.installDialog as string}
        contentClassName={css.installContent as string}
        footer={(
          <Button variant="primary" className={css.wide} disabled={checking || empty} aria-busy={checking} onClick={onRun}>
            {checking ? <StateDot state="ongoing" /> : null}
            {t(checking ? 'installChecking' : 'installRun')}
          </Button>
        )}
      >
        <div className={css.installBody}>
          <div className={css.installField}>
            <input
              type="text"
              autoFocus={install.mirrorRecovery === true}
              value={install.spec}
              placeholder={t('installSpecPlaceholder')}
              disabled={checking}
              aria-label={t(install.mirrorRecovery ? 'installPackageLabel' : 'installSpecLabel')}
              aria-invalid={install.inputError !== null}
              aria-describedby={install.inputError === null ? undefined : errorId}
              onChange={(event) => { onEditSpec(event.currentTarget.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !empty && !checking) onRun() }}
            />
          </div>
          {inputSentence === null
            ? null
            : <p id={errorId} className={css.inputError} role="alert">{inputSentence}</p>}
          <div className={css.optionsRow}>
            <button
              type="button"
              className={css.guideToggle}
              aria-expanded={guideOpen}
              aria-controls={guideId}
              onClick={() => { setGuideOpen(open => !open) }}
            >
              <IconChevronDownOutlineRegular className={css.guideChevron} aria-hidden="true" />
              <span>{t(guideOpen ? 'installGuideHide' : 'installGuideToggle')}</span>
            </button>
            <button
              ref={registryToggleRef}
              type="button"
              className={css.registryToggle}
              aria-expanded={install.registryOpen}
              aria-controls={registryId}
              aria-haspopup="dialog"
              disabled={checking}
              onClick={onToggleRegistry}
            >
              <span>{t('registryToggle')}</span>
              {' '}
              <span className={css.registryChosen}>{chosenTitle}</span>
              <IconChevronDownOutlineRegular className={css.guideChevron} aria-hidden="true" />
            </button>
          </div>
          {guideOpen
            ? (
              <div id={guideId} className={css.guide} data-install-guide>
                <ol className={css.guideList}>
                  {GUIDE_EXAMPLES.map(({ key, titleKey, exampleKey, hintKey }, index) => (
                    <li key={key} className={css.guideItem}>
                      <span className={css.guideIndex} aria-hidden="true">{index + 1}</span>
                      <div className={css.guideMain}>
                        <span className={css.guideTitle}>{t(titleKey)}</span>
                        <span className={css.guideHint}>{t(hintKey)}</span>
                        <span className={css.guideExample}>
                          <span className={css.guideExampleLabel}>{t('installGuideExampleLabel')}</span>
                          <code>{t(exampleKey)}</code>
                        </span>
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
                  <IconWarningOutlineRegular size={14} aria-hidden="true" />
                  <span>{t('installGuideSafety')}</span>
                </p>
              </div>
            )
            : null}
          {registryShown
            ? createPortal(
              <fieldset
                ref={registryPanelRef}
                id={registryId}
                className={css.registry}
                style={registryPosition ?? { visibility: 'hidden', left: 0, top: 0 }}
                data-install-registry
                aria-label={t('registryLegend')}
              >
                {offeredRegistries(install.registries).map((registry) => {
                  const checked = choice.kind === 'offered' && choice.registry === registry
                  return (
                    <label key={registry ?? ''} className={css.registryOption} data-checked={checked}>
                      <input type="radio" name={registryId} checked={checked} onChange={() => { onChooseRegistry({ kind: 'offered', registry }) }} />
                      <span className={css.registryTitle}><span>{registryOption(registry, t, resolved)}</span></span>
                    </label>
                  )
                })}
                <div className={css.registryOption} data-checked={choice.kind === 'custom'}>
                  <label className={css.registryCustomPick}>
                    <input
                      type="radio"
                      name={registryId}
                      checked={choice.kind === 'custom'}
                      onChange={() => { onChooseRegistry({ kind: 'custom', url: '' }) }}
                    />
                    <span className={css.registryTitle}><span>{t('registryCustom')}</span></span>
                  </label>
                  <input
                    type="text"
                    className={css.registryCustomField}
                    aria-label={t('registryCustom')}
                    placeholder={t('registryCustomPlaceholder')}
                    value={choice.kind === 'custom' ? choice.url : ''}
                    disabled={choice.kind !== 'custom'}
                    aria-invalid={install.registryError}
                    aria-describedby={install.registryError ? registryErrorId : undefined}
                    onChange={(event) => { onChooseRegistry({ kind: 'custom', url: event.currentTarget.value }) }}
                    onKeyDown={(event) => { if (event.key === 'Enter' && !empty) onRun() }}
                  />
                  {install.registryError
                    ? <p id={registryErrorId} className={css.inputError} role="alert">{t('registryCustomInvalid')}</p>
                    : null}
                  <span className={css.registryHint}>{t('registryCustomHint')}</span>
                </div>
              </fieldset>,
              document.body,
            )
            : null}
        </div>
      </Modal>
    )
  }
  const heading = t(SCREEN_TITLE_KEYS[phase])
  const pending = isInstallPending(phase)
  const cancellable = phase === 'starting' || phase === 'running' || phase === 'unconfirmed'
  const stoppable = cancellable || phase === 'failed' || phase === 'unknown'
  const failure = install.failure
  const uncertainty = failure?.uncertainty
  const uncertaintyText = failure?.uncertainty === undefined ? null : t(({
    result: 'installResultUnconfirmed',
    cancellation: phase === 'applying' ? 'installApplyingCancellationError' : 'installCancelUnconfirmed',
    acceptance: 'installAwaitingAcceptance',
  } as const)[failure.uncertainty], { reason: failure.reason })
  const pendingBuilds = phase === 'failed' ? install.failure?.pendingBuilds ?? [] : []
  const approvable = pendingBuilds.length > 0
  const firstRun = install.runs[0]
  // The registries the Host asked, once there is more than one: the attempt under way while it runs, a badge on each run.
  const asked = install.attempts !== null && install.attempts.registries.length > 1 ? install.attempts : null
  const current = asked === null ? undefined : asked.registries.at(-1)
  const previous = asked === null ? undefined : asked.registries.at(-2)
  const resolved = install.registries?.resolved ?? null
  const attemptLine = pending && asked !== null && current !== undefined && previous !== undefined
    ? t('installAttempt', {
      previous: registryText(previous, t, resolved).name, registry: registryText(current, t, resolved).name,
      index: String(asked.registries.length), total: String(asked.total),
    })
    : null
  // Another registry is worth offering only for a failure the Host laid at the one it asked.
  const changeable = phase === 'failed' && !approvable && install.failure?.failedAt === 'registry'
  return (
    <Modal open={install.open} onClose={onClose} title={heading} headless className={css.installDialog as string}>
      <div className={css.wizard} data-install-phase={phase}>
        <div className={css.wizardHead}>
          {phase === 'done'
            ? <span />
            : (
              <button type="button" className={css.wizardBack} aria-label={t(pending ? 'installCancelAndEdit' : 'installEditAria')} disabled={!stoppable} onClick={onCancel}>
                <IconChevronLeftOutlineMedium aria-hidden="true" />
                <span>{t(pending ? 'installCancelAndEdit' : 'installEdit')}</span>
              </button>
            )}
          <button
            type="button"
            className={css.wizardClose}
            aria-label={t(cancellable ? 'installCloseCancels' : 'close')}
            onClick={onClose}
          >
            <IconCloseOutlineMedium size={14} />
          </button>
        </div>
        <div className={css.wizardScroll}>
          <div className={css.wizardHero}>
            <span className={css.wizardIcon} data-state={pending ? 'ongoing' : phase === 'done' ? 'done' : 'error'} aria-hidden="true">
              {pending
                ? <StateDot state="ongoing" size={28} />
                : phase === 'done'
                  ? <IconCheckCircleFillRegular size={28} />
                  : <IconWarningOutlineRegular size={28} />}
            </span>
            <h2 className={css.wizardTitle} role={phase === 'failed' ? 'alert' : 'status'}>{heading}</h2>
            {phase === 'failed' ? <p className={css.wizardSub}>{failureText(install.failure, t, install)}</p> : null}
            {attemptLine === null ? null : <p className={css.wizardSub}>{attemptLine}</p>}
            {uncertaintyText === null ? null : <p className={css.wizardSub} role="alert">{uncertaintyText}</p>}
            {phase === 'unknown' ? <p className={css.wizardSub}>{t('installUnknownDescription')}</p> : null}
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
              <IconChevronDownOutlineRegular className={css.detailsChevron} aria-hidden="true" />
            </button>
            {uncertainty === 'result' ? <Button variant="outline" size="sm" className={css.footAction} onClick={onReconcile}>{t('installReconcile')}</Button> : null}
            {pending
              ? (
                <Button variant="outline" size="sm" className={css.footAction} disabled={!cancellable} onClick={onCancel}>
                  {t(phase === 'cancelling' ? 'installCancelling' : 'installCancel')}
                </Button>
              )
              : null}
            {phase === 'failed' && !approvable
              ? (
                <span className={css.wizardActions}>
                  {changeable
                    ? <Button variant="outline" size="sm" className={css.footAction} onClick={onChangeRegistry}>{t('installChangeRegistry')}</Button>
                    : null}
                  <Button variant="primary" size="sm" className={css.footAction} onClick={onRun}>{t('installRetry')}</Button>
                </span>
              )
              : null}
          </div>
          {install.detailsOpen
            ? (
              <div className={css.detailsBody}>
                <p className={css.installLocation}>{firstRun === undefined ? t('terminalNoOutput') : t('installLocation', { dir: firstRun.cwd })}</p>
                {install.runs.map((run, index) => {
                  const registry = asked?.registries[index]
                  return (
                    <div key={run.jobId} className={css.run}>
                      {registry === undefined
                        ? null
                        : <p className={css.attemptBadge}>{t('installAttemptBadge', { index: String(index + 1), registry: registryText(registry, t, resolved).name })}</p>}
                      <TerminalBlock
                        command={run.command}
                        output={run.output}
                        running={run.exitCode === undefined}
                        exitCode={run.exitCode}
                        maxLines={INSTALL_TERMINAL_LINES}
                        labels={{ ...terminalLabels(t), ...phase === 'cancelling' ? { failed: t('installCancelledShort') } : {} }}
                        className={css.terminal}
                      />
                    </div>
                  )
                })}
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
function ConfirmDialog({ name, t, onConfirm, onCancel }: {
  readonly name: string
  readonly t: Translate
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
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

/** Render the plugin manager: the official plugins and installed bundles, their pages, the install dialog, and the confirmation. */
export function PluginManagerPage(props: PluginManagerPageProps): ReactNode {
  const { t, ensure, renderSlot, resolveText } = props
  const configurations = props.useConfigurations(snapshot => snapshot.view?.namespaces)
  const formFor = (id: string): ConfigPageForm | undefined => {
    if (!configurations?.some(view => view.ns === id)) return undefined
    const form = props.configForm<Record<string, unknown>>(id)
    return { state: form.getSnapshot(), mutate: (ops, revision) => form.mutate(ops, revision) }
  }
  const state = props.usePluginManager(snapshot => snapshot)
  const ledger = props.useConfigLedger(snapshot => snapshot)
  // What is open; a package that leaves the list (uninstalled) drops back to the cards.
  const view = props.useStore(state => state.view), { setView } = props.actions
  const [activation, setActivation] = useState<string | null>(null)
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
  const listed = state.packages.filter(pkg => !BUILTIN_PROFILE_BUNDLES.has(pkg.name)
    && (pkg.installed || pkg.optional || pkg.error !== undefined))
  const mine = listed.filter(pkg => pkg.installed || !pkg.optional)
  const official = listed.filter(pkg => pkg.optional && !pkg.installed)
  const loaded = state.status === 'ready' || state.status === 'error'
  const openPkg = view.kind === 'package' || view.kind === 'row' ? listed.find(pkg => pkg.name === view.name) : undefined
  const openItem = view.kind === 'item' ? ledger.items.find(item => item.id === view.id) : undefined
  const openRow = view.kind === 'row' && openPkg !== undefined ? openPkg.rows.find(row => row.rowId === view.rowId) : undefined
  const showsCards = openPkg === undefined && openItem === undefined
  const activated = listed.find(pkg => pkg.name === activation && pkg.enabled && !state.busy.includes(pkg.name))
  const setRowEnabled = (row: PackageRow, enabled: boolean): void => {
    /* v8 ignore next -- a row without a live entry has its switch disabled */
    if (row.entryId !== undefined) props.setRowEnabled(row.entryId, enabled)
  }
  const configure = (pkg: PackageView): RowConfigure => ({
    has: row => ledger.rows.has(rowConfigKey(pkg.name, row.rowId)),
    open: (row) => { setView({ kind: 'row', name: pkg.name, rowId: row.rowId }) },
  })
  const packageCard = (pkg: PackageView): ReactNode => (
    <PackageCard
      key={pkg.name}
      pkg={pkg}
      t={t}
      resolveText={resolveText}
      busy={state.busy.includes(pkg.name)}
      highlighted={state.highlight === pkg.name}
      onOpen={() => { setActivation(null); setView({ kind: 'package', name: pkg.name }) }}
      onSetEnabled={(enabled) => { setActivation(enabled ? pkg.name : null); props.setEnabled(pkg.name, enabled) }}
    />
  )
  // The Official group: the bundles the installation ships, then the plugins that registered their configuration.
  const officialCards = [
    ...official.map(packageCard),
    ...ledger.items.map(item => (
      <ItemCard key={`item:${item.id}`} item={item} t={t} renderSlot={renderSlot} onOpen={() => { setView({ kind: 'item', id: item.id }) }} />
    )),
  ]
  // One group of cards under its heading and count; the Official group comes first, and a group with nothing in it takes no room.
  const renderGroup = (id: 'official' | 'bundles', heading: string, cards: readonly ReactNode[]): ReactNode => cards.length === 0
    ? null
    : (
      <section className={css.group} data-plugin-scope="global" data-plugin-group={id}>
        <div className={css.groupHead}>
          <h3 className={css.groupTitle}>{heading}</h3>
          <span className={css.count} data-plugin-count={cards.length}>{cards.length}</span>
        </div>
        <ul className={css.cards}>{cards}</ul>
      </section>
    )

  return (
    <section className={css.page} data-plugin-panel aria-busy={state.status === 'loading'}>
      {showsCards
        ? (
          <header className={css.pageHead} data-window-drag>
            <div>
              <h1 className={css.pageTitle}>{t('title')}</h1>
              <p className={css.pageIntro}>{t('intro')}</p>
            </div>
            <div className={css.toolbar}>
              <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} disabled={!loaded} onClick={props.refresh}>
                <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutlineRegular /></span>
              </button>
              <Button variant="primary" size="sm" className={css.addButton} icon={<IconPlusOutlineRegular size={13} />} disabled={!loaded} onClick={props.openInstall}>
                {t(state.install.requestId === undefined ? 'addPlugin' : 'installViewTask')}
              </Button>
            </div>
          </header>
        )
        : null}
      {showsCards && state.status === 'loading' ? (
        <p className={`${css.status} ${css.statusWithDot}`} role="status">
          <StateDot state="ongoing" />{t('loading')}
        </p>
      ) : null}
      {showsCards && state.status === 'unavailable' ? (
        <p className={`${css.status} ${css.statusWithDot}`} role="status">
          <StateDot state="idle" />{t('unavailable')}
        </p>
      ) : null}
      {state.notice === null || noticeLine === null
        ? null
        : (
          <Toast
            key={state.notice.seq}
            text={noticeLine}
            icon={<IconWarningOutlineRegular />}
            holdMs={toastHoldMs(noticeLine)}
            onDone={props.dismissNotice}
          />
        )}
      {!showsCards && state.status === 'error'
        ? (
          <div className={css.failure}>
            <p className={css.statusWithDot} role="alert">
              <StateDot state="error" />{t('error')}
            </p>
            <Button variant="outline" size="sm" onClick={props.refresh}>{t('retry')}</Button>
          </div>
        )
        : null}
      {loaded && openPkg !== undefined && openRow !== undefined
        ? (
          <RowDetail
            pkg={openPkg}
            row={openRow}
            form={formFor(openRow.rowId)}
            t={t}
            resolveText={resolveText}
            renderSlot={renderSlot}
            onBack={() => { setView({ kind: 'package', name: openPkg.name }) }}
          />
        )
        : null}
      {loaded && openPkg !== undefined && openRow === undefined
        ? (
          <PackageDetail
            pkg={openPkg}
            t={t}
            resolveText={resolveText}
            busy={state.busy.includes(openPkg.name)}
            rowBusy={row => row.entryId !== undefined && state.busy.includes(rowKey(row.entryId))}
            configured={ledger.bundles.has(openPkg.name)}
            configure={configure(openPkg)}
            renderSlot={renderSlot}
            onBack={() => { setView({ kind: 'list' }) }}
            onSetEnabled={(enabled) => { props.setEnabled(openPkg.name, enabled) }}
            onUninstall={() => { props.uninstall(openPkg.name) }}
            onSetRowEnabled={setRowEnabled}
          />
        )
        : null}
      {loaded && openItem !== undefined
        ? <ItemDetail form={formFor(openItem.id)} item={openItem} t={t} renderSlot={renderSlot} onBack={() => { setView({ kind: 'list' }) }} />
        : null}
      {loaded && showsCards
        ? officialCards.length === 0 && mine.length === 0 && state.status !== 'error'
          ? <p className={css.empty}>{t('empty')}</p>
          : (
            <>
              {renderGroup('official', t('officialTitle'), officialCards)}
              {renderGroup('bundles', t('bundlesTitle'), mine.map(packageCard))}
              {/* A failed package read trails the groups it left incomplete: right under Official on a
                  first-load failure, and after the kept cards when a refresh fails over stale data. */}
              {state.status === 'error'
                ? (
                  <div className={css.failure}>
                    <p className={css.statusWithDot} role="alert">
                      <StateDot state="error" />{t('error')}
                    </p>
                    <Button variant="outline" size="sm" onClick={props.refresh}>{t('retry')}</Button>
                  </div>
                )
                : null}
            </>
          )
        : null}
      {showsCards && activated !== undefined && !state.install.open
        ? renderSlot('plugins.bundle.activation', {
          packageName: activated.name,
          onDismiss: () => { setActivation(null) },
          onOpenDetails: () => { setActivation(null); setView({ kind: 'package', name: activated.name }) },
        }, { entryKey: activated.name }) : null}
      <InstallDialog
        install={state.install}
        t={t}
        onClose={props.closeInstall}
        onEditSpec={props.editInstallSpec}
        onRun={props.runInstall}
        onCancel={props.cancelInstall}
        onReconcile={props.reconcileInstall}
        onToggleDetails={props.toggleInstallDetails}
        onEnableNow={() => { setActivation(state.install.installed); props.enableInstalled() }}
        onApproveBuilds={props.approveBuildsAndRetry}
        onToggleRegistry={props.toggleRegistryOptions}
        onChooseRegistry={props.chooseRegistry}
        onChangeRegistry={props.changeRegistry}
        onUseGithubMirror={props.useGithubMirror}
      />
      {state.confirm === null
        ? null
        : (
          <ConfirmDialog
            name={packageText(
              state.packages.find(pkg => pkg.name === state.confirm?.packageName) ?? { name: state.confirm.packageName },
              resolveText,
            ).title}
            t={t}
            onConfirm={props.confirm}
            onCancel={props.cancelConfirm}
          />
        )}
    </section>
  )
}
