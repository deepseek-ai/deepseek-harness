import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { ClientEntryState } from '@deepseek-ai/dsh-client-modules/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import {
  IconChevronDownOutlineRegular,
  IconSearchOutlineRegular,
  Menu,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type AgentPresetGroup = NonNullable<PluginInventorySnapshot['agentPresets']>[number]
type AgentPresetRow = AgentPresetGroup['rows'][number]

/** Registration-side Remote face used by the section. */
export interface PluginInventorySettingsTabInjected {
  /** Resolve local package text in the current Client locale at render time. */
  resolveText: (text: LocalizedText) => string
  /** Page-local module synchronization, independent from the Host inventory. */
  hooks: { clientSync: ObservableSnapshot<ClientEntryState> }
  /** Retry the latest client graph without changing the Host composition. */
  retryClient: () => void
  /** Read a current Host inventory snapshot. */
  list: () => Promise<PluginInventorySnapshot>
  /**
   * Display name for one preset: shipped presets resolve through the
   * agent-preset dictionaries, user-authored ones keep their own metadata.
   */
  presetName: (preset: AgentPresetGroup) => string
}
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type Translate = PluginInventorySettingsTabProps['t']

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(phase: PluginFiberPhase, t: Translate): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact technical names for Settings without changing their module identity. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Display an entry identity without the composition-only `include:` marker. */
function entrySubtitle(entryId: string): string {
  return entryId.replace(/^include:/, '')
}

/** Preserve translated titles and shorten literal package or module name fallbacks in Settings. */
function pluginText(row: PluginInventoryEntry | AgentPresetRow, resolveText: PluginInventorySettingsTabInjected['resolveText']) {
  const title = row.meta?.title
  return {
    title: typeof title === 'object' ? resolveText(title) : moduleShortName(title ?? row.moduleName),
    description: row.meta?.description === undefined ? undefined : resolveText(row.meta.description) || undefined,
  }
}

/** Match translated text alongside the row's technical module and entry identities. */
function matches(row: PluginInventoryEntry | AgentPresetRow, normalizedQuery: string, resolveText: PluginInventorySettingsTabInjected['resolveText']): boolean {
  if (normalizedQuery.length === 0) return true
  const { title, description } = pluginText(row, resolveText)
  return [row.moduleName, row.entryId, title, description]
    .some(value => value?.toLocaleLowerCase().includes(normalizedQuery))
}

/** The roster row shown when the preset switcher has no explicit choice. */
function fallbackPreset(presets: readonly AgentPresetGroup[]): AgentPresetGroup | undefined {
  return presets.find(preset => preset.isDefault) ?? presets[0]
}

/** The switcher's display label for one preset. */
function presetLabel(preset: AgentPresetGroup, t: Translate, presetName: (preset: AgentPresetGroup) => string): string {
  const name = presetName(preset)
  if (preset.broken !== undefined) return t('presetOptionBroken', { name })
  if (preset.isDefault) return t('presetOptionDefault', { name })
  return name
}

/** One expandable plugin card; the caller owns the trailing status content. */
function PluginCard({
  rowKey, moduleName, title, description, metadataError, entryId, trailing, ariaLabel, failed, expanded, onToggle, children,
}: {
  readonly rowKey: string
  readonly moduleName: string
  readonly title: string
  readonly description: string | undefined
  readonly metadataError: string | undefined
  readonly entryId: string | null
  readonly trailing: ReactNode
  readonly ariaLabel: string
  readonly failed: boolean
  readonly expanded: string | null
  readonly onToggle: (key: string) => void
  readonly children: ReactNode
}): ReactNode {
  const open = expanded === rowKey
  const detailId = `plugin-details-${encodeURIComponent(rowKey)}`
  const descriptionId = useId()
  return (
    <li
      className={css.card}
      data-plugin-entry={entryId ?? undefined}
      data-plugin-module={moduleName}
      data-failed={failed ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
    >
      <button
        className={css.cardContent}
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={ariaLabel}
        aria-describedby={description === undefined ? undefined : descriptionId}
        onClick={() => { onToggle(rowKey) }}
      >
        <span className={css.cardMainRow}>
          <strong className={css.cardTitle} title={moduleName}>{title}</strong>
          <span className={css.cardTrailing}>
            {trailing}
            <IconChevronDownOutlineRegular className={css.chevron} size={12} aria-hidden="true" />
          </span>
        </span>
        {description === undefined ? null : <span className={css.hint} id={descriptionId}>{description}</span>}
        {entryId === null ? null : <code className={css.cardIdentity} title={entryId}>{entrySubtitle(entryId)}</code>}
      </button>
      {metadataError === undefined ? null : <p className={css.brokenNote} role="status" data-package-meta-error>{metadataError}</p>}
      {open ? <div className={css.cardDetails} id={detailId}>{children}</div> : null}
    </li>
  )
}

/** Detail rows shared by every card: the Loader identity, then labeled facts. */
function CardFacts({ moduleName, moduleLabel, entryId, facts }: {
  readonly moduleName: string
  readonly moduleLabel: string
  readonly entryId: string | null
  readonly facts: readonly (readonly [label: string, value: ReactNode])[]
}): ReactNode {
  return (
    <>
      {entryId === null ? null : <code className={css.entryValue} data-loader-entry>{entryId}</code>}
      <dl className={css.details}>
        <div>
          <dt>{moduleLabel}</dt>
          <dd>{moduleName}</dd>
        </div>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/* `pending` is the only dotted phase with no work under way. `loading` and
 * `unloading` are both live transitions the Host is running — an async
 * disposer can hold `unloading` for a while — so both animate. `active` and
 * `failed` carry no dot: a settled enabled row shows its enablement tag alone,
 * and a failed row has the failure tag. */
const PHASE_DOT_STATES = {
  pending: 'idle',
  loading: 'ongoing',
  unloading: 'ongoing',
} as const satisfies Partial<Record<NonNullable<PluginFiberPhase>, StateDotState>>

/** A live root-fiber phase whose dot still adds to the row's enablement tag. */
type DotPhase = keyof typeof PHASE_DOT_STATES

/** Whether a live root-fiber phase carries a dot of its own. */
function showsPhaseDot(phase: PluginFiberPhase): phase is DotPhase {
  return phase === 'pending' || phase === 'loading' || phase === 'unloading'
}

/** Status dot naming a live root-fiber phase; rows without a dotted phase show none. */
function PhaseDot({ phase, t }: { readonly phase: DotPhase; readonly t: Translate }): ReactNode {
  const status = phaseLabel(phase, t)
  /* StateDot is aria-hidden, so the phase name lives on this wrapper. */
  return (
    <span className={css.phaseDot} role="img" aria-label={status} title={status}>
      <StateDot state={PHASE_DOT_STATES[phase]} />
    </span>
  )
}

/** Enablement states one inventory row can report. */
type EnablementKind = 'enabled' | 'disabled' | 'conditional' | 'preset' | 'failed'

const TAG_TONES = {
  enabled: 'success',
  disabled: 'neutral',
  conditional: 'warning',
  preset: 'info',
  failed: 'danger',
} as const satisfies Record<EnablementKind, TagTone>

/** Enablement tag; `kind` selects the palette. */
function StateTag({ kind, label }: { readonly kind: EnablementKind; readonly label: string }): ReactNode {
  return <Tag tone={TAG_TONES[kind]}>{label}</Tag>
}

/** Render the read-only plugin inventory: agent presets first, then the global plane. */
export function PluginInventorySettingsTab(
  { list, presetName, resolveText, t, useClientSync, retryClient }: PluginInventorySettingsTabProps,
): ReactNode {
  const clientSync = useClientSync(snapshot => snapshot)
  const sectionId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [chosenPreset, setChosenPreset] = useState<string | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState<boolean | null>(null)
  const [globalOpen, setGlobalOpen] = useState<boolean | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searching = normalizedQuery.length > 0
  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const presets = snapshot?.agentPresets ?? []
  const selected = presets.find(preset => preset.id === chosenPreset) ?? fallbackPreset(presets)

  /** Presets that actually enable a module, keyed by module name. */
  const enabledIn = useMemo(() => {
    const found = new Map<string, [AgentPresetGroup, ...AgentPresetGroup[]]>()
    for (const preset of presets) {
      for (const row of preset.rows) {
        if (row.enabled !== true) continue
        const groups = found.get(row.moduleName)
        if (groups === undefined) found.set(row.moduleName, [preset])
        else if (!groups.includes(preset)) groups.push(preset)
      }
    }
    return found
  }, [presets])

  const entries = snapshot?.entries ?? []
  const failedEntries: PluginInventoryEntry[] = []
  const regularEntries: PluginInventoryEntry[] = []
  for (const entry of entries) {
    if (entry.fiberPhase === 'failed') failedEntries.push(entry)
    else regularEntries.push(entry)
  }

  const entryMatch = (entry: PluginInventoryEntry): boolean => matches(entry, normalizedQuery, resolveText)
  const rowMatch = (row: AgentPresetRow): boolean => matches(row, normalizedQuery, resolveText)
  const filteredFailed = failedEntries.filter(entryMatch)
  const filteredRegular = regularEntries.filter(entryMatch)
  const globalCount = filteredFailed.length + filteredRegular.length
  const selectedRows = selected === undefined ? [] : selected.rows.filter(rowMatch)
  const otherPresetMatches = searching
    ? presets.filter(preset => preset !== selected && preset.rows.some(rowMatch))
    : []
  const otherMatchCount = otherPresetMatches
    .reduce((total, preset) => total + preset.rows.filter(rowMatch).length, 0)

  // Both groups start collapsed; a search opens them for as long as it lasts.
  const presetEffectiveOpen = searching || (presetOpen ?? false)
  const globalEffectiveOpen = searching || (globalOpen ?? false)
  const nothingMatches = searching && globalCount === 0 && selectedRows.length === 0
    && otherPresetMatches.length === 0

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }
  const toggleRow = (key: string): void => {
    setExpanded(current => current === key ? null : key)
  }

  /** Trailing status and detail facts for one row of the selected preset. */
  const presetRowCard = (preset: AgentPresetGroup, row: AgentPresetRow, index: number): ReactNode => {
    const key = `preset:${preset.id}:${String(index)}`
    const { title, description } = pluginText(row, resolveText)
    const failed = row.fiberPhase === 'failed'
    const stateText = failed
      ? t('failedTag')
      : row.enabled === true ? t('enabledTag') : row.enabled === false ? t('disabledTag') : t('conditionalTag')
    const kind = failed ? 'failed' : row.enabled === true ? 'enabled' : row.enabled === false ? 'disabled' : 'conditional'
    return (
      <PluginCard
        key={key}
        rowKey={key}
        moduleName={row.moduleName}
        title={title}
        description={description}
        metadataError={row.meta?.error === undefined ? undefined : t('metadataError', { error: row.meta.error })}
        entryId={row.entryId}
        failed={failed}
        expanded={expanded}
        onToggle={toggleRow}
        ariaLabel={`${title}${row.entryId === null ? '' : `, ${row.entryId}`}, ${stateText}`}
        trailing={(
          <>
            {row.enabled === true && showsPhaseDot(row.fiberPhase)
              ? <PhaseDot phase={row.fiberPhase} t={t} />
              : null}
            <StateTag kind={kind} label={stateText} />
          </>
        )}
      >
        <CardFacts
          moduleName={row.moduleName}
          moduleLabel={t('moduleLabel')}
          entryId={row.entryId}
          facts={[
            [t('fromPreset'), presetName(preset)],
            [t('configuration'), stateText],
            ...row.fiberPhase === null ? [] : [[t('runtime'), phaseLabel(row.fiberPhase, t)] as const],
            ...row.condition === undefined ? [] : [[t('condition'), <code key="condition">{row.condition}</code>] as const],
          ]}
        />
      </PluginCard>
    )
  }

  /** One global-plane row; a preset-provided row carries the presets that enable it. */
  const globalRowCard = (
    entry: PluginInventoryEntry,
    providers?: readonly [AgentPresetGroup, ...AgentPresetGroup[]],
  ): ReactNode => {
    const key = `global:${entry.entryId}`
    const { title, description } = pluginText(entry, resolveText)
    const failed = entry.fiberPhase === 'failed'
    const stateText = failed
      ? t('failedTag')
      : providers !== undefined ? t('presetEnabledTag') : t(entry.enabled ? 'enabledTag' : 'disabledTag')
    const kind = failed ? 'failed' : providers !== undefined ? 'preset' : entry.enabled ? 'enabled' : 'disabled'
    return (
      <PluginCard
        key={key}
        rowKey={key}
        moduleName={entry.moduleName}
        title={title}
        description={description}
        metadataError={entry.meta?.error === undefined ? undefined : t('metadataError', { error: entry.meta.error })}
        entryId={entry.entryId}
        failed={failed}
        expanded={expanded}
        onToggle={toggleRow}
        ariaLabel={`${title}, ${entry.entryId}, ${stateText}`}
        trailing={(
          <>
            {entry.enabled && showsPhaseDot(entry.fiberPhase)
              ? <PhaseDot phase={entry.fiberPhase} t={t} />
              : null}
            <StateTag kind={kind} label={stateText} />
          </>
        )}
      >
        <CardFacts
          moduleName={entry.moduleName}
          moduleLabel={t('moduleLabel')}
          entryId={entry.entryId}
          facts={providers !== undefined
            ? [
              [t('configuration'), t('presetProvidedDetail')],
              [t('enabledIn'), (
                <span className={css.enabledIn}>
                  <span>{providers.map(preset => presetName(preset)).join(' · ')}</span>
                  <button
                    type="button"
                    className={css.jumpLink}
                    onClick={() => { setChosenPreset(providers[0].id) }}
                  >
                    {t('viewInPreset')}
                  </button>
                </span>
              )],
            ]
            : [
              [t('configuration'), t(entry.enabled ? 'enabledTag' : 'disabledTag')],
              ...entry.enabled ? [[t('runtime'), phaseLabel(entry.fiberPhase, t)] as const] : [],
            ]}
        />
      </PluginCard>
    )
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {clientSync.syncing ? (
        <p className={`${css.status} ${css.statusWithDot}`} role="status">
          <StateDot state="ongoing" />{t('clientSyncing')}
        </p>
      ) : null}
      {clientSync.failures.length === 0 ? null : (
        <div className={css.failure} data-client-sync-failure>
          <p className={css.statusWithDot} role="alert">
            <StateDot state="error" />{t('clientSyncFailed')}
          </p>
          <ul>{clientSync.failures.map(failure => <li key={failure.id}>{failure.id}: {failure.message}</li>)}</ul>
          <button type="button" disabled={clientSync.syncing} onClick={retryClient}>{t('clientSyncRetry')}</button>
        </div>
      )}
      {state.status === 'loading' ? (
        <p className={`${css.status} ${css.statusWithDot}`} role="status">
          <StateDot state="ongoing" />{t('loading')}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p className={css.statusWithDot} role="alert">
            <StateDot state="error" />{t('error')}
          </p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {snapshot !== undefined ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutlineRegular aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          {entries.length === 0 && presets.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {nothingMatches ? <p className={css.status}>{t('emptySearch')}</p> : null}

          {selected !== undefined ? (
            <section className={css.group} data-plugin-scope="preset" data-preset-id={selected.id}>
              <div className={css.groupTitleRow}>
                <button
                  type="button"
                  className={css.groupToggle}
                  aria-expanded={presetEffectiveOpen}
                  aria-controls={`${sectionId}-preset`}
                  onClick={() => { setPresetOpen(!presetEffectiveOpen) }}
                >
                  <IconChevronDownOutlineRegular className={css.chevron} size={12} aria-hidden="true" />
                  <span className={css.groupTitle}>{t('presetTitle')}</span>
                </button>
                <div className={css.headerEnd}>
                  <Menu
                    open={switcherOpen}
                    onClose={() => { setSwitcherOpen(false) }}
                    items={presets.map(preset => ({ id: preset.id, label: presetLabel(preset, t, presetName) }))}
                    selectedId={selected.id}
                    onSelect={(id) => {
                      setSwitcherOpen(false)
                      setChosenPreset(id)
                    }}
                    align="end"
                    portal
                    anchor={(
                      <button
                        type="button"
                        className={css.switcher}
                        aria-haspopup="menu"
                        aria-expanded={switcherOpen}
                        aria-label={t('switcherLabel')}
                        onClick={() => { setSwitcherOpen(value => !value) }}
                      >
                        <span className={css.switcherLabel}>{presetLabel(selected, t, presetName)}</span>
                        <IconChevronDownOutlineRegular className={css.chevron} aria-hidden="true" />
                      </button>
                    )}
                  />
                </div>
              </div>
              <p className={css.groupSub}>
                {t('presetSubtitle')}
                <span data-preset-plugin-count={selectedRows.length}>
                  {` · ${String(selectedRows.length)} ${t('countUnit')}`}
                </span>
              </p>
              {presetEffectiveOpen ? (
                <div id={`${sectionId}-preset`} className={css.groupBody}>
                  {selected.broken !== undefined ? (
                    <p className={css.brokenNote} role="alert">{selected.broken}</p>
                  ) : null}
                  {selectedRows.length > 0 ? (
                    <ul className={css.cards}>
                      {selectedRows.map((row, index) => presetRowCard(selected, row, index))}
                    </ul>
                  ) : null}
                  {otherMatchCount > 0 ? (
                    <p className={css.hint}>
                      {t('matchesInOtherPresets', { count: String(otherMatchCount) })}
                      {otherPresetMatches.map(preset => (
                        <button
                          key={preset.id}
                          type="button"
                          className={css.jumpLink}
                          onClick={() => { setChosenPreset(preset.id) }}
                        >
                          {presetName(preset)}
                        </button>
                      ))}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {entries.length > 0 ? (
            <section className={css.group} data-plugin-scope="global">
              <div className={css.groupTitleRow}>
                <button
                  type="button"
                  className={css.groupToggle}
                  aria-expanded={globalEffectiveOpen}
                  aria-controls={`${sectionId}-global`}
                  onClick={() => { setGlobalOpen(!globalEffectiveOpen) }}
                >
                  <IconChevronDownOutlineRegular className={css.chevron} size={12} aria-hidden="true" />
                  <span className={css.groupTitle}>{t('globalTitle')}</span>
                </button>
              </div>
              <p className={css.groupSub}>
                {t('globalSubtitle')}
                <span data-plugin-count={globalCount}>{` · ${String(globalCount)} ${t('countUnit')}`}</span>
                {filteredFailed.length > 0 ? (
                  <span className={css.failedCount}>{filteredFailed.length} {t('failedCountLabel')}</span>
                ) : null}
              </p>
              {globalEffectiveOpen && globalCount > 0 ? (
                <ul className={css.cards} id={`${sectionId}-global`}>
                  {filteredFailed.map(entry => globalRowCard(entry))}
                  {filteredRegular.map(entry => globalRowCard(
                    entry,
                    entry.enabled ? undefined : enabledIn.get(entry.moduleName),
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
