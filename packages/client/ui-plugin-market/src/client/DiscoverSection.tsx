/** Discover: search one plugin market index, read an entry's page, and install a version. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconSlidersTwoOutlineRegular, IconTrashOutlineRegular, IconWarningOutlineRegular, Input, Menu, Modal, Pill,
  PluginArtworkDefault, StateDot, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketCompatibility, MarketListingEntry, MarketListingVersion, MarketSearchResult, MarketSort } from '@deepseek-ai/dsh-api-remotes/client'
import type { DiscoverFace, DiscoverState, ListingFailure, ListingState, SourceFailure } from './market-store.ts'
import {
  displayDeclarations, indexLabel, presentedVersion, sourceFacts, withText, type DiscoverQuery, type DisplayDeclaration, type SourceFact,
} from './presentation.ts'
import { PluginDetailSection } from './PluginDetailSection.tsx'
import css from './DiscoverSection.module.css'

/** Props of the Discover tab. */
export type DiscoverSectionProps = PropsRuntime<'plugins.tab'> & PropsLocale<'pluginMarket'> & InjectFace<DiscoverFace>

type Translate = DiscoverSectionProps['t']

/** The injected actions, without the reactive sources the renderer binds as hooks. */
type DiscoverActions = Omit<DiscoverFace, 'hooks'>

/** Typing pause before the query text is sent. */
const TEXT_DELAY_MS = 250
/** Artwork size inside the 48px icon frame, as on the Installed tab. */
const ICON = 36

const FAILURE_KEYS = {
  fetch: 'readFailed',
  invalid: 'readInvalid',
  changed: 'readChanged',
} as const satisfies Record<ListingFailure, string>

const FACT_KEYS = {
  package: 'factPackage',
  registry: 'factRegistry',
  repository: 'factRepository',
  commit: 'factCommit',
  directory: 'factDirectory',
} as const satisfies Record<SourceFact['kind'], string>

function MarketIcon({ src, size }: { readonly src: string | undefined; readonly size: number }): ReactNode {
  const [failed, setFailed] = useState<string>()
  return src === undefined || src === failed
    ? <PluginArtworkDefault size={size} />
    : (
      <img className={css.image} src={src} width={size} height={size} alt="" loading="lazy" referrerPolicy="no-referrer"
        onError={() => { setFailed(src) }} />
    )
}

function sourceFailureText(failure: SourceFailure, t: Translate): string {
  switch (failure.kind) {
    case 'invalid': return t('sourceInvalid')
    case 'duplicate': return t('sourceDuplicate')
    case 'unavailable': return t('sourceUnavailable')
    case 'other': return t('sourceFailed')
  }
}

function entryTitle(entry: MarketListingEntry, face: DiscoverActions): string {
  return entry.title === undefined ? entry.name : face.resolveText(entry.title)
}

/** A version chosen for installation, with the entry it belongs to. */
interface InstallChoice {
  readonly entry: MarketListingEntry
  readonly version: MarketListingVersion
}

/** Whether installation accepts a version: compatible, or covered by an exemption. */
function installable(compatibility: MarketCompatibility): boolean {
  return compatibility.compatible || compatibility.exempted
}

function formatDate(timestamp: number, language: string, style: 'medium' | 'long'): string {
  return new Intl.DateTimeFormat(language, { dateStyle: style }).format(new Date(timestamp * 1000))
}

/** The one action an entry offers in its current state; Install chooses its default version. */
function EntryAction({ entry, title, t, onInstall, onOpenInstalled }: {
  readonly entry: MarketListingEntry
  readonly title: string
  readonly t: Translate
  readonly onInstall: (version: MarketListingVersion) => void
  readonly onOpenInstalled: () => void
}): ReactNode {
  const { status } = entry.installation
  if (status !== 'not-installed') {
    return (
      <Button variant="ghost" size="sm" aria-label={t('openInstalled', { name: title })} onClick={onOpenInstalled}>
        {t(status === 'update-available' ? 'statusUpdate' : status === 'provided' ? 'statusProvided' : 'statusInstalled')}
      </Button>
    )
  }
  const version = presentedVersion(entry)
  if (!version.compatibility.compatible && !version.compatibility.exempted) {
    return (
      <Tooltip label={t('noCompatibleVersion', { runtime: version.compatibility.runtimeVersion })} side="bottom" portal delayMs={300}>
        <Button variant="outline" size="sm" className={css.blocked} aria-disabled="true" aria-label={t('installTitle', { name: title })}>
          {t('install')}
        </Button>
      </Tooltip>
    )
  }
  return <Button variant="outline" size="sm" aria-label={t('installTitle', { name: title })} onClick={() => { onInstall(version) }}>{t('install')}</Button>
}

function EntryCard({ entry, t, face, language, labels, onOpen, onInstall, onOpenInstalled }: {
  readonly entry: MarketListingEntry
  readonly t: Translate
  readonly face: DiscoverActions
  readonly language: string
  readonly labels: readonly DisplayDeclaration<unknown>[]
  readonly onOpen: () => void
  readonly onInstall: (version: MarketListingVersion) => void
  readonly onOpenInstalled: () => void
}): ReactNode {
  const title = entryTitle(entry, face)
  const version = presentedVersion(entry)
  const date = formatDate(version.publishTimestamp, language, 'medium')
  return (
    <li className={css.card} data-market-entry={entry.name}>
      <span className={css.icon} aria-hidden="true"><MarketIcon src={entry.icon} size={ICON} /></span>
      <div className={css.main}>
        <div className={css.titleRow}>
          <button type="button" className={css.cardOpen} aria-label={t('openEntry', { name: title })} onClick={onOpen}>{title}</button>
          {labels.filter(label => entry.metadata.labels.includes(label.id)).map(label => <Tag key={label.id}>{label.title}</Tag>)}
        </div>
        {entry.description === undefined ? null : <span className={css.description}>{face.resolveText(entry.description)}</span>}
        <span className={css.meta}>
          {entry.author === undefined
            ? t('entryMeta', { version: version.version, date })
            : t('entryMetaAuthor', { version: version.version, author: entry.author, date })}
        </span>
      </div>
      <div className={css.cardEnd}>
        <EntryAction entry={entry} title={title} t={t} onInstall={onInstall} onOpenInstalled={onOpenInstalled} />
      </div>
    </li>
  )
}

/** One row of the version list: its state tags and an Install button when installation accepts it. */
function VersionRow({ entry, version, title, t, language, onInstall }: {
  readonly entry: MarketListingEntry
  readonly version: MarketListingVersion
  readonly title: string
  readonly t: Translate
  readonly language: string
  readonly onInstall: (version: MarketListingVersion) => void
}): ReactNode {
  const current = entry.installation.installedVersion === version.version
  // DSH ships a provided bundle; the market cannot replace it.
  const offered = !current && entry.installation.status !== 'provided' && installable(version.compatibility)
  const { compatibility } = version
  return (
    <li className={css.versionRow} data-market-version={version.version}>
      <div className={css.main}>
        <div className={css.titleRow}>
          <span className={css.strong}>{version.version}</span>
          {version.version === entry.defaultVersion ? <Tag tone="info">{t('versionDefault')}</Tag> : null}
          {version.version.split('+')[0]?.includes('-') === true ? <Tag tone="neutral">{t('versionPrerelease')}</Tag> : null}
          {current ? <Tag tone="success">{t('versionInstalled')}</Tag> : null}
          {compatibility.compatible ? null : <Tag tone="warning">{t(compatibility.exempted ? 'versionExempted' : 'versionIncompatible')}</Tag>}
        </div>
        <span className={css.meta}>
          {compatibility.compatible
            ? formatDate(version.publishTimestamp, language, 'medium')
            : compatibility.exempted
              ? t('exempted')
              : t('incompatible', { runtime: compatibility.runtimeVersion, range: Object.values(compatibility.requirements).join(' ') })}
        </span>
      </div>
      {!offered ? null : (
        <Button variant="ghost" size="sm" aria-label={t('installVersionTitle', { name: title, version: version.version })}
          onClick={() => { onInstall(version) }}>
          {t('install')}
        </Button>
      )}
    </li>
  )
}

function EntryDetail({ entry, listing, t, face, hooks, language, onBack, onInstall, onOpenInstalled }: {
  readonly entry: MarketListingEntry
  readonly listing: MarketSearchResult
  readonly t: Translate
  readonly face: DiscoverActions
  /** The detail section's bound hooks. */
  readonly hooks: Pick<DiscoverSectionProps, 'useDetails' | 'useLocale'>
  readonly language: string
  readonly onBack: () => void
  readonly onInstall: (version: MarketListingVersion) => void
  readonly onOpenInstalled: () => void
}): ReactNode {
  const title = entryTitle(entry, face)
  const version = presentedVersion(entry)
  const date = formatDate(version.publishTimestamp, language, 'long')
  const categoryId = entry.metadata.category
  const category = categoryId === undefined ? undefined : listing.metadata.categories[categoryId]
  const labels = displayDeclarations(listing.metadata.labels, face.resolveText, language)
    .filter(label => entry.metadata.labels.includes(label.id))
  const { compatibility } = version
  return (
    <div className={css.detail} data-market-detail={entry.name}>
      <button type="button" className={css.crumb} onClick={onBack}>
        <IconChevronDownOutlineRegular className={css.crumbIcon} aria-hidden="true" />
        <span>{t('backToList')}</span>
      </button>
      <div className={css.detailHead}>
        <span className={css.icon} aria-hidden="true"><MarketIcon src={entry.icon} size={ICON} /></span>
        <div className={css.main}>
          <div className={css.titleRow}>
            <h3 className={css.detailTitle}>{title}</h3>
            <Tag tone="neutral">{version.version}</Tag>
          </div>
          {title === entry.name ? null : <span className={css.meta}>{entry.name}</span>}
        </div>
        <EntryAction entry={entry} title={title} t={t} onInstall={onInstall} onOpenInstalled={onOpenInstalled} />
      </div>
      {entry.description === undefined ? null : <p className={css.detailDescription}>{face.resolveText(entry.description)}</p>}
      {compatibility.compatible ? null : (
        <p className={css.notice} role="note">
          <IconWarningOutlineRegular size={14} aria-hidden="true" />
          <span>
            {compatibility.exempted
              ? t('exempted')
              : t('incompatible', { runtime: compatibility.runtimeVersion, range: Object.values(compatibility.requirements).join(' ') })}
          </span>
        </p>
      )}
      <div className={css.detailDocument}>
        <PluginDetailSection request={{ url: listing.url, name: entry.name, version: version.version, npm: version.source.type === 'npm' }} t={t}
          loadDetail={face.loadDetail} retryDetail={face.retryDetail} detailImage={face.detailImage}
          useDetails={hooks.useDetails} useLocale={hooks.useLocale} />
      </div>
      <section className={css.detailSection}>
        <h4 className={css.sectionTitle}>{t('versionsTitle')}</h4>
        <ul className={css.versions} aria-label={t('versionsLabel', { name: title })}>
          {entry.versions.map(item => (
            <VersionRow key={item.version} entry={entry} version={item} title={title} t={t} language={language} onInstall={onInstall} />
          ))}
        </ul>
      </section>
      <section className={css.detailSection}>
        <h4 className={css.sectionTitle}>{t('factSource')}</h4>
        <dl className={css.facts}>
          {entry.author === undefined ? null : <div><dt>{t('factAuthor')}</dt><dd>{entry.author}</dd></div>}
          {entry.homepage === undefined ? null : (
            <div>
              <dt>{t('factHomepage')}</dt>
              <dd><a className={css.link} href={entry.homepage} target="_blank" rel="noopener noreferrer">{entry.homepage}</a></dd>
            </div>
          )}
          {entry.repository === undefined ? null : (
            <div>
              <dt>{t('factSourceCode')}</dt>
              <dd>
                <a className={css.link} href={entry.repository.url} target="_blank" rel="noopener noreferrer">{entry.repository.url}</a>
                {entry.repository.directory === undefined ? null : <> <code>{entry.repository.directory}</code></>}
              </dd>
            </div>
          )}
          {sourceFacts(entry.name, version).map(fact => (
            <div key={fact.kind}><dt>{t(FACT_KEYS[fact.kind])}</dt><dd><code>{fact.value}</code></dd></div>
          ))}
          <div><dt>{t('factPublished')}</dt><dd>{date}</dd></div>
          {category === undefined ? null : <div><dt>{t('factCategory')}</dt><dd>{face.resolveText(category.title)}</dd></div>}
          {labels.length === 0 ? null : (
            <div><dt>{t('factLabels')}</dt><dd className={css.tags}>{labels.map(label => <Tag key={label.id}>{label.title}</Tag>)}</dd></div>
          )}
          <div><dt>{t('factMarket')}</dt><dd>{face.resolveText(listing.title)}</dd></div>
        </dl>
      </section>
    </div>
  )
}

function SourcesDialog({ state, t, face }: {
  readonly state: DiscoverState
  readonly t: Translate
  readonly face: DiscoverActions
}): ReactNode {
  return (
    <Modal open={state.editing} onClose={face.toggleSources} title={t('sourcesTitle')} closeLabel={t('close')}
      description={t('sourcesDescription')} className={css.dialog as string}>
      <div className={css.dialogBody}>
        {state.indexes.length === 0 ? null : (
          <ul className={css.sourceList} aria-label={t('sourcesLabel')}>
            {state.indexes.map(index => (
              <li key={index.url} className={css.sourceRow}>
                <div className={css.main}>
                  <span className={css.strong}>{indexLabel(index, face.resolveText)}</span>
                  <span className={css.meta}>{index.url}</span>
                  {index.error === undefined ? null : <span className={css.sourceError}>{index.error}</span>}
                </div>
                <Tooltip label={t('removeSource')} side="bottom" portal delayMs={300}>
                  <Button variant="ghost" size="sm" icon={<IconTrashOutlineRegular size={13} />}
                    aria-label={t('removeSourceNamed', { url: index.url })} disabled={state.saving}
                    onClick={() => { face.removeSource(index.url) }} />
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
        <form className={css.sourceForm} onSubmit={(event) => { event.preventDefault(); face.addSource() }}>
          <Input className={css.grow as string} value={state.draft} placeholder={t('sourcePlaceholder')} aria-label={t('sourceUrl')}
            aria-invalid={state.sourceFailure !== null} data-modal-autofocus onChange={(event) => { face.editDraft(event.target.value) }} />
          <Button type="submit" variant="primary" size="sm" icon={<IconPlusOutlineRegular size={13} />}
            disabled={state.saving || state.draft.trim() === ''}>
            {t('addSource')}
          </Button>
        </form>
        {state.sourceFailure === null ? null : <p className={css.error} role="alert">{sourceFailureText(state.sourceFailure, t)}</p>}
        <p className={css.notice} role="note">
          <IconWarningOutlineRegular size={14} aria-hidden="true" />
          <span>{t('sourcesTrust')}</span>
        </p>
      </div>
    </Modal>
  )
}

function ConfirmDialog({ choice, t, face, onCancel, onConfirm }: {
  readonly choice: InstallChoice | null
  readonly t: Translate
  readonly face: DiscoverActions
  readonly onCancel: () => void
  readonly onConfirm: (choice: InstallChoice) => void
}): ReactNode {
  if (choice === null) return null
  const { entry, version } = choice
  const title = entryTitle(entry, face)
  return (
    <Modal open onClose={onCancel} title={t('confirmTitle', { name: title })} closeLabel={t('close')} className={css.dialog as string}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" autoFocus onClick={() => { onConfirm(choice) }}>{t('install')}</Button>
        </>
      )}>
      <div className={css.dialogBody}>
        <div className={css.confirmHead}>
          <span className={css.icon} aria-hidden="true"><MarketIcon src={entry.icon} size={ICON} /></span>
          <div className={css.main}>
            <span className={css.strong}>{title}</span>
            <span className={css.meta}>{version.version}</span>
          </div>
        </div>
        <dl className={css.facts}>
          {entry.author === undefined ? null : <div><dt>{t('factAuthor')}</dt><dd>{entry.author}</dd></div>}
          {sourceFacts(entry.name, version).map(fact => (
            <div key={fact.kind}><dt>{t(FACT_KEYS[fact.kind])}</dt><dd><code>{fact.value}</code></dd></div>
          ))}
        </dl>
        {version.compatibility.compatible ? null : (
          <p className={css.notice} role="note"><IconWarningOutlineRegular size={14} aria-hidden="true" /><span>{t('exempted')}</span></p>
        )}
        <p className={css.notice} role="note"><IconWarningOutlineRegular size={14} aria-hidden="true" /><span>{t('installTrust')}</span></p>
      </div>
    </Modal>
  )
}

function ListSkeleton({ label }: { readonly label: string }): ReactNode {
  return (
    <ul className={css.cards} role="status" aria-label={label} aria-busy="true">
      {[0, 1, 2, 3].map(index => (
        <li key={index} className={css.card} aria-hidden="true">
          <span className={`${css.icon} ${css.skeletonFill}`} />
          <div className={css.main}>
            <span className={`${css.skeletonBar} ${css.skeletonTitle} ${css.skeletonFill}`} />
            <span className={`${css.skeletonBar} ${css.skeletonDescription} ${css.skeletonFill}`} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The toolbar menu that is open; at most one is. */
type OpenMenu = 'market' | 'sort' | 'filter' | null

/** The sort menu id of a sort. */
function sortMenuId(sort: MarketSort): string {
  return sort.kind === 'key' ? `key:${sort.id}` : sort.kind
}

/** Whether a query selects every plugin of the index. */
function unfiltered(query: DiscoverQuery): boolean {
  return query.text.trim() === '' && query.category === null && query.labels.length === 0
}

function Browser({ state, listing, t, face, hooks, language, onInstall, openPackage }: {
  readonly state: DiscoverState
  readonly listing: ListingState
  readonly t: Translate
  readonly face: DiscoverActions
  readonly hooks: Pick<DiscoverSectionProps, 'useDetails' | 'useLocale'>
  readonly language: string
  readonly onInstall: (choice: InstallChoice) => void
  readonly openPackage: (name: string) => void
}): ReactNode {
  const { query, value } = listing
  const [text, setText] = useState(query.text)
  const [menu, setMenu] = useState<OpenMenu>(null)
  const [opened, setOpened] = useState<MarketListingEntry | null>(null)
  useEffect(() => {
    if (text === query.text) return undefined
    const timer = setTimeout(() => { face.search(withText(query, text)) }, TEXT_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [text, query, face])
  const declarations = useMemo(() => ({
    categories: value === null ? [] : displayDeclarations(value.metadata.categories, face.resolveText, language),
    labels: value === null ? [] : displayDeclarations(value.metadata.labels, face.resolveText, language),
    sortKeys: value === null ? [] : displayDeclarations(value.metadata.sortKeys, face.resolveText, language),
  }), [value, face, language])
  // A reload keeps the opened plugin current while its page is loaded.
  const openEntry = opened === null ? undefined : value?.entries.find(entry => entry.name === opened.name) ?? opened
  if (openEntry !== undefined && value !== null) {
    return (
      <EntryDetail entry={openEntry} listing={value} t={t} face={face} hooks={hooks} language={language} onBack={() => { setOpened(null) }}
        onInstall={(version) => { onInstall({ entry: openEntry, version }) }} onOpenInstalled={() => { openPackage(openEntry.name) }} />
    )
  }
  const selected = state.indexes.find(index => index.url === listing.url) ?? { url: listing.url }
  const market = indexLabel(selected, face.resolveText)
  const { sort } = query
  const sortOptions = [
    ...query.text.trim() === '' ? [] : [{ id: 'relevance', label: t('sortRelevance') }],
    { id: 'index', label: t('sortDefault') },
    { id: 'published', label: t('sortPublished') },
    ...declarations.sortKeys.map(item => ({ id: `key:${item.id}`, label: item.title })),
  ]
  // The Controller drops a sort key the index no longer declares, and relevance follows the text.
  const sortName = (sortOptions.find(option => option.id === sortMenuId(sort)) as { label: string }).label
  const directed = sort.kind === 'published' || sort.kind === 'key'
  const chooseSort = (id: string): void => {
    setMenu(null)
    if (id === 'direction' && directed) {
      face.search({ ...query, sort: { ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' } })
      return
    }
    if (id === 'index' || id === 'relevance') {
      face.search({ ...query, sort: { kind: id } })
      return
    }
    if (id === 'published') {
      face.search({ ...query, sort: { kind: 'published', direction: 'desc' } })
      return
    }
    const key = declarations.sortKeys.find(item => `key:${item.id}` === id)
    /* v8 ignore next -- every other menu id names a declared sort key */
    if (key !== undefined) face.search({ ...query, sort: { kind: 'key', id: key.id, direction: key.declaration.order } })
  }
  const toggleMenu = (name: Exclude<OpenMenu, null>): void => { setMenu(menu === name ? null : name) }
  const busy = listing.status === 'loading' && value !== null
  return (
    <>
      <div className={css.toolbar}>
        <Menu open={menu === 'market'} onClose={() => { setMenu(null) }} portal autoFocus selectedId={listing.url}
          items={state.indexes.map(index => ({ id: index.url, label: indexLabel(index, face.resolveText) }))}
          footer={[{ id: 'manage', label: t('manageSources'), icon: <IconSlidersTwoOutlineRegular size={14} /> }]}
          onSelect={(id) => {
            setMenu(null)
            if (id === 'manage') face.toggleSources()
            else face.select(id)
          }}
          anchor={(
            <Button variant="ghost" size="sm" className={css.marketButton} aria-haspopup="menu" aria-expanded={menu === 'market'}
              aria-label={t('marketMenu', { market })} onClick={() => { toggleMenu('market') }}>
              <span className={css.marketName}>{market}</span>
              <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
            </Button>
          )} />
        <Input className={css.search as string} type="search" icon={<IconSearchOutlineRegular size={14} />} value={text}
          placeholder={t('search')} aria-label={t('search')} onChange={(event) => { setText(event.target.value) }} />
        {declarations.labels.length === 0 ? null : (
          <Menu open={menu === 'filter'} onClose={() => { setMenu(null) }} portal autoFocus align="end" selectedIds={query.labels}
            items={declarations.labels.map(item => ({ id: item.id, label: item.title }))}
            onSelect={(id) => {
              const labels = query.labels.includes(id) ? query.labels.filter(label => label !== id) : [...query.labels, id]
              face.search({ ...query, labels })
            }}
            anchor={(
              <Button variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={menu === 'filter'}
                icon={<IconSlidersTwoOutlineRegular size={13} />} onClick={() => { toggleMenu('filter') }}>
                {query.labels.length === 0 ? t('filter') : t('filterCount', { count: String(query.labels.length) })}
              </Button>
            )} />
        )}
        <Menu open={menu === 'sort'} onClose={() => { setMenu(null) }} portal autoFocus align="end" selectedId={sortMenuId(sort)}
          items={sortOptions}
          {...directed
            ? { footer: [{ id: 'direction', label: t(sort.direction === 'asc' ? 'switchToDescending' : 'switchToAscending') }] }
            : {}}
          onSelect={chooseSort}
          anchor={(
            <Button variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={menu === 'sort'} onClick={() => { toggleMenu('sort') }}>
              {t('sortBy', { sort: sortName })}
              <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
            </Button>
          )} />
        <Tooltip label={t('refresh')} side="bottom" portal delayMs={500} focusDelayMs={500}>
          <Button variant="ghost" size="sm" aria-label={t('refresh')} disabled={listing.status === 'loading'} onClick={face.refresh}
            icon={busy ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular size={14} />} />
        </Tooltip>
      </div>
      {declarations.categories.length === 0 ? null : (
        <div className={css.categories} role="group" aria-label={t('categoriesLabel')}>
          <Pill active={query.category === null} aria-pressed={query.category === null}
            onClick={() => { face.search({ ...query, category: null }) }}>
            {t('allCategories')}
          </Pill>
          {declarations.categories.map(item => (
            <Pill key={item.id} active={query.category === item.id} aria-pressed={query.category === item.id}
              onClick={() => { face.search({ ...query, category: item.id }) }}>
              {item.title}
            </Pill>
          ))}
        </div>
      )}
      {listing.failure === null ? null : (
        <div className={css.failure}>
          <p className={css.error} role="alert">
            <StateDot state="error" />{t(FAILURE_KEYS[listing.failure])}
          </p>
          <Button variant="outline" size="sm" onClick={face.retry}>{t('retry')}</Button>
        </div>
      )}
      {value === null
        ? listing.status === 'loading' ? <ListSkeleton label={t('loading')} /> : null
        : value.total === 0
          // Results are published together with the query they answer.
          ? <p className={css.muted}>{t(unfiltered(listing.answered as DiscoverQuery) ? 'emptyIndex' : 'noMatches')}</p>
          : (
            <>
              <ul className={css.cards} aria-busy={busy}>
                {value.entries.map(entry => (
                  <EntryCard key={entry.name} entry={entry} t={t} face={face} language={language} labels={declarations.labels}
                    onOpen={() => { setOpened(entry) }} onInstall={(version) => { onInstall({ entry, version }) }}
                    onOpenInstalled={() => { openPackage(entry.name) }} />
                ))}
              </ul>
              {value.nextOffset === null
                ? null
                : (
                  <Button variant="outline" size="sm" className={css.more} disabled={listing.status !== 'ready'} onClick={face.more}>
                    {t('showMore')}
                  </Button>
                )}
            </>
          )}
    </>
  )
}

/** Render the Discover tab of the Plugins page. */
export function DiscoverSection(props: DiscoverSectionProps): ReactNode {
  const { t, install, openPackage } = props
  const face: DiscoverActions = props
  const state = props.useDiscover(snapshot => snapshot)
  const language = props.useLocale(snapshot => snapshot.active)
  const [confirming, setConfirming] = useState<InstallChoice | null>(null)
  useEffect(() => { props.ensure() }, [props.ensure])
  let body: ReactNode
  if (state.status === 'idle' || state.status === 'loading') {
    body = <ListSkeleton label={t('loading')} />
  } else if (state.status === 'error') {
    body = (
      <div className={css.failure}>
        <p className={css.error} role="alert"><StateDot state="error" />{t('sourcesFailed')}</p>
        <Button variant="outline" size="sm" onClick={props.reload}>{t('retry')}</Button>
      </div>
    )
  } else if (state.listing === null) {
    body = (
      <div className={css.empty}>
        <PluginArtworkDefault size={48} />
        <p className={css.emptyTitle}>{t('emptyTitle')}</p>
        <p className={css.muted}>{t('emptyDescription')}</p>
        <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={props.toggleSources}>
          {t('addFirstSource')}
        </Button>
      </div>
    )
  } else {
    body = (
      <Browser key={state.listing.url} state={state} listing={state.listing} t={t} face={face}
        hooks={{ useDetails: props.useDetails, useLocale: props.useLocale }} language={language}
        onInstall={(choice) => { setConfirming(choice) }} openPackage={openPackage} />
    )
  }
  return (
    <div className={css.section} data-plugin-tab="discover">
      {body}
      <SourcesDialog state={state} t={t} face={face} />
      <ConfirmDialog choice={confirming} t={t} face={face} onCancel={() => { setConfirming(null) }}
        onConfirm={({ entry, version }) => {
          setConfirming(null)
          install({ ...version.install, title: entryTitle(entry, face), version: version.version })
        }} />
    </div>
  )
}
