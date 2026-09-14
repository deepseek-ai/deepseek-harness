/**
 * One provider's editor card, hand-written per adapter family: the primary
 * field is a single write-only **API key** input (the page never asks for an
 * environment-variable name — a typed key stores through `credentials/set`
 * under the profile's reference, deriving `<ROUTE>_API_KEY` when the profile
 * has none. The pi-ai profile records that derivation as `apiKeyEnv` only when
 * a key is entered; a blank key materializes a reference-free profile for
 * provider-native authentication);
 * the collapsed 自定义设置 area carries the per-family extras (`baseURL` for
 * both families, DeepSeek's id/name/context-window model catalog, and the
 * display name and wire protocol of a pi-ai route the adapter does not ship —
 * the two fields the create card asked that route for, editable here for the
 * same reason).
 * Reasoning effort is deliberately absent: it is a per-MODEL capability, and
 * the models under one provider disagree about it, so a provider-scoped
 * control can only be set to a value some of them reject. The composer's
 * model picker offers each model its own levels; `settings.yaml` keeps the
 * profile field for a deployment that knows its route. Everything else stays
 * owned by `settings.yaml`. Profile edits land as minimal `settings.mutate`
 * path ops against the stored section — the card names only the fields it can
 * see instead of rebuilding the whole subtree from a partial descriptor.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  CredentialInfo, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  DeepSeekModelsEditor, modelDrafts, validateDeepSeekModels,
} from './DeepSeekModelsEditor.tsx'
import { apiKeyFailure } from './apiKey.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import { deriveKeyRef, protocolChoices } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Per-adapter-family curated field sets (unknown namespaces get the hint alone). */
type EditorLayout = 'deepseek' | 'pi-ai' | 'unknown'



/** Props of {@link ProviderEditor}. */
export interface ProviderEditorProps {
  /** Provider route id. */
  provider: string
  /** Display name for the card title. */
  displayName: string
  /** Hide the title row (the add card renders its own provider select). */
  hideTitle?: boolean
  /**
   * Whether the adapter reports this route as hand-declared — absent from its
   * installed catalog. Such a route carries its own wire protocol, chosen when
   * it was created and editable here for the same reason; a catalog route's
   * models each carry theirs, so a route-level protocol there could only
   * override every one of them and the card does not offer it.
   */
  declared?: boolean
  /** The owning namespace view (schema, layers, secrets). */
  namespace: SettingsNamespaceView
  /** Settings-owned synchronous schema and immutable path operations. */
  schema: SettingsSchemaOperations
  /** Path from the section root to this provider's profile. */
  settingsPath: readonly string[]
  /** The Host operations this card writes and interrogates through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Render only the credential field and actions, without provider settings. */
  credentialOnly?: boolean
  /** Require a newly entered credential before this editor can submit. */
  credentialRequired?: boolean
  /** Give the credential field initial focus when this editor mounts. */
  autoFocusCredential?: boolean
  /** Override the dismiss action copy. */
  cancelLabelKey?: keyof typeof en
  /** Override the idle commit action copy. */
  submitLabelKey?: keyof typeof en
  /** Override the in-flight commit action copy. */
  submitBusyLabelKey?: keyof typeof en
  /** Close the editor; `changed` reports whether an Apply committed. */
  onClose: (changed: boolean) => void
}

/** A user-section subtree as a plain draft object (absent → empty). */
function draftAt(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  path: readonly string[],
): Record<string, unknown> {
  const subtree = schema.getPath(namespace.user, path)
  if (typeof subtree !== 'object' || subtree === null || Array.isArray(subtree)) return {}
  return structuredClone(subtree) as Record<string, unknown>
}

/**
 * The minimal path ops carrying `after` over `before`, both as the card sees
 * them. Only keys the card observed are named; fields absent from both sides
 * produce no op, which is why edits are path-addressed rather than a rebuilt
 * section.
 * @param base - path of the edited subtree inside the user section.
 * @param before - the subtree as loaded, or undefined when it is new.
 * @param after - the subtree as edited.
 * @returns ordered set/unset ops; empty when nothing changed.
 */
export function pathOps(
  base: readonly string[],
  before: unknown,
  after: Record<string, unknown>,
): SettingsPathOpView[] {
  const previous = typeof before === 'object' && before !== null && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {}
  const ops: SettingsPathOpView[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue
    ops.push({ op: 'set', path: [...base, key], value: value as JsonValue })
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  }
  return ops
}

/** The editor layout the owning namespace selects. */
function layoutOf(ns: string): EditorLayout {
  if (ns === 'llm-deepseek') return 'deepseek'
  if (ns === 'llm-pi-ai') return 'pi-ai'
  return 'unknown'
}

/** The credential reference this profile resolves keys through. */
function refFor(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  path: readonly string[],
  provider: string,
): string {
  const profile = schema.getPath(namespace.value, path)
  const named = typeof profile === 'object' && profile !== null
    ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
    : undefined
  return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(provider)
}

/**
 * Render one provider's editing card.
 * @param props - the addressed profile plus wire faces and copy.
 * @returns the editor card.
 */
export function ProviderEditor(props: ProviderEditorProps): ReactNode {
  const { namespace, schema, settingsPath, operations, t } = props
  const [draft, setDraft] = useState<Record<string, unknown>>(() => draftAt(schema, namespace, settingsPath))
  const [keyDraft, setKeyDraft] = useState('')
  const [keyState, setKeyState] = useState<CredentialInfo | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // A settings success advances both retry baselines immediately. Keeping the
  // derived fields in the draft prevents a pushed namespace refresh from
  // turning them into deletions when the following credential write is retried.
  const [committedOriginal, setCommittedOriginal] = useState<unknown>(
    () => schema.getPath(namespace.user, settingsPath),
  )
  const [expectedRevision, setExpectedRevision] = useState(() => namespace.revision)
  const root = useMemo(() => schema.rehydrate(namespace.schema), [namespace.schema, schema])
  const node = useMemo(() => schema.nodeAtPath(root, settingsPath), [root, schema, settingsPath])
  const fallback = schema.getPath(namespace.value, settingsPath)
  const disabled = props.readOnly || busy
  const layout = layoutOf(namespace.ns)
  const keyRef = refFor(schema, namespace, settingsPath, props.provider)
  // The same schema read the create card makes, so the choices offered here
  // and there cannot drift apart: both come from the adapter's own `Config`.
  // Only the pi-ai layout has a per-route protocol for the read to find, and
  // it rehydrates the whole section schema, so the other layouts skip it.
  const protocols = useMemo(
    () => layout === 'pi-ai' ? protocolChoices(namespace, schema) : [],
    [layout, namespace, schema],
  )

  useEffect(() => {
    let stale = false
    setKeyState(undefined)
    // The key state is a placeholder hint, not a precondition for editing: a
    // refused describe leaves the card without the "already configured" hint.
    void operations.describeCredential(keyRef).then((described) => {
      if (stale) return
      setKeyState(described)
    })
    return () => { stale = true }
  }, [operations, keyRef])

  const stringAt = (source: unknown, key: string): string | undefined => {
    const value = schema.getPath(source, [key])
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
  }
  const setField = (key: string, next: string | undefined): void => {
    // A value of nothing but whitespace is cleared, not stored: `stringAt`
    // already reports it as absent, so the field would otherwise render empty
    // while the draft still carried the spaces into `settings.yaml`, where
    // both adapters would accept that non-empty string as a real value.
    const value = next === undefined || next.trim().length === 0 ? undefined : next
    setDraft(current => value === undefined
      ? schema.deletePath(current, [key])
      : schema.setPath(current, [key], value))
  }

  // The model list is validated by the same per-row checker for both families,
  // so a bad row is named by its position rather than by a blanket message.
  const modelFailure = validateDeepSeekModels(schema.getPath(draft, ['models']))
  const keyFailure = apiKeyFailure(keyDraft)
  // What a probe or a write must carry: the typed key with paste whitespace
  // removed. A blank field yields an empty string, which both call sites read
  // as "no key supplied" rather than as a key — that is how a card whose
  // provider already has a stored key is edited without re-entering it.
  const keyValue = keyDraft.trim()
  const credentialRequiredFailure = props.credentialRequired === true
    && keyDraft.length > 0 && keyValue.length === 0
    ? 'keyRequired' as const
    : undefined
  const shownKeyFailure = credentialRequiredFailure ?? keyFailure
  // What the form currently shows, which is what an interrogation must ask:
  // an edited-but-unsaved endpoint, and a key typed but not yet stored.
  const probeApi = stringAt(draft, 'api') ?? stringAt(fallback, 'api')
  const probeBaseURL = stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL')
  const probe = {
    settingsNs: namespace.ns,
    // Naming the route lets an adapter that already describes it answer from
    // its own registry — better metadata, no network call, no endpoint needed.
    provider: props.provider,
    ...probeBaseURL === undefined ? {} : { baseURL: probeBaseURL },
    ...probeApi === undefined ? {} : { api: probeApi },
    ...keyValue.length === 0 ? {} : { apiKey: keyValue },
  }
  /**
   * The write for this card, or a failure message. Every edit travels as
   * path ops against the STORED section: the draft comes from the redacted
   * descriptor, so a wholesale replace rebuilt from it could delete fields
   * outside the card. Ops name only the fields this card can see.
   */
  const applyOnce = async (): Promise<string | undefined> => {
    const ns = namespace.ns
    // A pi-ai profile names the conventional reference only when this page is
    // about to store a key. Otherwise the provider keeps its native auth path.
    const next = layout === 'pi-ai' && stringAt(draft, 'apiKeyEnv') === undefined
      && stringAt(fallback, 'apiKeyEnv') === undefined && keyValue.length > 0
      ? schema.setPath(draft, ['apiKeyEnv'], keyRef)
      : draft
    if (props.credentialOnly !== true) {
      // The same checker gates the submit button, so a card cannot reach this
      // with a bad row; it stays because the schema check below would refuse
      // the write with a message naming a path instead of the row, and because
      // nothing but this function decides what is written.
      const failure = validateDeepSeekModels(schema.getPath(next, ['models']))
      /* v8 ignore next 3 -- unreachable from the card: the same failure disables submit */
      if (failure !== undefined) {
        return `${t('model')} ${String(failure.index + 1)}: ${t(failure.key)}`
      }
    }
    /* v8 ignore next -- apply is only reachable from the rendered card, which required a resolved node */
    if (props.credentialOnly !== true && node !== undefined && settingsPath.length === 0) {
      const sectionError = schema.validate(node, next)
      if (sectionError !== undefined) return sectionError
    }
    const materializesNativeProfile = layout === 'pi-ai'
      && fallback === undefined
      && committedOriginal === undefined
      && Object.keys(next).length === 0
    const ops: SettingsPathOpView[] = props.credentialOnly === true
      ? []
      : materializesNativeProfile
        ? [{ op: 'set', path: [...settingsPath], value: {} }]
        : pathOps(settingsPath, committedOriginal, next)
    if (ops.length > 0) {
      const written = await operations.writeSettings(ns, ops, expectedRevision)
      if (written.kind !== 'written') return written.kind === 'conflict' ? t('conflict') : written.message
      setCommittedOriginal(schema.getPath(written.view.user, settingsPath))
      setExpectedRevision(written.view.revision)
      setDraft(next)
    }
    if (keyValue.length > 0) {
      const stored = await operations.storeCredential(keyRef, keyValue)
      if (stored !== undefined) return stored
    }
    setKeyDraft('')
    return undefined
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const failure = await applyOnce()
      if (failure !== undefined) {
        setFailure(failure)
        return
      }
      props.onClose(true)
    } finally {
      setBusy(false)
    }
  }

  if (node === undefined) {
    // A directory entry addressing a position its schema cannot resolve is a
    // host-side inconsistency; showing it beats a blank card.
    return <p className={styles['error']}>{props.provider}: {props.t('settingsPathUnresolvable')}</p>
  }

  const keyLocked = keyState?.writable === false

  /**
   * The catalog beneath the user layer: what the composition entry pinned, or
   * else the schema default that `resolve` would supply. The effective value
   * cannot answer this — it still carries the stored override until the unset
   * is applied, so reading it would echo that override straight back the
   * moment reset drops it, leaving the rows unchanged until a reload.
   */
  const inheritedModels = (): unknown => {
    const pinned = schema.getPath(namespace.base, [...settingsPath, 'models'])
    return pinned ?? schema.nodeAtPath(root, [...settingsPath, 'models'])?.meta.default
  }

  /**
   * The curated fields of one known adapter family. The family arrives
   * narrowed so the per-family branches below are total: an unknown namespace
   * renders the hint instead and never reaches this body.
   */
  const curatedFields = (family: 'deepseek' | 'pi-ai'): ReactNode => {
    // What a hand-declared route names for itself and nothing else can supply.
    // A whole-section `llm-deepseek` profile is a composition fact with no
    // per-route identity for its schema to carry, hence the family test.
    const ownsIdentity = family === 'pi-ai' && props.declared === true
    const customModels = schema.getPath(draft, ['models'])
    const modelsOverridden = schema.hasPath(draft, ['models'])
    const models = modelDrafts(modelsOverridden ? customModels : inheritedModels())
    const defaultContextWindow = schema.getPath(fallback, ['defaultContextWindow'])
    const defaultMaxTokens = schema.getPath(fallback, ['maxTokens'])
    const keyPlaceholder = keyLocked
      ? t('keyEnvLocked')
      : keyState?.configured === true && props.credentialRequired !== true
        ? t('keyStored')
        : family === 'pi-ai' ? t('keyPlaceholderNative') : t('keyPlaceholder')
    /** What both family editors take: the rows, whose layer owns them, and the two writes. */
    const catalogProps = {
      models,
      overridden: modelsOverridden,
      t,
      disabled,
      onChange: (next: Record<string, unknown>[]) => {
        setDraft(current => schema.setPath(current, ['models'], next))
      },
      onReset: () => { setDraft(current => schema.deletePath(current, ['models'])) },
    }
    return (
      <>
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('keyInput')}</span>
          <input
            className={styles['input']}
            type="password"
            autoComplete="off"
            value={keyDraft}
            placeholder={keyPlaceholder}
            aria-label={t('keyInput')}
            aria-invalid={shownKeyFailure !== undefined}
            required={props.credentialRequired === true}
            autoFocus={props.autoFocusCredential === true}
            disabled={disabled || keyLocked}
            onChange={(event) => { setKeyDraft(event.target.value) }}
          />
          {shownKeyFailure === undefined ? null : <p className={styles['error']}>{t(shownKeyFailure)}</p>}
        </div>
        {props.credentialOnly === true ? null : <details className={styles['customized']}>
          <summary className={styles['customizedSummary']}>{t('customized')}</summary>
          <div className={styles['customizedBody']}>
            {/* The name and the protocol are the create card's two remaining
                profile fields; a route the adapter ships defaults both from
                its catalog entry and neither belongs on its card. */}
            {ownsIdentity
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    value={stringAt(draft, 'displayName') ?? ''}
                    // What this route is called the moment the field is
                    // cleared, which is the layer beneath the one this field
                    // edits: a `cordis.yml` may pin a name for a route the
                    // catalog does not ship, and only when nothing does is
                    // the answer the route id. Reading the effective value
                    // instead would echo the stored override back as the
                    // thing clearing restores.
                    placeholder={stringAt(schema.getPath(namespace.base, settingsPath), 'displayName')
                      ?? props.provider}
                    aria-label={t('customDisplayName')}
                    disabled={disabled}
                    onChange={(event) => { setField('displayName', event.target.value) }}
                  />
                </div>
              )
              : null}
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
              <input
                className={styles['input']}
                type="text"
                value={stringAt(draft, 'baseURL') ?? ''}
                placeholder={family === 'deepseek'
                  ? t(stringAt(fallback, 'protocol') === 'messages' ? 'deepSeekMessagesBaseUrl' : 'deepSeekChatBaseUrl')
                  : stringAt(fallback, 'baseURL') ?? t('baseUrlDefault')}
                aria-describedby={family === 'deepseek' ? `${props.provider}-endpoint-hint` : undefined}
                aria-label={t('baseUrl')}
                disabled={disabled}
                onChange={(event) => {
                  setField('baseURL', event.target.value === '' ? undefined : event.target.value)
                }}
              />
              {family === 'deepseek' ? <span id={`${props.provider}-endpoint-hint`} className={styles['advancedHint']}>{t('deepSeekEndpointHint')}</span> : null}
            </div>
            {/* The protocol sits beside the endpoint it describes, as it does
                on the create card. */}
            {ownsIdentity
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('customApi')}</span>
                  <select
                    className={`${styles['input']} ${styles['selectInput']}`}
                    value={probeApi ?? ''}
                    aria-label={t('customApi')}
                    disabled={disabled}
                    onChange={(event) => { setField('api', event.target.value) }}
                  >
                    {/* A profile naming no protocol — hand-written into
                        settings.yaml with no model to need one — selects
                        nothing rather than reading as if it had picked the
                        first choice. The option is named because a screen
                        reader announces it either way, and an empty one is
                        announced as a choice with no identity. */}
                    {probeApi === undefined ? <option value="">{t('customApiUnset')}</option> : null}
                    {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                  </select>
                </div>
              )
              : null}
            {/* Both families edit the same rows through the same contract; only
                the extras differ — DeepSeek's inherited capacities, pi-ai's
                endpoint interrogation. */}
            {family === 'deepseek'
              ? (
                <DeepSeekModelsEditor
                  {...catalogProps}
                  defaultContextWindow={typeof defaultContextWindow === 'number'
                    ? defaultContextWindow
                    : undefined}
                  defaultMaxTokens={typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined}
                />
              )
              : (
                <ModelListEditor
                  {...catalogProps}
                  probe={probe}
                  probeBlocked={keyFailure}
                  operations={operations}
                />
              )}
          </div>
        </details>}
      </>
    )
  }

  return (
    <div className={props.credentialOnly === true ? styles['addBlock'] : styles['editor']}>
      {props.hideTitle === true
        ? null
        : (
          <div className={styles['editorHeader']}>
            <span className={styles['editorTitle']}>{props.displayName}</span>
            {props.provider !== props.displayName
              ? <span className={styles['editorRoute']}>{props.provider}</span>
              : null}
          </div>
        )}
      {layout === 'unknown'
        ? <p className={styles['advancedHint']}>{`${t('advancedHint')} (${namespace.ns})`}</p>
        : curatedFields(layout)}
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      {props.credentialOnly === true || modelFailure === undefined
        ? null
        : (
          <p className={styles['advancedHint']}>
            {`${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`}
          </p>
        )}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || layout === 'unknown'
          || (props.credentialOnly !== true && modelFailure !== undefined)
          || shownKeyFailure !== undefined
          || (props.credentialRequired === true && keyValue.length === 0)}
        submitLabelKey={props.submitLabelKey ?? 'apply'}
        submitBusyLabelKey={props.submitBusyLabelKey ?? 'applying'}
        {...props.cancelLabelKey === undefined ? {} : { cancelLabelKey: props.cancelLabelKey }}
        onCancel={() => { props.onClose(false) }}
        onSubmit={() => { void apply() }}
      />
    </div>
  )
}
