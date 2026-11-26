import { es, fr, de, ru, pt } from '../src/client/locales.ts'
// @vitest-environment jsdom
/** Section, setup-card, and hand-written editor behavior over a scripted wire face. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  CredentialInfo, RemoteResult, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  ModelsSection, needsSetup, providerCopy, providerTargetLabel, removeProviderProfile,
} from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { ApiKeyInput } from '../src/client/ApiKeyInput.tsx'
import { ProviderEditor, pathOps } from '../src/client/ProviderEditor.tsx'
import type { ProviderEditorProps } from '../src/client/ProviderEditor.tsx'
import {
  DeepSeekModelsEditor, formatCapacity, modelDrafts, modelRowFailures, parseCapacity, validateDeepSeekModels,
} from '../src/client/DeepSeekModelsEditor.tsx'
import { apiKeyFailure } from '../src/client/apiKey.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { deriveKeyRef, ModelsSettingsStore } from '../src/client/store.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import type { ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]
const OPENAI_TARGET = { provider: 'openai', displayName: 'openai' }
const openaiCopy = (template: string): string => providerCopy(template, OPENAI_TARGET)
const DEEPSEEK_TARGET = { provider: 'deepseek-official', displayName: 'DeepSeek' }
const deepSeekCopy = (template: string): string => providerCopy(template, DEEPSEEK_TARGET)

/** One model row's fold button (1-based, as the labels read). */
function rowToggle(position: number): HTMLElement {
  return screen.getByLabelText(`${en.modelAdvanced} ${String(position)}`)
}

/** Unfold one model row, where its fields live; a row that is already unfolded stays so. */
function expandRow(position: number): void {
  const toggle = rowToggle(position)
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
}

/** The model ID each folded row names in its text, in row order. */
function foldedModelIds(): (string | null)[] {
  return [...document.querySelectorAll('[data-row-key] [class*="modelSummaryId"]')].map(id => id.textContent)
}

/** The footer of the one editor card on the page, found by its commit label: its notes and its two actions. */
function editorFooter(submitLabel: string = en.apply): HTMLElement {
  const footer = screen.getByText(submitLabel).closest<HTMLElement>('[class*="editorFooter"]')
  if (footer === null) throw new Error('the editor card has no footer')
  return footer
}

/** The notes of the one editor card on the page: what its footer says before its actions. */
function editorNotes(submitLabel: string = en.apply): string | null {
  return editorFooter(submitLabel).querySelector('[class*="editorNotes"]')?.textContent ?? null
}

/**
 * The reason a refused save put under one model field: the text the invalid
 * input is described by, inside the input's own label. Null while the field is
 * not marked.
 */
function refusalOf(field: HTMLElement): string | null {
  if (field.getAttribute('aria-invalid') !== 'true') return null
  const reason = field.closest('label')?.querySelector(`[id="${field.getAttribute('aria-describedby') ?? ''}"]`)
  return reason?.textContent ?? null
}

/** The capacity inputs of every open row, in row order. */
function capacityInputs(label: string): HTMLInputElement[] {
  return screen.getAllByLabelText<HTMLInputElement>(new RegExp(label))
}

/** Form of one pi-ai route's profile: a dict entry of the adapter row, and the whole form of a provider row. */
const PiAiProfile = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  api: Schema.union(['openai-completions', 'openai-responses', 'anthropic-messages']),
  baseURL: Schema.string(),
  reasoning: Schema.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  headers: Schema.dict(Schema.string()),
})

const PiAiConfig = Schema.object({ providers: Schema.dict(PiAiProfile) })

const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string().pattern(/^https:\/\//),
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
  defaultContextWindow: Schema.number().step(1).min(1),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    description: Schema.string(),
    contextWindow: Schema.number().step(1).min(1),
  // The adapter declares its catalog as a schema default rather than a
  // composition entry, which is what the restore-defaults path has to read.
  })).default([
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
      description: '',
      contextWindow: 1_000_000,
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: '',
      contextWindow: 1_000_000,
    },
  ]),
})

const DEFAULT_DEEPSEEK_MODELS = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: 'Preserved hidden detail',
    contextWindow: 1_000_000,
  },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 },
]

function wireNamespaces(): SettingsNamespaceView[] {
  return [
    {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://base',
        defaultContextWindow: 1_000_000,
        maxTokens: 256_000,
        models: DEFAULT_DEEPSEEK_MODELS,
      },
      base: { defaultContextWindow: 1_000_000, maxTokens: 256_000, models: DEFAULT_DEEPSEEK_MODELS },
      user: { baseURL: 'https://base' },
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-plain',
      schema: JSON.parse(JSON.stringify(Schema.object({
        profiles: Schema.dict(Schema.object({ note: Schema.string() })),
      }).toJSON())) as JsonValue,
      value: {},
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
      value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'subagent-model-selection',
      schema: JSON.parse(JSON.stringify(Schema.object({ enabled: Schema.boolean().default(false) }).toJSON())) as JsonValue,
      value: { enabled: false },
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 4,
    },
    {
      ns: 'llm-deepseek-account',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: {
        baseURL: 'https://base',
        defaultContextWindow: 1_000_000,
        maxTokens: 256_000,
        models: DEFAULT_DEEPSEEK_MODELS,
      },
      base: { defaultContextWindow: 1_000_000, maxTokens: 256_000, models: DEFAULT_DEEPSEEK_MODELS },
      user: {},
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
  ]
}

/** Credentials answers over the Remote carrier, which has no envelope. */
function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}
/** The codes this page's scripted Host answers refuse with. */
type RefusalCode = 'credential/rejected' | 'gateway/internal' | 'settings/conflict' | 'settings/rejected'

/** One refusal per code, each carrying the details its own code declares. */
const REFUSALS: { [Code in RefusalCode]: (message: string) => RemoteError<Code> } = {
  'credential/rejected': message => new RemoteError('credential/rejected', message, { ref: 'DEEPSEEK_API_KEY' }),
  'gateway/internal': message => new RemoteError('gateway/internal', message, {}),
  'settings/conflict': message =>
    new RemoteError('settings/conflict', message, { ns: 'llm-pi-ai', expected: 4, actual: 5 }),
  'settings/rejected': message => new RemoteError('settings/rejected', message, { ns: 'llm-pi-ai' }),
}
function remoteFail(message: string, code: RefusalCode = 'credential/rejected') {
  return { ok: false as const, error: REFUSALS[code](message) }
}

function scriptedFace(overrides: {
  update?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
  unset?: ReturnType<typeof vi.fn>
} = {}) {
  const providerNamespace = wireNamespaces().find(view => view.ns === 'llm-pi-ai')!
  const update = overrides.update ?? vi.fn(() => Promise.resolve(remoteOk(providerNamespace)))
  const mutate = overrides.mutate ?? vi.fn(() => Promise.resolve(remoteOk(providerNamespace)))
  const set = overrides.set ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const unset = overrides.unset ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const face = {
    llm: {
      listProviders: vi.fn((): ReturnType<PageContext['remote']['llm']['listProviders']> => Promise.resolve(remoteOk([
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'openai', name: 'openai' },
      ]))),
      listConfigurableProviders: vi.fn(() => Promise.resolve(remoteOk([
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
        {
          provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true,
          defaultBaseURL: 'https://api.openai.com/v1', baseURLEnv: ['FIXTURE_ENDPOINT'], nativeAuth: { env: ['OPENAI_API_KEY'], oauth: false },
        },
        {
          provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false,
          defaultBaseURL: 'https://api.anthropic.com', baseURLEnv: ['FIXTURE_ENDPOINT'],
          nativeAuth: { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
        },
        { provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'], active: false },
        { provider: 'broken', displayName: 'broken', settingsNs: 'llm-pi-ai', settingsPath: ['nope', 'x'], active: false },
        { provider: 'plain', displayName: 'plain', settingsNs: 'llm-plain', settingsPath: ['profiles', 'plain'], active: false },
      ].map(({ active: _active, ...entry }) => entry)))),
      discoverModels: vi.fn(() => Promise.resolve(remoteOk([]))),
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: wireNamespaces() }))),
      update,
      mutate,
    },
    credentials: {
      // Typed as the Remote answer rather than the success branch alone: a
      // case that scripts a refusal replaces this mock.
      describe: vi.fn((refs: string[]): Promise<RemoteResult<Record<string, CredentialInfo>>> =>
        Promise.resolve(remoteOk(
          Object.fromEntries(refs.map(ref => [ref, {
            configured: ref === 'OPENAI_API_KEY',
            ...ref === 'OPENAI_API_KEY' ? { source: 'file', masked: '••••••••' } : {},
            writable: true,
          }])),
        ))),
      set,
      unset,
    },
  }
  return { face, update, mutate, set, unset }
}

type PageContext = ConstructorParameters<typeof ModelsSettingsStore>[0]

/**
 * The page plugin's context, scripted down to the namespaces the page reaches.
 * One context per face, as in production: an editor effect keyed by the context
 * would otherwise re-probe on every render.
 */
const contexts = new WeakMap<object, PageContext>()
function ctxWith(face: object): PageContext {
  const existing = contexts.get(face)
  if (existing !== undefined) return existing
  const ctx = Object.assign(new Context(), { remote: { ...face,
    session: { initializeDefaultModel: async () => ({ ok: true, value: undefined }) },
  } })
  contexts.set(face, ctx)
  return ctx
}

/**
 * The cards' injected Host operations over the same script, bound once per face
 * as the plugin body binds them: an editor effect keyed by this face would
 * otherwise re-probe on every render.
 */
const operations = new WeakMap<object, ModelsOperations>()
function operationsWith(face: object): ModelsOperations {
  const existing = operations.get(face)
  if (existing !== undefined) return existing
  const bound = createModelsOperations(ctxWith(face))
  operations.set(face, bound)
  return bound
}

/** The pi-ai namespace with one more route profile stored in the user layer. */
function piAiNamespaceWith(provider: string, profile: { [key: string]: JsonValue }): SettingsNamespaceView {
  const namespace = wireNamespaces().find(view => view.ns === 'llm-pi-ai')!
  const providers = { ...(namespace.value as { providers: object }).providers, [provider]: profile }
  return { ...namespace, value: { providers }, user: { providers } }
}

/** Render one pi-ai route's editor with the directory and credential facts the page already holds. */
function renderPiAiEditor(
  provider: string,
  namespace: SettingsNamespaceView,
  facts: Pick<ProviderEditorProps, 'defaultBaseURL' | 'baseURLEnv' | 'nativeAuth' | 'credential' | 'credentialChecks'> = {},
): void {
  render(<ProviderEditor provider={provider} displayName={provider}
    namespace={namespace} settingsPath={['providers', provider]} schema={settingsSchema}
    operations={operationsWith(scriptedFace().face)} t={t} readOnly={false} onClose={vi.fn()} {...facts} />)
}

/** Hover the key label's help button and read its tooltip; null when the label has no button. */
function authHelpText(): string | null {
  const button = screen.queryByRole('button', { name: en.authHelp })
  if (button === null) return null
  fireEvent.pointerEnter(button)
  return screen.getByRole('tooltip').textContent
}

/** Open the input of a saved key through its replace action. */
function replaceSavedKey(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: en.keyReplace }))
  return screen.getByLabelText<HTMLInputElement>(en.keyInput)
}

/** One recorded child-slot dispatch: seat name, owner share, kind options. */
type RenderSlotCall = [name: string, owner: Record<string, unknown>, opts?: { entryKey?: string }]

/** Child-slot dispatch stub: records every seat occurrence, renders nothing. */
function stubRenderSlot() {
  return vi.fn((..._call: RenderSlotCall) => null)
}

/** The provider-card seat dispatches a stub recorded, as (route id, configured, keyConfigured, entryKey). */
function cardSeatCalls(
  renderSlot: ReturnType<typeof stubRenderSlot>,
): Array<[string, boolean, boolean, string | undefined]> {
  return renderSlot.mock.calls
    .filter(call => call[0] === 'settings.models.provider-card')
    .map(call => [
      (call[1] as { provider: { provider: string } }).provider.provider,
      (call[1] as { configured: boolean }).configured,
      (call[1] as { keyConfigured: boolean }).keyConfigured,
      call[2]?.entryKey,
    ])
}

async function mountFace(scripted: ReturnType<typeof scriptedFace>) {
  const { face, update, mutate, set, unset } = scripted
  const ctx = ctxWith(face)
  const mirror = new SettingsDescribeMirror(ctx)
  const controller = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await controller.load()
  const renderSlot = stubRenderSlot()
  const injected: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    operations: operationsWith(face),
    schema: settingsSchema,
    t,
    renderSlot: renderSlot as unknown as ModelsSectionProps['renderSlot'],
  }
  const view = render(<ModelsSection {...injected} />)
  return { view, ctx, face, update, mutate, set, unset, controller, mirror, renderSlot }
}

async function mountSection(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  return mountFace(scriptedFace(overrides))
}

/**
 * Mount for a user who cannot reach any provider yet: no credential is stored
 * anywhere, so the whole-section DeepSeek route owns the first-run setup card.
 */
async function mountFirstRun(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  const scripted = scriptedFace(overrides)
  scripted.face.credentials.describe.mockImplementation((refs: string[]) =>
    Promise.resolve(remoteOk(
      Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
    )))
  return mountFace(scripted)
}

/**
 * Mount and open the DeepSeek editor. The shared fixture already has a usable
 * openai route, so DeepSeek is an ordinary row whose card opens through Edit
 * rather than by itself.
 */
async function mountDeepSeekCard(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  const mounted = await mountSection(overrides)
  fireEvent.click(screen.getByRole('button', { name: deepSeekCopy(en.editProvider) }))
  return mounted
}

/**
 * The scripted page with two pi-ai provider rows beside the dict's routes, each a settings namespace of its own:
 * `team-gateway`, which a layer after the profile adds, and `bundle-gateway`, which a bundle supplies.
 * @param team - namespace that the directory names for `team-gateway`.
 */
async function withProviderRows(scripted = scriptedFace(), team = 'hub-team') {
  const view = (ns: string, base: Record<string, JsonValue>, value: Record<string, JsonValue>): SettingsNamespaceView => ({
    ns, schema: JSON.parse(JSON.stringify(PiAiProfile.toJSON())) as JsonValue, value, base, user: {},
    autoGenerate: false, applies: 'live', secrets: [], revision: 0,
  })
  const gateway = (displayName: string, baseURL: string): Record<string, JsonValue> =>
    ({ displayName, apiKeyEnv: 'TEAM_KEY', api: 'anthropic-messages', baseURL })
  const namespaces = [
    ...wireNamespaces(),
    // Neither the bundles nor the profile patch configure a row that a later layer adds.
    view('hub-team', {}, gateway('Team Gateway', 'https://hub.example/v1')),
    view('hub-team-2', {}, gateway('Team Gateway 2', 'https://hub-2.example/v1')),
    view('bundle-team', gateway('Bundle Gateway', 'https://bundle.example/v1'), gateway('Bundle Gateway', 'https://bundle.example/v1')),
  ]
  scripted.face.settings.describe.mockResolvedValue(remoteOk({ writable: true, hasDocument: false, namespaces }))
  const directory = await scripted.face.llm.listConfigurableProviders()
  scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([
    // A second call moves `team-gateway` to another row instead of listing the route twice.
    ...directory.value.filter(entry => entry.provider !== 'team-gateway' && entry.provider !== 'bundle-gateway'),
    { provider: 'team-gateway', displayName: 'Team Gateway', settingsNs: team, settingsPath: [], declared: true },
    { provider: 'bundle-gateway', displayName: 'Bundle Gateway', settingsNs: 'bundle-team', settingsPath: [], declared: true },
  ]))
  return scripted
}

const TEAM_TARGET = { provider: 'team-gateway', displayName: 'Team Gateway' }
const BUNDLE_TARGET = { provider: 'bundle-gateway', displayName: 'Bundle Gateway' }

describe('ModelsSection', () => {
  it('lays out a pi-ai provider row as a pi-ai route with the config it runs with, and offers no removal', async () => {
    const { controller, mutate } = await mountFace(await withProviderRows())
    const rows = new Map(controller.store.getSnapshot().rows.map(row => [row.entry.provider, row]))
    expect(rows.get('team-gateway')).toMatchObject({ configured: true, removable: false, adapterNs: 'llm-pi-ai', apiKeyEnv: 'TEAM_KEY' })
    expect(rows.get('bundle-gateway')).toMatchObject({ configured: true, removable: false, adapterNs: 'llm-pi-ai' })
    expect(screen.queryByRole('button', { name: providerCopy(en.removeProvider, TEAM_TARGET) })).toBeNull()

    const edit = screen.getByRole('button', { name: providerCopy(en.editProvider, TEAM_TARGET) })
    // The open row drops its Edit button, so the row is found before the click.
    const card = edit.closest('li')!
    fireEvent.click(edit)
    fireEvent.click(within(card).getByText(en.customized))
    // The profile's own layers say nothing about a row that a later layer adds, so a cleared field returns to the
    // running value; the protocols offered are the ones of the row's own form.
    const url = within(card).getByLabelText<HTMLInputElement>(en.baseUrl)
    expect([url.value, url.placeholder, url.disabled]).toEqual(['', 'https://hub.example/v1', false])
    expect(within(card).getByLabelText<HTMLInputElement>(en.customDisplayName).placeholder).toBe('Team Gateway')
    const protocol = within(card).getByLabelText<HTMLSelectElement>(en.customApi)
    expect([...protocol.options].map(option => option.value)).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
    expect(protocol.value).toBe('anthropic-messages')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('stores a key typed for a pi-ai provider row under the reference the row names, without a settings write', async () => {
    const { mutate, set } = await mountFace(await withProviderRows())
    const edit = screen.getByRole('button', { name: providerCopy(en.editProvider, TEAM_TARGET) })
    // The open row drops its Edit button, so the row is found before the click.
    const card = edit.closest('li')!
    fireEvent.click(edit)
    fireEvent.change(within(card).getByLabelText<HTMLInputElement>(en.keyInput), { target: { value: 'sk-team' } })
    fireEvent.click(within(card).getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledWith('TEAM_KEY', 'sk-team') })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('writes an edited field of a pi-ai provider row at the root of the row\'s own namespace', async () => {
    const { mutate } = await mountFace(await withProviderRows())
    expect(screen.queryByRole('button', { name: providerCopy(en.removeProvider, BUNDLE_TARGET) })).toBeNull()
    const edit = screen.getByRole('button', { name: providerCopy(en.editProvider, BUNDLE_TARGET) })
    // The open row drops its Edit button, so the row is found before the click.
    const card = edit.closest('li')!
    fireEvent.click(edit)
    fireEvent.click(within(card).getByText(en.customized))
    const url = within(card).getByLabelText<HTMLInputElement>(en.baseUrl)
    // A bundle's row keeps the composed base as the layer a cleared field returns to.
    expect([url.value, url.placeholder]).toEqual(['', 'https://bundle.example/v1'])
    fireEvent.change(url, { target: { value: 'https://bundle.example/v2' } })
    fireEvent.click(within(card).getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // The row's whole config section is the profile, so the field is addressed at the root of the row's namespace.
    expect(mutate.mock.calls[0]).toEqual(['bundle-team', [{ op: 'set', path: ['baseURL'], value: 'https://bundle.example/v2' }], 0])
  })

  it('starts a fresh draft when another provider row begins to serve the route being edited', async () => {
    const scripted = await withProviderRows()
    const { controller } = await mountFace(scripted)
    // The open row drops its Edit button, so the row is found before the click; the refresh keeps the row's element.
    const edit = screen.getByRole('button', { name: providerCopy(en.editProvider, TEAM_TARGET) })
    const card = within(edit.closest('li')!)
    fireEvent.click(edit)
    fireEvent.click(card.getByText(en.customized))
    const url = (): HTMLInputElement => card.getByLabelText<HTMLInputElement>(en.baseUrl)
    fireEvent.change(url(), { target: { value: 'https://typed.example/v1' } })
    expect(url().value).toBe('https://typed.example/v1')

    // The same route is now served by another row: a draft typed against the first row's config must not be
    // written into the second row's namespace.
    await withProviderRows(scripted, 'hub-team-2')
    await act(async () => { await controller.load() })
    fireEvent.click(card.getByText(en.customized))
    expect([url().value, url().placeholder]).toEqual(['', 'https://hub-2.example/v1'])
  })

  it('keeps the credential state unconfirmed when its redacted read fails', async () => {
    const scripted = scriptedFace()
    scripted.face.credentials.describe.mockResolvedValue(remoteFail('credentials unavailable', 'gateway/internal'))
    await mountFace(scripted)
    const edit = screen.getByRole('button', { name: openaiCopy(en.editProvider) })
    // The open row drops its Edit button, so the row is found before the click.
    const row = within(edit.closest('li')!)
    fireEvent.click(edit)
    expect(row.getByText(en.keyFallbackUnchecked)).toBeTruthy()
    expect(row.queryByText(en.keyFallbackMissing.replace('{hint}', 'OPENAI_API_KEY'))).toBeNull()
  })

  it('waits for the current snapshot when a setup surface remounts during refresh', async () => {
    const { view, controller, face, mirror, mutate } = await mountFirstRun()
    view.unmount()
    const before = controller.store.getSnapshot().namespaces.get('llm-deepseek')!
    mirror.acceptView({
      ...before,
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://current.example', models: DEFAULT_DEEPSEEK_MODELS },
      user: { baseURL: 'https://current.example' },
      revision: 1,
    })
    const read = Promise.withResolvers<RemoteResult<Record<string, CredentialInfo>>>()
    const started = Promise.withResolvers<undefined>()
    face.credentials.describe.mockImplementationOnce(() => { started.resolve(undefined); return read.promise })
    let refreshing: Promise<void> | undefined
    try {
      await act(async () => { refreshing = controller.load(); await started.promise })
      expect(controller.store.getSnapshot().namespaces.get('llm-deepseek')?.revision).toBe(0)
      render(<ModelsSection
        controller={controller}
        useSnapshot={bindSnapshotSelector(controller.store)}
        operations={operationsWith(face)}
        schema={settingsSchema}
        t={t}
        renderSlot={() => null}
      />)
      expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
      expect(screen.queryByLabelText(en.keyInput)).toBeNull()
      expect(screen.queryByRole('button', { name: en.add })).toBeNull()
    } finally {
      await act(async () => { read.resolve(remoteOk({})); await refreshing })
    }
    await screen.findByLabelText(en.keyInput)
    fireEvent.click(screen.getByText(en.customized))
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(url.value).toBe('https://current.example')
    fireEvent.change(url, { target: { value: 'https://next.example' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith(
      'llm-deepseek', [{ op: 'set', path: ['baseURL'], value: 'https://next.example' }], 1,
    ) })
    await screen.findByRole('status')
  })

  it('waits for the current snapshot before remounting setup after a failed page load', async () => {
    const { controller, face, mirror, mutate } = await mountFirstRun()
    const oldKey = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(oldKey, { target: { value: 'sk-discarded-on-error' } })
    face.llm.listProviders.mockResolvedValueOnce(remoteFail('directory unavailable', 'gateway/internal'))
    await act(async () => { await controller.load() })
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(screen.getByText(`${en.loadFailed}: directory unavailable`)).toBeTruthy()
    const before = controller.store.getSnapshot().namespaces.get('llm-deepseek')!
    mirror.acceptView({
      ...before,
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://recovered.example', models: DEFAULT_DEEPSEEK_MODELS },
      user: { baseURL: 'https://recovered.example' },
      revision: 2,
    })
    const read = Promise.withResolvers<RemoteResult<Record<string, CredentialInfo>>>()
    const started = Promise.withResolvers<undefined>()
    const describe = face.credentials.describe.getMockImplementation()!
    face.credentials.describe.mockImplementation((refs) => {
      if (refs.length > 1) { started.resolve(undefined); return read.promise }
      return describe(refs)
    })
    const load = vi.spyOn(controller, 'load')
    try {
      fireEvent.click(screen.getByRole('button', { name: en.retry }))
      await act(async () => { await started.promise })
      expect(load).toHaveBeenCalledOnce()
      expect(controller.store.getSnapshot()).toMatchObject({ status: 'loading' })
      expect(controller.store.getSnapshot().namespaces.get('llm-deepseek')?.revision).toBe(0)
      expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
      expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    } finally {
      await act(async () => { read.resolve(remoteOk({})); await load.mock.results[0]?.value })
      load.mockRestore()
    }
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(key).not.toBe(oldKey)
    expect(key.value).toBe('')
    fireEvent.click(screen.getByText(en.customized))
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(url.value).toBe('https://recovered.example')
    fireEvent.change(url, { target: { value: 'https://after-retry.example' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith(
      'llm-deepseek', [{ op: 'set', path: ['baseURL'], value: 'https://after-retry.example' }], 2,
    ) })
    await screen.findByRole('status')
  })

  it('preserves a mounted setup draft while its current refresh is pending', async () => {
    const { controller, face } = await mountFirstRun()
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-unsaved-setup-draft' } })
    const read = Promise.withResolvers<RemoteResult<Record<string, CredentialInfo>>>()
    face.credentials.describe.mockImplementationOnce(() => read.promise)
    let refreshing: Promise<void> | undefined
    try {
      act(() => { refreshing = controller.load() })
      expect(screen.getByLabelText(en.keyInput)).toBe(key)
      expect(key.value).toBe('sk-unsaved-setup-draft')
    } finally {
      await act(async () => { read.resolve(remoteOk({})); await refreshing })
    }
    expect(screen.getByLabelText(en.keyInput)).toBe(key)
    expect(key.value).toBe('sk-unsaved-setup-draft')
  })

  it('checks current readiness before opening an editor and preserves an open draft during refresh', async () => {
    const { controller } = await mountSection()
    const edit = screen.getByRole('button', { name: deepSeekCopy(en.editProvider) })
    const ready = controller.store.getSnapshot()
    const snapshot = vi.spyOn(controller.store, 'getSnapshot').mockReturnValue({ ...ready, status: 'loading' })
    try {
      fireEvent.click(edit)
      expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    } finally {
      snapshot.mockRestore()
    }
    fireEvent.click(edit)
    const key = await screen.findByLabelText(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-unsaved-draft' } })
    act(() => { controller.store.update((state) => { state.status = 'loading' }) })
    expect((key as HTMLInputElement).value).toBe('sk-unsaved-draft')
    // The open row offers no Edit, and no other row opens over the draft until the refresh lands.
    expect(screen.queryByRole('button', { name: deepSeekCopy(en.editProvider) })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: openaiCopy(en.editProvider) }).disabled).toBe(true)
    // The card's own Cancel still dismisses it during the refresh.
    fireEvent.click(screen.getByText(en.cancel))
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: deepSeekCopy(en.editProvider) }).disabled).toBe(true)
  })

  it('checks current readiness before adding or starting removal from rendered rows', async () => {
    const { controller, mutate, unset } = await mountSection()
    const add = screen.getByRole('button', { name: en.add })
    const remove = screen.getByRole('button', { name: openaiCopy(en.removeProvider) })
    const ready = controller.store.getSnapshot()
    const snapshot = vi.spyOn(controller.store, 'getSnapshot').mockReturnValue({ ...ready, status: 'loading' })
    try {
      fireEvent.click(add)
      fireEvent.click(remove)
      expect(screen.queryByLabelText(en.provider)).toBeNull()
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
      expect(mutate).not.toHaveBeenCalled()
      expect(unset).not.toHaveBeenCalled()
    } finally {
      snapshot.mockRestore()
    }
    fireEvent.click(add)
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
  })

  it('blocks new Add and Remove actions while a joined refresh retains an open add draft', async () => {
    const { controller, face } = await mountSection()
    const add = screen.getByRole<HTMLButtonElement>('button', { name: en.add })
    const remove = screen.getByRole<HTMLButtonElement>('button', { name: openaiCopy(en.removeProvider) })
    const read = Promise.withResolvers<RemoteResult<Record<string, CredentialInfo>>>()
    face.credentials.describe.mockImplementationOnce(() => read.promise)
    let refreshing: Promise<void> | undefined
    try {
      act(() => { refreshing = controller.load() })
      expect(add.disabled).toBe(true)
      expect(remove.disabled).toBe(true)
      expect(screen.getByText('openai')).toBeTruthy()
      fireEvent.click(add)
      fireEvent.click(remove)
      expect(screen.queryByLabelText(en.provider)).toBeNull()
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    } finally {
      await act(async () => {
        read.resolve(remoteOk({ OPENAI_API_KEY: { configured: true, writable: true } }))
        await refreshing
      })
    }
    fireEvent.click(add)
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-unsaved-add-draft' } })
    act(() => { controller.store.update((state) => { state.status = 'loading' }) })
    expect(key.value).toBe('sk-unsaved-add-draft')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.add }).disabled).toBe(true)
  })

  it('waits for saved credential confirmation before removing its managed key', async () => {
    const configured = new Set(['DEEPSEEK_API_KEY'])
    const set = vi.fn((ref: string) => { configured.add(ref); return Promise.resolve(remoteOk(undefined)) })
    const scripted = scriptedFace({ set })
    const read = Promise.withResolvers<RemoteResult<Record<string, CredentialInfo>>>()
    const started = Promise.withResolvers<undefined>()
    let holdJoin = false
    const answer = (refs: string[]): RemoteResult<Record<string, CredentialInfo>> => remoteOk(
      Object.fromEntries(refs.map(ref => [ref, { configured: configured.has(ref), writable: true }])),
    )
    scripted.face.credentials.describe.mockImplementation((refs: string[]) => {
      if (holdJoin && refs.length > 1) { started.resolve(undefined); return read.promise }
      return Promise.resolve(answer(refs))
    })
    const { controller, unset, mutate } = await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.editProvider) }))
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-new-managed-key' } })
    holdJoin = true
    try {
      fireEvent.click(screen.getByRole('button', { name: en.apply }))
      await act(async () => { await started.promise })
      expect(configured.has('OPENAI_API_KEY')).toBe(true)
      expect(controller.store.getSnapshot().rows.find(row => row.entry.provider === 'openai')?.credential?.configured).toBe(false)
      const remove = screen.getByRole<HTMLButtonElement>('button', { name: openaiCopy(en.removeProvider) })
      expect(remove.disabled).toBe(true)
      fireEvent.click(remove)
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
      holdJoin = false
      await act(async () => { read.resolve(answer(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])) })
      await screen.findByText(openaiCopy(en.savedProvider))
      fireEvent.click(remove)
      const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
      expect(dialog.textContent).toContain(openaiCopy(en.deleteDescriptionWithCredential))
      fireEvent.click(within(dialog).getByRole('button', { name: openaiCopy(en.deleteConfirm) }))
      await waitFor(() => { expect(unset).toHaveBeenCalledWith('OPENAI_API_KEY') })
      await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
      await waitFor(() => { expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull() })
    } finally {
      holdJoin = false
      await act(async () => { read.resolve(answer(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])) })
    }
  })

  it('hides the add action when no settings namespace can open an editor', async () => {
    const scripted = scriptedFace()
    scripted.face.settings.describe.mockResolvedValue(remoteOk({ writable: true, hasDocument: false, namespaces: [] }))
    await mountFace(scripted)
    expect(screen.queryByRole('button', { name: en.add })).toBeNull()
  })

  it('offers only providers whose settings namespace can open an editor', async () => {
    const scripted = scriptedFace()
    scripted.face.settings.describe.mockResolvedValue(remoteOk({
      writable: true, hasDocument: false,
      namespaces: wireNamespaces().filter(view => view.ns !== 'llm-pi-ai'),
    }))
    await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    // Without the pi-ai namespace nothing can be hand-declared, so the card
    // is the catalog form alone: no mode switch, no custom panel.
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('textbox', { name: en.customRoute })).toBeNull()
    expect(screen.queryByRole('option', { name: 'anthropic' })).toBeNull()
    expect(screen.getByRole('option', { name: 'plain' })).toBeTruthy()
  })

  it('shows a catalog diagnostic while keeping the provider editable', async () => {
    const scripted = scriptedFace()
    const failure = 'llm-pi-ai: provider "openai" model "111" needs an api'
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], error: failure },
    ]))
    await mountFace(scripted)
    expect(screen.getByRole('alert').textContent).toBe(failure)
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.editProvider) }))
    expect(await screen.findByRole('button', { name: en.keyReplace })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.add })).toBeTruthy()
  })

  it('renders nothing before the slot injects its dependencies', () => {
    const uninjected = {} as ModelsSectionProps
    render(<ModelsSection {...uninjected} />)
    expect(document.body.textContent).toBe('')
  })

  it('shows a configuration diagnostic inside the first-run setup card', async () => {
    const scripted = scriptedFace()
    const failure = 'The provider configuration needs repair'
    scripted.face.llm.listProviders.mockResolvedValue(remoteOk([
      { id: 'deepseek-official', name: 'DeepSeek' },
    ]))
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], error: failure },
    ]))
    scripted.face.credentials.describe.mockResolvedValue(remoteOk({
      DEEPSEEK_API_KEY: { configured: false, writable: true },
    }))
    await mountFace(scripted)

    const card = screen.getByRole('listitem')
    expect(within(card).getByRole('alert').textContent).toBe(failure)
    expect(within(card).getByLabelText(en.keyInput)).toBeTruthy()
    expect(within(card).queryByRole('button', { name: deepSeekCopy(en.editProvider) })).toBeNull()
  })

  it('dispatches the provider-card seat per rendered row, keyed by the namespace of the adapter that serves it', async () => {
    const { renderSlot } = await mountFace(await withProviderRows())
    const cards = cardSeatCalls(renderSlot)
    expect(cards).toContainEqual(['openai', true, true, 'llm-pi-ai'])
    expect(cards).toContainEqual(['deepseek-official', true, false, 'llm-deepseek'])
    // A pi-ai provider row is a namespace of its own, and its card goes to the same registrant as a dict route's.
    expect(cards).toContainEqual(['team-gateway', true, false, 'llm-pi-ai'])
    // The footer seat renders once below the rows and the add controls.
    expect(renderSlot.mock.calls.filter(call => call[0] === 'settings.models.footer')).toEqual([
      ['settings.models.footer', {}],
    ])
  })

  it('dispatches the provider-card seat inside the first-run setup card', async () => {
    const { renderSlot } = await mountFirstRun()
    expect(cardSeatCalls(renderSlot)).toContainEqual(['deepseek-official', true, false, 'llm-deepseek'])
  })

  it('dispatches the provider-card seat on the add-provider draft with its dormant row', async () => {
    const { renderSlot } = await mountSection()
    renderSlot.mockClear()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(cardSeatCalls(renderSlot)).toContainEqual(['anthropic', false, false, 'llm-pi-ai'])
  })

  it('derives the draft seat\'s key fact from the page\'s conventional reference', async () => {
    const scripted = scriptedFace()
    scripted.face.credentials.describe.mockImplementation((refs: string[]) => Promise.resolve(remoteOk(
      Object.fromEntries(refs.map(ref => [ref, {
        configured: ref === 'OPENAI_API_KEY' || ref === 'ANTHROPIC_API_KEY',
        writable: true,
      }])),
    )))
    const { renderSlot } = await mountFace(scripted)
    renderSlot.mockClear()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    // The dormant row names no reference yet; the seat still reports the
    // derived ANTHROPIC_API_KEY the editor itself displays as configured.
    expect(cardSeatCalls(renderSlot)).toContainEqual(['anthropic', false, true, 'llm-pi-ai'])
  })

  it('skips the draft seat when a refresh drops the dormant row', async () => {
    const { renderSlot, face, controller } = await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    const directory = [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
    ].map(({ active: _active, ...entry }) => entry)
    const answer = Promise.withResolvers<ReturnType<typeof remoteOk<typeof directory>>>()
    face.llm.listConfigurableProviders.mockImplementation(() => answer.promise)
    // The refresh first renders its loading frame over the previous directory, which still has the row.
    let refresh: Promise<void> | undefined
    await act(async () => { refresh = controller.load() })
    renderSlot.mockClear()
    await act(async () => {
      answer.resolve(remoteOk(directory))
      await refresh
    })
    // The draft card is still open while its row is gone from the directory.
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    expect(cardSeatCalls(renderSlot).some(([provider]) => provider === 'anthropic')).toBe(false)
  })
  it('renders the unkeyed whole-section provider as an open setup card in the first-run posture', async () => {
    await mountFirstRun()
    // Nothing is reachable yet, and DeepSeek has no configured credential and
    // no stored apiKey → setup card.
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    expect(screen.getByText('openai')).toBeTruthy()
    expect(screen.queryByText('Active')).toBeNull()
    expect(screen.queryByText('Inactive')).toBeNull()
    expect(screen.getByText(en.add)).toBeTruthy()
  })

  it('leaves the unkeyed provider a plain row once another provider is usable', async () => {
    await mountSection()
    // openai's key is stored, so the user is not blocked and nothing on the
    // page opens itself over them.
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    const configured = screen.getByRole('img', { name: en.credentialConfigured })
    expect(configured.getAttribute('title')).toBe(en.credentialConfigured)
    expect(configured.className).toContain('credentialDotConfigured')
    expect(configured.closest('li')?.textContent).toContain('openai')
    // A missing key is worded beside its dot; the dot alone carries no name.
    const missing = screen.getByText(en.credentialMissing)
    expect(missing.closest('li')?.textContent).toContain('DeepSeek')
    expect(missing.querySelector('[aria-hidden="true"]')?.className).toContain('credentialDotMissing')
    expect(screen.queryByRole('img', { name: en.credentialMissing })).toBeNull()
    // The card is still one click away.
    fireEvent.click(screen.getByRole('button', { name: deepSeekCopy(en.editProvider) }))
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
  })

  it('marks only a confirmed missing reference and leaves native or unavailable state unmarked', async () => {
    const { face } = scriptedFace()
    face.credentials.describe.mockImplementation((refs: string[]) => Promise.resolve(remoteOk(
      Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
    )))
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)

    const missing = screen.getByText(en.credentialMissing)
    expect(missing.querySelector('[aria-hidden="true"]')?.className).toContain('credentialDotMissing')
    expect(missing.closest('li')?.textContent).toContain('openai')
    expect(screen.queryByRole('img', { name: en.credentialConfigured })).toBeNull()
    const unmarked = screen.getByText('zombie').closest('li')
    expect(unmarked?.querySelector('[role="img"]')).toBeNull()
    expect(unmarked?.textContent).not.toContain(en.credentialMissing)
  })

  it('turns the setup card into a row once the credential reports configured', async () => {
    const { face } = await mountFirstRun()
    face.credentials.describe.mockImplementation((refs: string[]) => Promise.resolve(remoteOk(
      Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    )))
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    await controller.load()
    cleanup()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    // Now a row with an Edit button, not an open card.
    expect(screen.getAllByText(en.edit).length).toBeGreaterThan(1)
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  })

  it('decides setup need from the joined credential state and the first-run posture', () => {
    const entry = { provider: 'p', displayName: 'p', settingsNs: 'llm-deepseek', settingsPath: [], active: true }
    const row = (credential: ProviderRow['credential']): ProviderRow => ({
      entry,
      configured: true,
      removable: false,
      adapterNs: 'llm-deepseek',
      apiKeyEnv: 'X',
      credential,
    })
    expect(needsSetup(row(undefined), false)).toBe(true)
    expect(needsSetup(row({ configured: true, writable: true }), false)).toBe(false)
    const nested = { ...row(undefined), entry: { ...entry, settingsPath: ['providers', 'x'] } }
    expect(needsSetup(nested, false)).toBe(false)
    // A pi-ai provider row is one that a composition layer added, so it waits for its key as an ordinary row.
    const providerRow = { ...row(undefined), entry: { ...entry, settingsNs: 'hub-team' }, adapterNs: 'llm-pi-ai' }
    expect(needsSetup(providerRow, false)).toBe(false)
    // A user who can already reach some provider is not in the first-run
    // posture, so nothing on the page opens itself.
    expect(needsSetup(row(undefined), true)).toBe(false)
  })

  it('derives conventional credential references from route ids', () => {
    expect(deriveKeyRef('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(deriveKeyRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
  })

  it('uses one stable provider identity in action copy', () => {
    const target = { provider: 'deepseek-official', displayName: 'DeepSeek' }
    expect(providerTargetLabel(target)).toBe('DeepSeek (deepseek-official)')
    expect(providerCopy(en.deleteTitle, target)).toBe('Delete DeepSeek (deepseek-official)?')
    expect(providerTargetLabel(OPENAI_TARGET)).toBe('openai')
  })

  it('names only changed fields instead of rebuilding the section', () => {
    expect(pathOps(['providers', 'openai'], { baseURL: 'https://old', reasoning: 'high' }, { reasoning: 'high' }))
      .toEqual([{ op: 'unset', path: ['providers', 'openai', 'baseURL'] }])
    expect(pathOps([], { b: 1 }, { b: 2, d: 3 }))
      .toEqual([{ op: 'set', path: ['b'], value: 2 }, { op: 'set', path: ['d'], value: 3 }])
    expect(pathOps([], undefined, {})).toEqual([])
    expect(pathOps([], { a: 1 }, { a: 1 })).toEqual([])
    expect(pathOps([], { p: { m: 'x', n: 1 } }, { p: { m: 'y' } }))
      .toEqual([{ op: 'set', path: ['p', 'm'], value: 'y' }, { op: 'unset', path: ['p', 'n'] }])
    expect(pathOps([], {}, { p: { m: 'x' } })).toEqual([{ op: 'set', path: ['p', 'm'], value: 'x' }])
    expect(pathOps([], { p: 'x' }, { p: { m: 'x' } })).toEqual([{ op: 'set', path: ['p'], value: { m: 'x' } }])
  })

  it('stores a typed key write-only from the setup card without touching settings', async () => {
    const { set, mutate, face } = await mountFirstRun()
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: '  sk-live  ' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-live') })
    expect(mutate).not.toHaveBeenCalled()
    // The saved key re-loads the join; the settings answer rides the shared
    // mirror, so the reload shows as a directory read rather than a describe.
    await waitFor(() => { expect(face.llm.listProviders.mock.calls.length).toBeGreaterThan(1) })
    expect((await screen.findByRole('status')).textContent).toBe(
      providerCopy(en.savedProvider, { provider: 'deepseek-official', displayName: 'DeepSeek' }),
    )
    fireEvent.click(screen.getByText(en.add))
    expect(screen.queryByText(providerCopy(en.savedProvider, { provider: 'deepseek-official', displayName: 'DeepSeek' }))).toBeNull()
  })

  it('reuses the provider editor as a required credential-only onboarding form', async () => {
    let finishSet: ((response: { ok: true; value: undefined }) => void) | undefined
    const set = vi.fn(() => new Promise<{ ok: true; value: undefined }>((resolve) => {
      finishSet = resolve
    }))
    const { face, mutate } = scriptedFace({ set })
    const onClose = vi.fn()
    const onSubmitCredential = vi.fn()
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')

    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      hideTitle
      namespace={wireNamespaces()[0]!}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      credentialOnly
      credentialRequired
      autoFocusCredential
      cancelLabelKey="onboardingLater"
      submitLabelKey="onboardingSave"
      submitBusyLabelKey="onboardingSaving"
      onClose={onClose}
      onSubmitCredential={onSubmitCredential}
    />)

    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    const save = screen.getByText<HTMLButtonElement>(en.onboardingSave)
    expect(document.activeElement).toBe(key)
    expect(key.required).toBe(true)
    expect(save.disabled).toBe(true)
    expect(screen.getByText(en.onboardingLater)).toBeTruthy()
    expect(screen.queryByText(en.customized)).toBeNull()
    expect(screen.queryByText(en.models)).toBeNull()
    expect(screen.queryByLabelText(en.baseUrl)).toBeNull()
    // A form this short never scrolls its actions out of view, so its footer does not stick.
    expect(editorFooter(en.onboardingSave).className).not.toContain('editorFooterSticky')

    fireEvent.change(key, { target: { value: '   ' } })
    expect(screen.getByText(en.keyRequired)).toBeTruthy()
    expect(key.getAttribute('aria-invalid')).toBe('true')
    expect(save.disabled).toBe(true)

    // An ill-formed key leaves Save available; pressing it stores nothing and
    // returns the keyboard to the field.
    fireEvent.change(key, { target: { value: 'DEEPSEEK_API_KEY=sk-onboarding' } })
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(key.getAttribute('aria-invalid')).toBe('true')
    expect(save.disabled).toBe(false)
    save.focus()
    fireEvent.click(save)
    expect(document.activeElement).toBe(key)
    expect(onSubmitCredential).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()

    fireEvent.change(key, { target: { value: '  sk-onboarding  ' } })
    expect(screen.queryByText(en.keyRequired)).toBeNull()
    expect(screen.queryByText(en.keyIllegalCharacters)).toBeNull()
    expect(key.getAttribute('aria-invalid')).toBe('false')
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    expect(onSubmitCredential).toHaveBeenCalledOnce()
    expect(await screen.findByText(en.onboardingSaving)).toBeTruthy()
    expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-onboarding')
    expect(mutate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    if (finishSet === undefined) throw new Error('credential write did not start')
    await act(async () => {
      finishSet?.(remoteOk(undefined))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('applies customized deepseek fields as path ops', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    // The deepseek placeholder is pinned to the public endpoint, not the
    // effective value (which may reflect a launch-environment override).
    expect(baseURL.placeholder).toBe('https://api.deepseek.com/anthropic (Default to use DEEPSEEK_BASE_URL)')
    fireEvent.change(baseURL, { target: { value: 'https://next2' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // Only the field that actually changed: reasoningEffort was already
    // 'high' in the loaded profile, so it produces no op.
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{ op: 'set', path: ['baseURL'], value: 'https://next2' }],
      0,
    ])
  })

  it('materializes inherited models and adds an arbitrary DeepSeek id', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    // An inherited list carries no state text and nothing to restore, and its
    // rows read as text until one is unfolded.
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
    expect(screen.queryByText(en.resetModels)).toBeNull()
    expect(foldedModelIds()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(screen.queryByLabelText(new RegExp(en.modelId))).toBeNull()

    fireEvent.click(screen.getByText(en.addModel))
    // The row without an ID joins unfolded, since only its fields can name it;
    // the named rows stay folded.
    expect(rowToggle(3).getAttribute('aria-expanded')).toBe('true')
    expect(foldedModelIds()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(screen.getByText(en.modelsCustomized)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(`${en.modelId} 3`), { target: { value: 'private-preview' } })
    fireEvent.change(screen.getByLabelText(`${en.modelName} 3`), { target: { value: 'Private Preview' } })
    // Only row 3 is open, so its capacity is addressed by its own label.
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 3`), { target: { value: '131072' } })
    fireEvent.click(within(screen.getByRole('group', { name: `${en.modelInputTypes} 3` })).getByRole('checkbox', { name: en.modelInputImage }))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [
          ...DEFAULT_DEEPSEEK_MODELS,
          { id: 'private-preview', name: 'Private Preview', contextWindow: 131_072, inputModalities: ['text', 'image'] },
        ],
      }],
      0,
    ])
  })

  it('edits the DeepSeek endpoint and credential without a protocol selection', async () => {
    const namespace: SettingsNamespaceView = {
      ...wireNamespaces()[0]!,
      ns: 'llm-deepseek',
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: DEFAULT_DEEPSEEK_MODELS },
      user: {},
    }
    const { face, mutate, set } = scriptedFace({
      mutate: vi.fn(() => Promise.resolve(remoteOk(namespace))),
    })
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={namespace}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).placeholder)
      .toBe('https://api.deepseek.com/anthropic (Default to use DEEPSEEK_BASE_URL)')
    expect(screen.queryByLabelText(en.customApi)).toBeNull()
    expect(screen.getByText(en.deepSeekEndpointHint)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-messages-test' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://messages.example/anthropic' } })
    expandRow(1)
    fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: 'Messages Flash' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-messages-test') })
    expect(mutate.mock.calls).toEqual([[
      'llm-deepseek',
      [
        { op: 'set', path: ['baseURL'], value: 'https://messages.example/anthropic' },
        { op: 'set', path: ['models'], value: [
          { ...DEFAULT_DEEPSEEK_MODELS[0], name: 'Messages Flash' },
          DEFAULT_DEEPSEEK_MODELS[1],
        ] },
      ],
      0,
    ]])
  })

  it('rejects duplicate DeepSeek model ids before writing', async () => {
    const { mutate } = await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.addModel))
    const id = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 3`)
    fireEvent.change(id, { target: { value: 'deepseek-v4-flash' } })
    // Nothing is marked while the row is typed, and Apply stays available.
    expect(refusalOf(id)).toBeNull()
    expect(screen.queryByText(en.modelIdDuplicate)).toBeNull()
    expect(screen.getByText<HTMLButtonElement>(en.apply).disabled).toBe(false)

    fireEvent.click(screen.getByText(en.apply))
    // The refused field says why under its own input and takes the keyboard;
    // the footer that stays in view names no row.
    expect(refusalOf(id)).toBe(en.modelIdDuplicate)
    expect(id.closest('[data-row-key]')?.hasAttribute('data-invalid')).toBe(true)
    expect(document.activeElement).toBe(id)
    expect(editorNotes()).toBe('')
    expect(editorFooter().className).toContain('editorFooterSticky')
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.change(id, { target: { value: 'deepseek-v4-max' } })
    expect(refusalOf(id)).toBeNull()
    expect(screen.queryByText(en.modelIdDuplicate)).toBeNull()
    expect(id.closest('[data-row-key]')?.hasAttribute('data-invalid')).toBe(false)
  })

  it('marks every refused model field on its own row, unfolds what hides them, and writes once each is fixed', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    const field = (label: string, position: number) => screen.getByLabelText<HTMLInputElement>(`${label} ${String(position)}`)
    const marked = () => [...document.querySelectorAll('[data-row-key]')].map(row => row.hasAttribute('data-invalid'))
    // An output cap nobody can read on a row that is folded again, a row with
    // no ID, and a row repeating the first row's ID, all under a folded list.
    expandRow(2)
    fireEvent.change(field(en.maxTokens, 2), { target: { value: 'plenty' } })
    fireEvent.click(rowToggle(2))
    fireEvent.click(screen.getByText(en.addModel))
    fireEvent.click(screen.getByText(en.addModel))
    fireEvent.change(field(en.modelId, 4), { target: { value: 'deepseek-v4-flash' } })
    fireEvent.click(screen.getByRole('button', { name: en.models }))
    expect(marked()).toEqual([false, false, false, false])

    fireEvent.click(screen.getByText(en.apply))
    expect(mutate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en.models }).getAttribute('aria-expanded')).toBe('true')
    // A row that passes stays folded and unmarked.
    expect(rowToggle(1).getAttribute('aria-expanded')).toBe('false')
    expect(marked()).toEqual([false, true, true, true])
    expect(refusalOf(field(en.maxTokens, 2))).toBe(en.modelMaxTokensInvalid)
    expect(refusalOf(field(en.contextWindow, 2))).toBeNull()
    expect(refusalOf(field(en.modelId, 3))).toBe(en.modelIdRequired)
    expect(refusalOf(field(en.modelId, 4))).toBe(en.modelIdDuplicate)
    expect(document.activeElement).toBe(field(en.maxTokens, 2))

    // Each mark leaves with its own fault.
    fireEvent.change(field(en.maxTokens, 2), { target: { value: '64K' } })
    expect(marked()).toEqual([false, false, true, true])
    fireEvent.change(field(en.modelId, 3), { target: { value: 'private-preview' } })
    expect(marked()).toEqual([false, false, false, true])
    expect(refusalOf(field(en.modelId, 4))).toBe(en.modelIdDuplicate)
    fireEvent.change(field(en.modelId, 4), { target: { value: 'private-preview-2' } })
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull()

    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [
          DEFAULT_DEEPSEEK_MODELS[0],
          { ...DEFAULT_DEEPSEEK_MODELS[1], maxTokens: 64_000 },
          { id: 'private-preview' },
          { id: 'private-preview-2' },
        ],
      }],
      0,
    ])
  })

  it('validates every adapter-owned model catalog invariant', () => {
    expect(modelDrafts(undefined)).toEqual([])
    expect(modelDrafts([null, 'bad', { id: 'ok' }])).toEqual([{}, {}, { id: 'ok' }])
    expect(validateDeepSeekModels([{}])).toEqual({ index: 0, key: 'modelIdRequired' })
    expect(validateDeepSeekModels([{ id: 'same' }, { id: 'same' }]))
      .toEqual({ index: 1, key: 'modelIdDuplicate' })
    expect(validateDeepSeekModels([{ id: 'model', name: '' }]))
      .toEqual({ index: 0, key: 'modelNameInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: null }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 1.5 }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 0 }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 1 }])).toBeUndefined()
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: null }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 1.5 }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 0 }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 8192 }])).toBeUndefined()
  })

  it('reports every failing field of every row, and the first of them as the catalog failure', () => {
    const models = [
      { id: 'model', name: '', maxTokens: 0 },
      { id: 'fine', contextWindow: 131_072 },
      { id: ' model ', contextWindow: 1.5, maxTokens: null },
      {},
    ]
    expect(modelRowFailures(models).map(row => [...row])).toEqual([
      [['name', 'modelNameInvalid'], ['maxTokens', 'modelMaxTokensInvalid']],
      [],
      [['id', 'modelIdDuplicate'], ['contextWindow', 'modelContextInvalid'], ['maxTokens', 'modelMaxTokensInvalid']],
      [['id', 'modelIdRequired']],
    ])
    expect(validateDeepSeekModels(models)).toEqual({ index: 0, key: 'modelNameInvalid' })
    // A value that is not a list has no rows to refuse.
    expect(modelRowFailures(undefined)).toEqual([])
    expect(modelRowFailures('models')).toEqual([])
  })

  it('reads context windows written as counts, thousands, or millions', () => {
    expect(parseCapacity('')).toBeUndefined()
    expect(parseCapacity('   ')).toBeUndefined()
    expect(parseCapacity('131072')).toBe(131_072)
    expect(parseCapacity(' 256K ')).toBe(256_000)
    expect(parseCapacity('256k')).toBe(256_000)
    expect(parseCapacity('1M')).toBe(1_000_000)
    expect(parseCapacity('1m')).toBe(1_000_000)
    // 1M is 1000K, not 1024K: capacities are quoted in decimal.
    expect(parseCapacity('1M')).toBe(parseCapacity('1000K'))
    // 2.3 * 1e6 is a few ULPs high in binary floating point; an integral
    // intent must not become a fractional count the validator rejects.
    expect(parseCapacity('2.3M')).toBe(2_300_000)
    expect(Number.isInteger(parseCapacity('1.5M'))).toBe(true)
    // A genuinely fractional count survives as one, for the validator to reject.
    expect(parseCapacity('0.0001K')).toBeCloseTo(0.1)
    expect(parseCapacity('abc')).toBeNaN()
    expect(parseCapacity('1G')).toBeNaN()
    expect(parseCapacity('1M1')).toBeNaN()
  })

  it('spells a stored count in the shortest form that round-trips', () => {
    expect(formatCapacity(1_000_000)).toBe('1M')
    expect(formatCapacity(256_000)).toBe('256K')
    expect(formatCapacity(1_500_000)).toBe('1500K')
    expect(formatCapacity(131_072)).toBe('131072')
    // Values the validator will reject are shown as-is rather than dressed up.
    expect(formatCapacity(Number.NaN)).toBe('NaN')
    expect(formatCapacity(0)).toBe('0')
    for (const text of ['1M', '256K', '131072', '1500K']) {
      expect(formatCapacity(parseCapacity(text) as number)).toBe(text)
    }
  })

  it('accepts a suffixed context window and stores the plain count', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    expandRow(1)
    expandRow(2)
    const windows = capacityInputs(en.contextWindow)
    // The inherited 1000000 reads back short.
    expect((windows[0] as HTMLInputElement).value).toBe('1M')

    // Keystrokes stay verbatim while the row has focus, so typing `1000` does
    // not rewrite itself to `1K` mid-word.
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '1000' } })
    expect((windows[0] as HTMLInputElement).value).toBe('1000')
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '1000K' } })
    expect((windows[0] as HTMLInputElement).value).toBe('1000K')
    // Blur settles the row to the canonical spelling of the same count.
    fireEvent.blur(windows[0] as HTMLInputElement)
    expect((windows[0] as HTMLInputElement).value).toBe('1M')

    fireEvent.change(windows[1] as HTMLInputElement, { target: { value: '256K' } })
    fireEvent.blur(windows[1] as HTMLInputElement)
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [
          { ...DEFAULT_DEEPSEEK_MODELS[0], contextWindow: 1_000_000 },
          { ...DEFAULT_DEEPSEEK_MODELS[1], contextWindow: 256_000 },
        ],
      }],
      0,
    ])
  })

  it('keeps unreadable context-window text on screen and refuses the write', async () => {
    const { mutate } = await mountDeepSeekCard()
    expandRow(1)
    expandRow(2)
    const windows = capacityInputs(en.contextWindow)
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '1 gazillion' } })
    // Blurring a row that is not the edited one leaves the buffer alone.
    fireEvent.blur(windows[1] as HTMLInputElement)
    fireEvent.blur(windows[0] as HTMLInputElement)
    // The text the user typed is still there to correct.
    expect((windows[0] as HTMLInputElement).value).toBe('1 gazillion')

    fireEvent.click(screen.getByText(en.apply))
    expect(mutate).not.toHaveBeenCalled()
    // The reason sits under the text it refuses, which takes the keyboard.
    expect(refusalOf(windows[0] as HTMLInputElement)).toBe(en.modelContextInvalid)
    expect(refusalOf(windows[1] as HTMLInputElement)).toBeNull()
    expect(document.activeElement).toBe(windows[0])
    expect((windows[0] as HTMLInputElement).value).toBe('1 gazillion')
    expect(editorNotes()).toBe('')

    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '512K' } })
    expect(refusalOf(windows[0] as HTMLInputElement)).toBeNull()
    expect(screen.queryByText(en.modelContextInvalid)).toBeNull()
  })

  it.each([
    ['the schema default', undefined],
    ['the composition entry', { models: [{ id: 'pinned-by-deployment' }] }],
  ])('restores %s the moment the override is dropped, not after a reload', async (_label, base) => {
    // The regression: reset read the EFFECTIVE value, which still carries the
    // stored override until the unset is applied — so the rows did not change
    // and the catalog only looked restored after reopening the card.
    const { face } = scriptedFace()
    const stored = { models: [{ id: 'user-only-model', name: 'User Only' }] }
    const overridden: SettingsNamespaceView = {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: { ...stored, defaultContextWindow: 1_000_000 },
      ...base === undefined ? {} : { base },
      user: stored,
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    }
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={overridden}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={() => {}}
    />)
    expect(screen.getByText(en.modelsCustomized)).toBeTruthy()
    expect(foldedModelIds()).toEqual(['user-only-model'])

    fireEvent.click(screen.getByText(en.resetModels))

    // An inherited list has no state to name and nothing to restore.
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
    expect(screen.queryByText(en.resetModels)).toBeNull()
    expect(foldedModelIds())
      .toEqual(base === undefined ? ['deepseek-v4-flash', 'deepseek-v4-pro'] : ['pinned-by-deployment'])
  })

  it('keeps every row\'s unreadable text, not just the last one edited', async () => {
    // The regression: one active buffer meant editing a second row displaced
    // the first, which then fell back to rendering its stored NaN as `NaN` —
    // losing the text the user was told they could still correct.
    await mountDeepSeekCard()
    expandRow(1)
    expandRow(2)
    const windows = capacityInputs(en.contextWindow)
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: 'not a number' } })
    fireEvent.blur(windows[0] as HTMLInputElement)
    fireEvent.change(windows[1] as HTMLInputElement, { target: { value: '2M' } })

    expect((windows[0] as HTMLInputElement).value).toBe('not a number')
    expect((windows[1] as HTMLInputElement).value).toBe('2M')
  })

  it('re-keys the typed text around a removed row', async () => {
    await mountDeepSeekCard()
    const windows = (): HTMLInputElement[] => capacityInputs(en.contextWindow)
    const removeRow = (at: number): void => {
      fireEvent.click(screen.getAllByLabelText(new RegExp(en.removeModel))[at] as HTMLElement)
    }
    // Three rows, with text parked on the outer two. The added row has no ID
    // yet and is already unfolded.
    fireEvent.click(screen.getByText(en.addModel))
    expandRow(1)
    expandRow(2)
    expect(rowToggle(3).getAttribute('aria-expanded')).toBe('true')
    fireEvent.change(windows()[0] as HTMLInputElement, { target: { value: 'top text' } })
    fireEvent.blur(windows()[0] as HTMLInputElement)
    fireEvent.change(windows()[2] as HTMLInputElement, { target: { value: 'bottom text' } })
    fireEvent.blur(windows()[2] as HTMLInputElement)

    // Dropping the middle row leaves the row above untouched and carries the
    // row below down with its own text, rather than stranding it.
    removeRow(1)
    expect(windows()).toHaveLength(2)
    expect((windows()[0] as HTMLInputElement).value).toBe('top text')
    expect((windows()[1] as HTMLInputElement).value).toBe('bottom text')

    // Dropping a row that holds text takes that text with it; the survivor
    // keeps its own rather than inheriting the deleted row's.
    removeRow(0)
    expect(windows()).toHaveLength(1)
    expect((windows()[0] as HTMLInputElement).value).toBe('bottom text')
  })

  it('drops the typed text when reset replaces the rows it annotated', async () => {
    // The regression: reset removed the override but left the buffer, so an
    // inherited row displayed text no settings layer stores — and because an
    // unreadable buffer never settles, it stayed there indefinitely.
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    expandRow(1)
    const windows = capacityInputs(en.contextWindow)
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: 'garbage' } })
    fireEvent.blur(windows[0] as HTMLInputElement)
    fireEvent.click(screen.getByText(en.resetModels))

    // Reset collapses every row, so the restored capacity needs opening again.
    expandRow(1)
    const restored = capacityInputs(en.contextWindow)
    expect((restored[0] as HTMLInputElement).value).toBe('1M')

    // Reset put the draft back where it started, so Apply writes nothing at
    // all rather than persisting whatever the stale text had parsed to.
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(screen.queryByText(en.apply)).toBeNull() })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('edits an output cap per model and carries its text across a removal', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    expandRow(1)
    expandRow(2)
    // The profile's own cap is the placeholder both rows inherit.
    expect(capacityInputs(en.maxTokens).map(input => input.placeholder)).toEqual(['256K', '256K'])

    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 2`), { target: { value: '64K' } })
    fireEvent.blur(screen.getByLabelText(`${en.maxTokens} 2`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 2`).value).toBe('64K')

    // Dropping the row above carries the cap text down with its own row.
    fireEvent.click(screen.getAllByLabelText(new RegExp(en.removeModel))[0] as HTMLElement)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).value).toBe('64K')
    // A second press folds the row back to its text.
    fireEvent.click(rowToggle(1))
    expect(screen.queryByLabelText(`${en.maxTokens} 1`)).toBeNull()
    expect(foldedModelIds()).toEqual(['deepseek-v4-pro'])

    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [{ ...DEFAULT_DEEPSEEK_MODELS[1], maxTokens: 64_000 }],
      }],
      0,
    ])
  })

  it('settles a pasted id and refuses whitespace that would never match', async () => {
    await mountDeepSeekCard()
    expandRow(1)
    const id = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`)
    fireEvent.change(id, { target: { value: '  deepseek-v4-flash  ' } })
    fireEvent.blur(id)
    expect(id.value).toBe('deepseek-v4-flash')
    // A settled id needs no second trim.
    fireEvent.blur(id)
    expect(id.value).toBe('deepseek-v4-flash')

    // An id that is only whitespace is as absent as an empty one, and a padded
    // id is a duplicate of its trimmed twin.
    expect(validateDeepSeekModels([{ id: '   ' }])).toEqual({ index: 0, key: 'modelIdRequired' })
    expect(validateDeepSeekModels([{ id: 'model' }, { id: 'model ' }]))
      .toEqual({ index: 1, key: 'modelIdDuplicate' })
  })

  it('renders malformed draft fallbacks without inventing catalog values', () => {
    render(<DeepSeekModelsEditor
      models={[{}]}
      overridden={false}
      defaultContextWindow={undefined}
      defaultMaxTokens={undefined}
      t={t}
      disabled={true}
      attempt={0}
      onChange={vi.fn()}
      onReset={vi.fn()}
    />)
    // A folded row without an ID reads as the field's own name, marked as a
    // stand-in; pressing the text unfolds the row as its button does.
    const unnamed = screen.getByText(en.modelId)
    expect(unnamed.hasAttribute('data-unnamed')).toBe(true)
    fireEvent.click(unnamed)
    expect(rowToggle(1).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).placeholder)
      .toBe(en.contextWindowPlaceholder)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).placeholder)
      .toBe(en.maxTokensPlaceholder)
  })

  it('can empty and reset the model override, then clear optional fields without dropping hidden data', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getAllByLabelText(new RegExp(en.removeModel))[0] as HTMLElement)
    fireEvent.click(screen.getByLabelText(new RegExp(en.removeModel)))
    expect(screen.getByText(en.modelsEmpty)).toBeTruthy()
    expect(screen.getByText(en.modelsCustomized)).toBeTruthy()
    fireEvent.click(screen.getByText(en.resetModels))
    expect(screen.queryByText(en.modelsEmpty)).toBeNull()
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
    expect(foldedModelIds()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])

    expandRow(1)
    const names = screen.getAllByLabelText(new RegExp(en.modelName))
    const windows = capacityInputs(en.contextWindow)
    fireEvent.change(names[0] as HTMLInputElement, { target: { value: '' } })
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [
          { id: 'deepseek-v4-flash', description: 'Preserved hidden detail' },
          DEFAULT_DEEPSEEK_MODELS[1],
        ],
      }],
      0,
    ])
  })

  it('clears an inherited override with an unset op, never a whole-section replace', async () => {
    // A whole-section replace would clobber sibling overrides to clear one field.
    const { mutate } = await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(url.value).toBe('https://base')
    fireEvent.change(url, { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // This editor clears one field through an unset op so it cannot clobber
    // sibling overrides with a whole-section replacement.
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{ op: 'unset', path: ['baseURL'] }],
      0,
    ])
  })

  it('pins the deepseek placeholder and clears typed input back to inherited', async () => {
    const { face } = scriptedFace()
    const bare: SettingsNamespaceView = {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: {},
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    }
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={bare}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={() => {}}
    />)
    fireEvent.click(screen.getByText(en.customized))
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(baseURL.placeholder).toBe('https://api.deepseek.com/anthropic (Default to use DEEPSEEK_BASE_URL)')
    fireEvent.change(baseURL, { target: { value: 'https://x' } })
    expect(baseURL.value).toBe('https://x')
    fireEvent.change(baseURL, { target: { value: '' } })
    expect(baseURL.value).toBe('')
  })

  it('saves credentials without changing the default model', async () => {
    const { ctx, set } = await mountDeepSeekCard()
    const initialize = vi.spyOn(ctx.remote.session, 'initializeDefaultModel')
    fireEvent.change(await screen.findByLabelText(en.keyInput), { target: { value: 'test-key' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(screen.queryByText(en.apply)).toBeNull() })
    expect(set).toHaveBeenCalledOnce()
    expect(initialize).not.toHaveBeenCalled()
  })

  it('reveals only the current key draft and masks it again on change', async () => {
    const { set } = await mountDeepSeekCard()
    const input = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(screen.queryByRole('button', { name: en.keyReveal })).toBeNull()
    fireEvent.change(input, { target: { value: 'test-key' } })
    const reveal = screen.getByRole('button', { name: en.keyReveal })
    expect(reveal.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(reveal)
    expect(input.type).toBe('text')
    const hide = screen.getByRole('button', { name: en.keyHide })
    expect(hide.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(hide)
    expect(input.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: en.keyReveal }))
    fireEvent.change(input, { target: { value: '' } })
    expect(input.type).toBe('password')
    expect(screen.queryByRole('button', { name: en.keyReveal })).toBeNull()
    fireEvent.change(input, { target: { value: 'test-key' } })
    expect(input.type).toBe('password')
    expect(set).not.toHaveBeenCalled()
  })

  it('rejects an invalid draft before writing', async () => {
    const { mutate } = await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/baseURL/)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('edits a pi-ai profile with the curated fields only', async () => {
    const { mutate } = await mountSection()
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.editProvider) }))
    // The saved key shows only its preview; no input holds a stored value.
    expect(await screen.findByText('••••••••')).toBeTruthy()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    // pi-ai carries Base URL too: the stored override shows as the value and
    // the effective profile endpoint, ahead of the catalog's, as its placeholder.
    fireEvent.click(screen.getByText(en.customized))
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(url.value).toBe('https://proxy')
    expect(url.placeholder).toBe('https://proxy')
    fireEvent.change(url, { target: { value: 'https://proxy/v2' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // Only the edited field travels: apiKeyEnv and headers were already stored
    // with these values, so no op restates them.
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'openai', 'baseURL'], value: 'https://proxy/v2' }],
      0,
    ])
  })

  it('adds a dormant provider with a derived reference and stores its key', async () => {
    const { mutate, set } = await mountSection()
    fireEvent.click(screen.getByText(en.add))
    const pick = await screen.findByLabelText<HTMLSelectElement>(en.provider)
    expect([...pick.options].map(option => option.value)).toEqual(['anthropic', 'broken', 'plain'])
    expect(pick.value).toBe('anthropic')
    // A dormant route shows its catalog endpoint and the first variable its
    // provider reads; a typed key still stores under the derived reference.
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).placeholder).toBe('https://api.anthropic.com')
    const addKey = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(addKey.placeholder).toBe(en.keyPlaceholderFallback.replace('{hint}', 'ANTHROPIC_AUTH_TOKEN'))
    fireEvent.change(addKey, { target: { value: 'sk-ant' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'anthropic', 'apiKeyEnv'], value: 'ANTHROPIC_API_KEY' }],
      0,
    ])
    await waitFor(() => { expect(set).toHaveBeenCalledWith('ANTHROPIC_API_KEY', 'sk-ant') })
  })

  it('keeps pi-ai provider-native authentication when no key is entered', async () => {
    const { mutate, set } = await mountSection()
    fireEvent.click(screen.getByText(en.add))
    await screen.findByLabelText(en.provider)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'anthropic'], value: {} }],
      0,
    ])
    expect(set).not.toHaveBeenCalled()
  })

  it('retries only the credential after refreshed settings already committed', async () => {
    const committed = wireNamespaces()[2]!
    const afterSettings: SettingsNamespaceView = {
      ...committed,
      value: { providers: {
        ...(committed.value as { providers: object }).providers,
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      } },
      user: { providers: {
        ...(committed.user as { providers: object }).providers,
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      } },
      revision: 1,
    }
    const mutate = vi.fn(() => Promise.resolve(remoteOk(afterSettings)))
    const set = vi.fn()
      .mockResolvedValueOnce(remoteFail('credential store unavailable'))
      .mockResolvedValueOnce(remoteOk(undefined))
    const { face, controller, mirror } = await mountSection({ mutate, set })
    fireEvent.click(screen.getByText(en.add))
    await screen.findByLabelText(en.provider)
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.keyInput), { target: { value: 'sk-ant' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText('credential store unavailable')
    expect(mutate).toHaveBeenCalledOnce()
    face.settings.describe.mockResolvedValue(remoteOk({
      writable: true,
      hasDocument: false,
      namespaces: wireNamespaces().map(namespace => namespace.ns === 'llm-pi-ai' ? afterSettings : namespace),
    }))
    // The refreshed settings answer reaches the page through the mirror's own
    // refresh (the document commit's invalidation in production).
    await act(async () => {
      await mirror.load()
      await controller.load()
    })
    expect(controller.store.getSnapshot().namespaces.get('llm-pi-ai')?.revision).toBe(1)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledTimes(2) })
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).toHaveBeenLastCalledWith('ANTHROPIC_API_KEY', 'sk-ant')
  })

  it('switches the add card target and degrades unknown or broken targets loudly', async () => {
    await mountSection()
    fireEvent.click(screen.getByText(en.add))
    const pick = await screen.findByLabelText<HTMLSelectElement>(en.provider)
    fireEvent.change(pick, { target: { value: 'broken' } })
    await screen.findByText(/unresolvable settings path/)
    fireEvent.change(pick, { target: { value: 'plain' } })
    await waitFor(() => {
      expect(screen.getAllByText(content => content.includes(en.advancedHint)).length).toBeGreaterThan(0)
    })
    // The hint-only card cannot apply anything, and offers no key field.
    expect(screen.getByText<HTMLButtonElement>(en.apply).disabled).toBe(true)
    expect(screen.queryAllByLabelText(en.keyInput)).toHaveLength(0)
  })

  it('surfaces a rejected settings write and never stores the key after it', async () => {
    const { set } = await mountSection({
      mutate: vi.fn(() => Promise.resolve(remoteFail('llm-pi-ai: unknown pi-ai provider "bogus"', 'settings/rejected'))),
    })
    fireEvent.click(screen.getByText(en.add))
    await screen.findByLabelText(en.provider)
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.keyInput), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/unknown pi-ai provider/)
    expect(set).not.toHaveBeenCalled()
  })

  it('renders the card without the stored-key hint when the credential probe is refused', async () => {
    const { face } = scriptedFace()
    face.credentials.describe = vi.fn(() => Promise.resolve(remoteFail('no credential provider')))
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(key.placeholder).toBe(en.keyPlaceholderFallback.replace('{hint}', 'DEEPSEEK_API_KEY'))
  })

  it('tells the user to reopen when another writer moved the namespace first', async () => {
    // The stale-draft overwrite: two tabs open the same card, the other saves,
    // and this one must be refused rather than replay its opening snapshot.
    const { set } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteFail('changed since it was read', 'settings/conflict'))),
    })
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.baseUrl), { target: { value: 'https://mine' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(en.conflict)
    expect(set).not.toHaveBeenCalled()
  })

  it('keeps the card usable after a refused write', async () => {
    await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteFail('the host refused', 'settings/rejected'))),
    })
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.baseUrl), { target: { value: 'https://next' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText('the host refused')
    // Not stuck in `applying…`: the finally cleared busy, so Apply is live again.
    expect(screen.getByText(en.apply)).toBeTruthy()
  })

  it('surfaces a refused credential write on the card', async () => {
    await mountFirstRun({
      set: vi.fn(() => Promise.resolve(remoteFail(
        'credentials-local: invalid document at /home/user/.dsh/.credentials.yaml: BAD_INDENT at line 3, column 1',
      ))),
    })
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/invalid document at \/home\/user\/\.dsh\/\.credentials\.yaml/)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps a failed credential describe silent and the input usable', async () => {
    const { face, set } = await mountSection()
    face.credentials.describe.mockImplementation(() => Promise.resolve(remoteFail('down', 'gateway/internal')))
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.editProvider) }))
    expect(await screen.findByText('••••••••')).toBeTruthy()
    fireEvent.change(replaceSavedKey(), { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledTimes(1) })
  })

  it('requires confirmation before removing a user-added provider', async () => {
    const { mutate, unset } = await mountSection()
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    expect(dialog.textContent).toContain(openaiCopy(en.deleteDescriptionWithCredential))
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: en.cancel }))
    expect(unset).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    fireEvent.click(within(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) }))
      .getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    fireEvent.click(within(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) }))
      .getByRole('button', { name: openaiCopy(en.deleteConfirm) }))
    await waitFor(() => { expect(unset).toHaveBeenCalledWith('OPENAI_API_KEY') })
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(unset.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0] as number)
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'unset', path: ['providers', 'openai'] }],
      undefined,
    ])
  })

  it('blocks duplicate deletion while the confirmed removal is pending', async () => {
    let resolveRemoval!: (response: { ok: true; value: SettingsNamespaceView }) => void
    const mutate = vi.fn(() => new Promise<{ ok: true; value: SettingsNamespaceView }>((resolve) => {
      resolveRemoval = resolve
    }))
    await mountSection({ mutate })
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: openaiCopy(en.deleteConfirm) })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(confirm.disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.cancel }).disabled).toBe(true)
    expect(within(dialog).getByRole('button', { name: openaiCopy(en.deleting) })).toBe(confirm)
    fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
    expect(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBe(dialog)
    expect(mutate).toHaveBeenCalledOnce()
    await act(async () => { resolveRemoval(remoteOk(wireNamespaces()[2]!)) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    })
  })

  it('renders the load failure with a retry control', async () => {
    const face = scriptedFace()
    face.face.llm.listProviders.mockResolvedValue(remoteFail('directory down', 'gateway/internal'))
    const controller = new ModelsSettingsStore(
      ctxWith(face.face), settingsSchema, new SettingsDescribeMirror(ctxWith(face.face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face.face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    expect(screen.getByText(/directory down/)).toBeTruthy()
    fireEvent.click(screen.getByText(en.retry))
    await waitFor(() => { expect(screen.queryByText(/directory down/)).toBeNull() })
  })

  it('shows the read-only notice and disables mutations for a read-only provider', async () => {
    const { face } = await mountSection()
    face.settings.describe.mockImplementation(() => Promise.resolve(remoteOk({
      writable: false,
      hasDocument: false,
      namespaces: wireNamespaces(),
    })))
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    await controller.load()
    cleanup()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getAllByText<HTMLButtonElement>(en.remove).every(button => button.disabled)).toBe(true)
    expect(screen.getByText<HTMLButtonElement>(en.add).disabled).toBe(true)
  })

  it('makes an open row the editing surface under its own name, closed by its own cancel', async () => {
    const { mutate } = await mountSection()
    const row = screen.getByRole('button', { name: deepSeekCopy(en.editProvider) }).closest('li')!
    expect(row.className).not.toContain('rowCardOpen')
    expect(within(row).queryByText('deepseek-official')).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: deepSeekCopy(en.editProvider) }))
    // The row head names the card and the route id its settings are stored
    // under, so the editor adds no title of its own and the row no second Edit.
    expect(row.className).toContain('rowCardOpen')
    expect(within(row).getAllByText('DeepSeek')).toHaveLength(1)
    expect(within(row).getByText('deepseek-official').className).toContain('editorRoute')
    expect(within(row).getByLabelText(en.keyInput)).toBeTruthy()
    expect(within(row).queryByRole('button', { name: deepSeekCopy(en.editProvider) })).toBeNull()

    fireEvent.click(within(row).getByText(en.cancel))
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(row.className).not.toContain('rowCardOpen')
    expect(within(row).queryByText('deepseek-official')).toBeNull()
    expect(within(row).getByRole('button', { name: deepSeekCopy(en.editProvider) })).toBeTruthy()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('names an open row once when its route id is its name, and keeps its remove action', async () => {
    await mountSection()
    const row = screen.getByRole('button', { name: openaiCopy(en.editProvider) }).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: openaiCopy(en.editProvider) }))
    expect(within(row).getByRole('button', { name: en.keyReplace })).toBeTruthy()
    expect(within(row).getAllByText('openai')).toHaveLength(1)
    expect(within(row).queryByRole('button', { name: openaiCopy(en.editProvider) })).toBeNull()
    expect(within(row).getByRole('button', { name: openaiCopy(en.removeProvider) })).toBeTruthy()
  })

  it('folds the model list and the advanced settings without discarding what they hold', async () => {
    await mountDeepSeekCard()
    const models = screen.getByRole('button', { name: en.models })
    const advanced = screen.getByRole('button', { name: en.customized })
    // The list starts in view. The advanced fields start folded: mounted, but
    // out of reach of the pointer, the keyboard and assistive technology.
    expect(models.getAttribute('aria-expanded')).toBe('true')
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(screen.queryByRole('textbox', { name: en.baseUrl })).toBeNull()

    fireEvent.click(advanced)
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toBe(url)
    fireEvent.change(url, { target: { value: 'https://kept.example' } })
    fireEvent.click(advanced)
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox', { name: en.baseUrl })).toBeNull()
    expect(url.value).toBe('https://kept.example')

    // An unfolded row and its typed text stay as they were under a folded list.
    expandRow(1)
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: 'half typed' } })
    fireEvent.click(models)
    expect(models.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox', { name: `${en.contextWindow} 1` })).toBeNull()
    expect(screen.queryByRole('button', { name: en.addModel })).toBeNull()
    fireEvent.click(models)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: `${en.contextWindow} 1` }).value).toBe('half typed')
    expect(screen.getByRole('button', { name: en.addModel })).toBeTruthy()
  })

  it('points a fold heading\'s chevron right while folded and down while unfolded', async () => {
    await mountDeepSeekCard()
    const chevron = (title: string): string | null | undefined =>
      screen.getByRole('button', { name: title }).querySelector('[data-icon]')?.getAttribute('data-icon')
    // The chevron adds nothing to the heading's name, which stays the title.
    expect(chevron(en.models)).toBe('dsw-icon-chevron-down-outline-regular')
    expect(chevron(en.customized)).toBe('dsw-icon-chevron-right-outline-regular')
    fireEvent.click(screen.getByRole('button', { name: en.models }))
    fireEvent.click(screen.getByRole('button', { name: en.customized }))
    expect(chevron(en.models)).toBe('dsw-icon-chevron-right-outline-regular')
    expect(chevron(en.customized)).toBe('dsw-icon-chevron-down-outline-regular')
  })

  it('keeps the model list of the create card in view under a heading that does not fold', async () => {
    await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    const panel = within(screen.getByRole('tabpanel', { name: en.addCustom }))
    const list = within(panel.getByRole('region', { name: en.models }))
    expect(list.getByText(en.models)).toBeTruthy()
    expect(list.queryByRole('button', { name: en.models })).toBeNull()
    expect(list.getByRole('button', { name: en.addModel })).toBeTruthy()
  })

  it('seats the provider-card extension above the editor in the setup card and the add card', async () => {
    const { view, controller, face } = await mountFirstRun()
    view.unmount()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={name => name === 'settings.models.provider-card' ? <span data-testid="provider-card-seat" /> : null}
    />)
    const precedes = (first: Element, second: Element): boolean =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

    const setupKey = screen.getByLabelText(en.keyInput)
    expect(precedes(within(setupKey.closest('li')!).getByTestId('provider-card-seat'), setupKey)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: en.add }))
    const panel = within(screen.getByRole('tabpanel', { name: en.addCatalog }))
    const seat = panel.getByTestId('provider-card-seat')
    // Below the provider it describes, above the fields that edit it.
    expect(precedes(panel.getByLabelText(en.provider), seat)).toBe(true)
    expect(precedes(seat, panel.getByLabelText(en.keyInput))).toBe(true)
  })

  it('opens the add card on the catalog mode with both modes offered', async () => {
    await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    const modes = screen.getByRole('tablist', { name: en.addMode })
    expect(within(modes).getByRole('tab', { name: en.addCatalog }).getAttribute('aria-selected')).toBe('true')
    expect(within(modes).getByRole('tab', { name: en.addCustom }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByText(en.addCatalogHint)).toBeTruthy()
    expect(screen.queryByText(en.addCustomHint)).toBeNull()
    expect(screen.getByRole('combobox', { name: en.provider })).toBeTruthy()
    // The custom panel is mounted but hidden, so its fields are not reachable.
    expect(screen.queryByRole('textbox', { name: en.customRoute })).toBeNull()
  })

  it('switches between the modes without losing either draft', async () => {
    await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-catalog' } })

    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    expect(screen.getByText(en.addCustomHint)).toBeTruthy()
    expect(screen.queryByText(en.addCatalogHint)).toBeNull()
    expect(screen.queryByRole('combobox', { name: en.provider })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: en.customRoute }), { target: { value: 'acme' } })

    // Both panels stay mounted from here on, so the shown one is queried by name.
    fireEvent.click(screen.getByRole('tab', { name: en.addCatalog }))
    const catalog = screen.getByRole('tabpanel', { name: en.addCatalog })
    expect(within(catalog).getByLabelText<HTMLInputElement>(en.keyInput).value).toBe('sk-catalog')
    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.customRoute }).value).toBe('acme')
  })

  it('offers the same key reveal control on a custom provider', async () => {
    await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    const panel = within(screen.getByRole('tabpanel', { name: en.addCustom }))
    const input = panel.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(panel.queryByRole('button', { name: en.keyReveal })).toBeNull()
    fireEvent.change(input, { target: { value: 'custom-test-key' } })
    fireEvent.click(panel.getByRole('button', { name: en.keyReveal }))
    expect(input.type).toBe('text')
    fireEvent.click(panel.getByRole('button', { name: en.keyHide }))
    expect(input.type).toBe('password')
  })

  it('opens on the custom mode when every catalog provider is already configured', async () => {
    const scripted = scriptedFace()
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    ]))
    await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    const catalog = screen.getByRole<HTMLButtonElement>('tab', { name: en.addCatalog })
    expect(catalog.disabled).toBe(true)
    expect(screen.getByRole('tab', { name: en.addCustom }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('textbox', { name: en.customRoute })).toBeTruthy()
  })

  it('shows the custom form alone when no directory row can be adopted', async () => {
    const scripted = scriptedFace()
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([]))
    await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('combobox', { name: en.provider })).toBeNull()
    expect(screen.getByRole('textbox', { name: en.customRoute })).toBeTruthy()
  })

  it('disables the add action when neither mode can proceed', async () => {
    const scripted = scriptedFace()
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    ]))
    // A pi-ai schema naming no protocol leaves nothing to declare either.
    const protocolless = JSON.parse(JSON.stringify(
      Schema.object({ providers: Schema.dict(Schema.object({})) }).toJSON(),
    )) as JsonValue
    scripted.face.settings.describe.mockResolvedValue(remoteOk({
      writable: true, hasDocument: false,
      namespaces: wireNamespaces().map(view => view.ns === 'llm-pi-ai' ? { ...view, schema: protocolless } : view),
    }))
    await mountFace(scripted)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.add }).disabled).toBe(true)
  })

  it('shows the custom panel when a refresh drops every configurable row mid-card', async () => {
    const { face, controller } = await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.getByRole('combobox', { name: en.provider })).toBeTruthy()
    // The directory empties while the card is open: the only mode left is the
    // custom one, whose panel was never visited.
    face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([]))
    await act(async () => { await controller.load() })
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('textbox', { name: en.customRoute })).toBeTruthy()
  })

  it('picks a catalog target when the catalog becomes addable after the card opened', async () => {
    const scripted = scriptedFace()
    const exhausted = [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    ]
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk(exhausted))
    const { controller } = await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.getByRole<HTMLButtonElement>('tab', { name: en.addCatalog }).disabled).toBe(true)
    // A dormant route appears (another client deleted its profile, say).
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([
      ...exhausted,
      { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
    ]))
    await act(async () => { await controller.load() })
    const catalog = screen.getByRole<HTMLButtonElement>('tab', { name: en.addCatalog })
    expect(catalog.disabled).toBe(false)
    fireEvent.click(catalog)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.provider }).value).toBe('anthropic')
    expect(within(screen.getByRole('tabpanel', { name: en.addCatalog })).getByLabelText(en.keyInput)).toBeTruthy()
  })

  it('drops the custom panel when the pi-ai namespace disappears mid-card', async () => {
    const { face, controller, mirror } = await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    expect(screen.getByRole('textbox', { name: en.customRoute })).toBeTruthy()
    face.settings.describe.mockResolvedValue(remoteOk({
      writable: true, hasDocument: false,
      namespaces: wireNamespaces().filter(view => view.ns !== 'llm-pi-ai'),
    }))
    // A namespace change reaches the page through the mirror's own refresh.
    await act(async () => {
      await mirror.load()
      await controller.load()
    })
    // Nothing can be declared any more, so the form is gone rather than left
    // to create a route the Host would refuse; the catalog form stands alone.
    expect(screen.queryByRole('textbox', { name: en.customRoute })).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('combobox', { name: en.provider })).toBeTruthy()
  })

  it('forgets the catalog target when the custom form closes, so a later refresh opens no row editor', async () => {
    const { face, controller, mirror } = await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.provider }).value).toBe('anthropic')
    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    fireEvent.click(within(screen.getByRole('tabpanel', { name: en.addCustom })).getByText(en.cancel))
    expect(screen.queryByRole('tablist')).toBeNull()
    // The draft's provider gets configured elsewhere: its row must arrive closed.
    const withAnthropic = (layer: unknown): JsonValue => ({
      providers: { ...(layer as { providers: object }).providers, anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } },
    })
    face.settings.describe.mockResolvedValue(remoteOk({
      writable: true, hasDocument: false,
      namespaces: wireNamespaces().map(view => view.ns === 'llm-pi-ai'
        ? { ...view, value: withAnthropic(view.value), user: withAnthropic(view.user) }
        : view),
    }))
    await act(async () => {
      await mirror.load()
      await controller.load()
    })
    expect(screen.getByRole('button', { name: providerCopy(en.editProvider, { provider: 'anthropic', displayName: 'anthropic' }) })).toBeTruthy()
    expect(screen.queryAllByLabelText(en.keyInput)).toHaveLength(0)
  })

  it('locks the mode switch while the catalog form has a write in flight', async () => {
    let settle: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { settle = resolve })
    const providerNamespace = wireNamespaces().find(view => view.ns === 'llm-pi-ai')!
    const mutate = vi.fn(() => pending.then(() => remoteOk(providerNamespace)))
    await mountSection({ mutate })
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-slow' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('tab', { name: en.addCustom }).disabled).toBe(true) })
    expect(screen.getByRole<HTMLButtonElement>('tab', { name: en.addCatalog }).disabled).toBe(true)
    await act(async () => { settle!(); await pending })
    // The apply closes the card once it lands; nothing was switched underneath it.
    await waitFor(() => { expect(screen.queryByRole('tablist')).toBeNull() })
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('locks the mode switch while the custom form is asking the endpoint for models', async () => {
    const scripted = scriptedFace()
    let settle: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { settle = resolve })
    scripted.face.llm.discoverModels.mockImplementation(() => pending.then(() => remoteOk([])))
    await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    const custom = within(screen.getByRole('tabpanel', { name: en.addCustom }))
    fireEvent.change(custom.getByRole('textbox', { name: en.baseUrl }), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(custom.getByRole('button', { name: en.fetchModels }))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('tab', { name: en.addCatalog }).disabled).toBe(true) })
    await act(async () => { settle!(); await pending })
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('tab', { name: en.addCatalog }).disabled).toBe(false) })
  })

  it('pairs each tab with its panel through ids', async () => {
    await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    const catalogTab = screen.getByRole('tab', { name: en.addCatalog })
    const catalogPanel = screen.getByRole('tabpanel', { name: en.addCatalog })
    expect(catalogTab.getAttribute('aria-controls')).toBe(catalogPanel.id)
    expect(catalogPanel.getAttribute('aria-labelledby')).toBe(catalogTab.id)
    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    const customTab = screen.getByRole('tab', { name: en.addCustom })
    const customPanel = screen.getByRole('tabpanel', { name: en.addCustom })
    expect(customTab.getAttribute('aria-controls')).toBe(customPanel.id)
    expect(customPanel.getAttribute('aria-labelledby')).toBe(customTab.id)
  })

  it('titles a single-mode card with its mode instead of leaving an orphan tabpanel', async () => {
    const scripted = scriptedFace()
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([]))
    await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.getByText(en.addCustom)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.customRoute })).toBeTruthy()
  })

  it('explains a locked mode through its hover title', async () => {
    const scripted = scriptedFace()
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    ]))
    await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.getByRole('tab', { name: en.addCatalog }).getAttribute('title')).toBe(en.addCatalogExhausted)
    expect(screen.getByRole('tab', { name: en.addCustom }).getAttribute('title')).toBeNull()
  })

  it('explains a mode with no protocol to declare through its hover title', async () => {
    const scripted = scriptedFace()
    const protocolless = JSON.parse(JSON.stringify(
      Schema.object({ providers: Schema.dict(Schema.object({})) }).toJSON(),
    )) as JsonValue
    scripted.face.settings.describe.mockResolvedValue(remoteOk({
      writable: true, hasDocument: false,
      namespaces: wireNamespaces().map(view => view.ns === 'llm-pi-ai' ? { ...view, schema: protocolless } : view),
    }))
    await mountFace(scripted)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.getByRole('tab', { name: en.addCustom }).getAttribute('title')).toBe(en.addCustomUnavailable)
    expect(screen.getByRole('tab', { name: en.addCatalog }).getAttribute('title')).toBeNull()
  })

  it('collapses the add card from the custom mode on cancel', async () => {
    await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
    fireEvent.click(within(screen.getByRole('tabpanel', { name: en.addCustom })).getByText(en.cancel))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: en.add })).toBeTruthy()
  })

  it('cancels the add card back to the add button', async () => {
    await mountSection()
    fireEvent.click(screen.getByText(en.add))
    await screen.findByLabelText(en.provider)
    fireEvent.click(screen.getByText(en.cancel))
    await screen.findByText(en.add)
    expect(screen.queryByLabelText(en.provider)).toBeNull()
  })

  it('collapses the setup card on cancel without disturbing another open card', async () => {
    // The regression: the setup card shared the row/add/declare close handler,
    // so cancelling it discarded the add card's draft while staying open itself.
    await mountFirstRun()
    expect(screen.getAllByLabelText(en.keyInput)).toHaveLength(1)
    fireEvent.click(screen.getByText(en.add))
    await screen.findByLabelText(en.provider)
    expect(screen.getAllByLabelText(en.keyInput)).toHaveLength(2)

    // The setup card is the first one on the page, above the add block.
    fireEvent.click(screen.getAllByText(en.cancel)[0] as HTMLElement)
    // The add card kept its draft…
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    // …and DeepSeek collapsed to an ordinary row that words its missing key.
    expect(screen.getAllByLabelText(en.keyInput)).toHaveLength(1)
    expect(screen.getAllByText(en.credentialMissing)
      .some(mark => mark.closest('li')?.textContent?.includes('DeepSeek') === true)).toBe(true)
    // Its card reopens through Edit, which closes the add card as any row does.
    fireEvent.click(screen.getByRole('button', { name: deepSeekCopy(en.editProvider) }))
    expect(screen.getAllByLabelText(en.keyInput)).toHaveLength(1)
    expect(screen.queryByLabelText(en.provider)).toBeNull()
  })

  it('loads on first render of an idle controller', async () => {
    const { face } = scriptedFace()
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    await screen.findByText('DeepSeek')
  })

  it('removes by unsetting the profile path, never by rebuilding the section', async () => {
    // The page only needs to name the profile path; rebuilding the section
    // would widen the write for no benefit.
    const { face, mutate, controller } = await mountSection()
    await removeProviderProfile(
      operationsWith(face),
      controller,
      { settingsNs: 'llm-plain', settingsPath: ['ghost-profile'] },
    )
    expect(mutate.mock.calls[0]).toEqual([
      'llm-plain',
      [{ op: 'unset', path: ['ghost-profile'] }],
      undefined,
    ])
  })

  it('keeps the snapshot untouched and reports the message when a removal write is refused', async () => {
    const { face, controller } = await mountSection({
      mutate: vi.fn(() => Promise.resolve(remoteFail('read-only', 'settings/rejected'))),
    })
    const before = controller.store.getSnapshot().rows
    const failure = await removeProviderProfile(
      operationsWith(face),
      controller,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    )
    expect(failure).toBe('read-only')
    expect(controller.store.getSnapshot().rows).toBe(before)
  })

  it('keeps a failed identified deletion recoverable in its confirmation dialog', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce(remoteFail('the host refused', 'settings/rejected'))
      .mockResolvedValueOnce(remoteOk(wireNamespaces()[2]!))
    const { unset } = await mountSection({ mutate })
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    const confirm = within(dialog).getByRole('button', { name: openaiCopy(en.deleteConfirm) })
    fireEvent.click(confirm)
    await within(dialog).findByText('the host refused')
    expect(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBe(dialog)
    expect(unset).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledOnce()

    fireEvent.click(confirm)
    await waitFor(() => { expect(unset).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    })
  })

  it('retains credentials that are not identified as page-managed', async () => {
    const { unset, mutate } = await mountSection()
    const target = { provider: 'zombie', displayName: 'zombie' }
    fireEvent.click(screen.getByRole('button', { name: providerCopy(en.removeProvider, target) }))
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })
    expect(dialog.textContent).toContain(providerCopy(en.deleteDescription, target))
    fireEvent.click(within(dialog).getByRole('button', { name: providerCopy(en.deleteConfirm, target) }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(unset).not.toHaveBeenCalled()
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'unset', path: ['providers', 'zombie'] }],
      undefined,
    ])
  })

  it('does not remove provider settings when its managed credential removal is refused', async () => {
    const { face, controller, mutate } = await mountSection({
      unset: vi.fn(() => Promise.resolve(remoteFail('credential is read-only'))),
    })
    const failure = await removeProviderProfile(
      operationsWith(face),
      controller,
      {
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        credentialRef: 'OPENAI_API_KEY',
      },
    )
    expect(failure).toBe('credential is read-only')
    expect(mutate).not.toHaveBeenCalled()
  })

})

describe('apiKeyFailure', () => {
  it('treats a blank field as no failure — it means keep the stored key', () => {
    expect(apiKeyFailure('')).toBeUndefined()
  })

  it.each([
    ['a printable-ASCII key', 'sk-0123456789'],
    ['a padded key, which the caller trims', '  sk-abc  '],
    ['the printable-ASCII boundary characters', '!~'],
    ['a hyphenated key carrying an equals sign', 'sk-ABC=xyz'],
    ['an all-upper-case key ending in base64 padding', 'ABCD=='],
    ['an all-upper-case key ending in one padding character', 'MNOPQRST='],
  ])('accepts %s', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBeUndefined()
  })

  it.each([
    ['spaces', '   '],
    ['a tab', '\t'],
  ])('fails a field holding only %s instead of silently dropping it', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyBlank')
  })

  it.each([
    ['an emoji', 'sk-\u{1F600}'],
    ['CJK text', 'sk-你好'],
    ['full-width punctuation', 'sk-abc，'],
    ['an interior space', 'sk-abc def'],
    ['a C0 control character', 'sk-abc\x01'],
    ['a latin-1 character', 'sk-café'],
  ])('fails %s as illegal characters', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyIllegalCharacters')
  })

  it.each([
    ['a pasted environment line', 'DEEPSEEK_API_KEY=sk-abc'],
    ['double quotes', '"sk-abc"'],
    ['single quotes', '\'sk-abc\''],
    ['backticks', '`sk-abc`'],
  ])('fails %s as a format failure', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyIllegalCharacters')
  })

  it('needs a matching closing quote before it calls a value wrapped', () => {
    // A lone quote and an unbalanced one are legal printable ASCII, so the
    // heuristic leaves them alone rather than guessing at a paste error.
    expect(apiKeyFailure('"')).toBeUndefined()
    expect(apiKeyFailure('"a')).toBeUndefined()
  })
})

it.each(['env', 'project-env', 'user-env'] as const)('shows the environment authentication with a blank input for source %s', (source) => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', { apiKeyEnv: 'OPENAI_API_KEY' }), {
    credential: { configured: true, source, writable: true },
  })
  const hint = en.keyFallbackDetected.replace('{hint}', 'OPENAI_API_KEY')
  const input = screen.getByLabelText<HTMLInputElement>(en.keyInput)
  expect(screen.queryByText(/^API key source:/)).toBeNull()
  expect(screen.getAllByText(hint)).toHaveLength(1)
  expect(input.value).toBe('')
  expect(input.placeholder).toBe(en.keyPlaceholderFallback.replace('{hint}', 'OPENAI_API_KEY'))
  fireEvent.change(input, { target: { value: 'new-key' } })
  expect(screen.queryByText(hint)).toBeNull()
  expect(screen.queryByText(/^API key source:/)).toBeNull()
  expect(input.getAttribute('aria-describedby')).toBeNull()
  // Without a saved key the field has no read-only form to return to.
  fireEvent.blur(input)
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
  expect(screen.getByLabelText(en.keyInput)).toBe(input)
  fireEvent.change(input, { target: { value: '' } })
  expect(screen.getAllByText(hint)).toHaveLength(1)
})

it.each([
  ['openai', `sk-proj-${'•'.repeat(8)}wxyz`],
  ['anthropic', `sk-ant-a${'•'.repeat(8)}wxyz`],
  ['google', `AIzaS${'•'.repeat(8)}wxyz`],
  ['deepseek', `sk-abcde${'•'.repeat(8)}wxyz`],
  ['acme-gateway', `vendor_abcde${'•'.repeat(8)}wxyz`],
] as const)('shows the saved %s key read-only and edits its replacement on request', (provider, masked) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, { apiKeyEnv: 'TEAM_API_KEY' }), {
    credential: { configured: true, source: 'file', writable: true, masked },
  })
  expect(screen.getByText(masked)).toBeTruthy()
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(document.querySelector('[id$="-credential-hint"]')).toBeNull()
  const input = replaceSavedKey()
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('')
  expect(input.type).toBe('password')
  expect(input.placeholder).toBe(en.keyReplacementPlaceholder)
  expect(screen.queryByRole('button', { name: en.keyReveal })).toBeNull()
  // Focus leaving the untouched input restores the preview.
  fireEvent.blur(input)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.getByText(masked)).toBeTruthy()
  const draft = replaceSavedKey()
  fireEvent.change(draft, { target: { value: 'replacement-key' } })
  expect(draft.getAttribute('aria-describedby')).toBeNull()
  // Pressing the reveal button leaves focus in the input, and focus moving to it stays in the field.
  const reveal = screen.getByRole('button', { name: en.keyReveal })
  expect(fireEvent.mouseDown(reveal)).toBe(false)
  fireEvent.blur(draft, { relatedTarget: reveal })
  fireEvent.click(reveal)
  expect(draft.type).toBe('text')
  expect(draft.value).toBe('replacement-key')
  fireEvent.blur(draft)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.getByText('•'.repeat('replacement-key'.length))).toBeTruthy()
  // The reopened input still holds the draft, masked again.
  const reopened = replaceSavedKey()
  expect(reopened.value).toBe('replacement-key')
  expect(reopened.type).toBe('password')
  // An emptied draft keeps the saved key.
  fireEvent.change(reopened, { target: { value: '' } })
  expect(reopened.placeholder).toBe(en.keyReplacementPlaceholder)
  expect(document.querySelector('[id$="-credential-hint"]')).toBeNull()
  fireEvent.blur(reopened)
  expect(screen.getByText(masked)).toBeTruthy()
})

it('keeps the input of a saved key while the window is deactivated', () => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', { apiKeyEnv: 'OPENAI_API_KEY' }), {
    credential: { configured: true, source: 'file', writable: true, masked: '••••••••' },
  })
  const input = replaceSavedKey()
  const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  try {
    fireEvent.blur(input)
    expect(screen.getByLabelText(en.keyInput)).toBe(input)
    hasFocus.mockReturnValue(true)
    fireEvent.blur(input)
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  } finally {
    hasFocus.mockRestore()
  }
})

it('returns a valid replacement to read-only text with Enter and focuses the replace action', () => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', { apiKeyEnv: 'OPENAI_API_KEY' }), {
    credential: { configured: true, source: 'file', writable: true, masked: '••••••••' },
  })
  const input = replaceSavedKey()
  fireEvent.change(input, { target: { value: 'replacement-key' } })
  // Other keys and an IME confirmation leave the input open.
  expect(fireEvent.keyDown(input, { key: 'a' })).toBe(true)
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true)
  expect(screen.getByLabelText(en.keyInput)).toBe(input)
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.getByText('•'.repeat('replacement-key'.length))).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en.keyReplace }))
})

it('keeps the input and its error when a failing replacement loses focus, and refuses its save there', () => {
  const { face, set } = scriptedFace()
  const closed = vi.fn()
  render(<ProviderEditor provider="openai" displayName="OpenAI"
    namespace={piAiNamespaceWith('openai', { apiKeyEnv: 'OPENAI_API_KEY' })}
    settingsPath={['providers', 'openai']} schema={settingsSchema} operations={operationsWith(face)}
    t={t} readOnly={false} onClose={closed}
    credential={{ configured: true, source: 'file', writable: true, masked: '••••••••' }} />)
  const input = replaceSavedKey()
  fireEvent.change(input, { target: { value: '"sk-abc"' } })
  expect(input.getAttribute('aria-invalid')).toBe('true')
  fireEvent.blur(input)
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
  expect(screen.getByLabelText(en.keyInput)).toBe(input)
  expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
  // The refused save writes nothing and returns the keyboard to the input that stayed open.
  input.blur()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  expect(document.activeElement).toBe(input)
  expect(set).not.toHaveBeenCalled()
  expect(closed).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: 'sk-abc' } })
  fireEvent.blur(input)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.queryByText(en.keyIllegalCharacters)).toBeNull()
})

it('shows a key the route\'s protocol requires as a hint, and as an error once Apply was refused for it', async () => {
  const { face, set, mutate } = scriptedFace()
  const closed = vi.fn()
  render(<ProviderEditor provider="gemini-gateway" displayName="Gemini gateway" declared
    namespace={piAiNamespaceWith('gemini-gateway', { api: 'google-generative-ai', baseURL: 'https://gemini.example/v1beta' })}
    settingsPath={['providers', 'gemini-gateway']} schema={settingsSchema} operations={operationsWith(face)}
    t={t} readOnly={false} onClose={closed} />)
  const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
  const apply = screen.getByRole<HTMLButtonElement>('button', { name: en.apply })
  // A requirement still to meet: stated, not yet a fault, and no reason to hold Apply.
  expect(key.required).toBe(true)
  expect(key.getAttribute('aria-invalid')).toBe('false')
  expect(screen.getByText(en.keyRequired).className).toContain('advancedHint')
  expect(apply.disabled).toBe(false)

  fireEvent.click(apply)
  expect(screen.getByText(en.keyRequired).className).toContain('error')
  expect(key.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(key)
  expect(mutate).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()

  fireEvent.change(key, { target: { value: 'gemini-key' } })
  expect(screen.queryByText(en.keyRequired)).toBeNull()
  expect(key.getAttribute('aria-invalid')).toBe('false')
  fireEvent.click(apply)
  await waitFor(() => { expect(closed).toHaveBeenCalledWith(true) })
  expect(set).toHaveBeenCalledExactlyOnceWith('GEMINI_GATEWAY_API_KEY', 'gemini-key')
  expect(mutate.mock.calls).toEqual([[
    'llm-pi-ai', [{ op: 'set', path: ['providers', 'gemini-gateway', 'apiKeyEnv'], value: 'GEMINI_GATEWAY_API_KEY' }], 0,
  ]])
})

it('hides the reveal control and masks a disabled key draft', () => {
  const view = render(<ApiKeyInput value="new-key" t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.keyReveal }))
  expect(screen.getByRole<HTMLInputElement>('textbox').type).toBe('text')
  view.rerender(<ApiKeyInput value="new-key" t={t} disabled />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(document.querySelector('input')?.type).toBe('password')
})

it('disables the saved-key actions of a disabled field', () => {
  render(<ApiKeyInput value="" t={t} disabled saved={{ masked: '••••••••', clear: vi.fn() }} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.keyReplace }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.keyClear }).disabled).toBe(true)
})

it('shows a fixed mask when the credential provider omits the preview', () => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', { apiKeyEnv: 'OPENAI_API_KEY' }), {
    credential: { configured: true, source: 'file', writable: true },
  })
  expect(screen.getByText('•'.repeat(8))).toBeTruthy()
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.getByRole('button', { name: en.keyReplace })).toBeTruthy()
})

it('stages saved-key deletion with the clear action and can cancel it', async () => {
  const { unset } = await mountSection()
  const edit = () => screen.getByRole('button', { name: openaiCopy(en.editProvider) })
  fireEvent.click(edit())
  expect(screen.getByText('••••••••')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  const input = screen.getByLabelText<HTMLInputElement>(en.keyInput)
  expect(document.activeElement).toBe(input)
  expect(input.placeholder).toBe(en.keyPlaceholderFallback.replace('{hint}', 'OPENAI_API_KEY'))
  // Only the placeholder speaks for the cleared field; no hint sits below it.
  expect(document.querySelector('[id$="-credential-hint"]')).toBeNull()
  expect(input.getAttribute('aria-describedby')).toBeNull()
  // A staged removal has no read-only form.
  fireEvent.blur(input)
  expect(screen.getByLabelText(en.keyInput)).toBe(input)
  expect(unset).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(unset).not.toHaveBeenCalled()
  fireEvent.click(edit())
  expect(screen.getByText('••••••••')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(unset).toHaveBeenCalledExactlyOnceWith('OPENAI_API_KEY') })
})

it('offers no clear action when the credential store refuses writes', () => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', { apiKeyEnv: 'OPENAI_API_KEY' }), {
    credential: { configured: true, source: 'file', writable: false, masked: '••••••••' },
  })
  expect(screen.getByText('••••••••')).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.keyClear })).toBeNull()
  const input = replaceSavedKey()
  fireEvent.change(input, { target: { value: 'replacement' } })
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.blur(input)
  expect(screen.getByText('••••••••')).toBeTruthy()
  expect(screen.queryByText(en.keyRemovePending)).toBeNull()
})

it('keeps a hidden OAuth reference out of the saved API-key controls', () => {
  renderPiAiEditor('anthropic', piAiNamespaceWith('anthropic', { apiKeyEnv: 'ANTHROPIC_OAUTH_TOKEN' }), {
    credential: { configured: true, source: 'file', writable: true, masked: '••••••••' },
  })
  const input = screen.getByLabelText<HTMLInputElement>(en.keyInput)
  expect(input.value).toBe('')
  expect(input.placeholder).toBe(en.keyPlaceholder)
  expect(screen.queryByRole('button', { name: en.keyReplace })).toBeNull()
  expect(screen.queryByRole('button', { name: en.keyClear })).toBeNull()
})

it.each([
  ['google', 'GOOGLE_API_KEY', { env: ['GEMINI_API_KEY'], oauth: false }, true],
  ['openai', 'TEAM_API_KEY', { env: ['OPENAI_API_KEY'], oauth: false }, false],
  ['acme', 'ACME_API_KEY', undefined, false],
] as const)('clears %s through its saved reference and preserves the endpoint', async (provider, ref, nativeAuth, removesReference) => {
  const { face, unset, set, mutate } = scriptedFace()
  const namespace = piAiNamespaceWith(provider, { apiKeyEnv: ref, baseURL: 'https://gateway.example/v1' })
  const closed = vi.fn()
  render(<ProviderEditor provider={provider} displayName={provider} namespace={namespace}
    settingsPath={['providers', provider]} schema={settingsSchema} operations={operationsWith(face)}
    t={t} readOnly={false} onClose={closed} {...nativeAuth === undefined ? {} : { nativeAuth }}
    credential={{ configured: true, source: 'file', writable: true, masked: '••••••••' }} />)
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  const envRef = removesReference && nativeAuth !== undefined ? nativeAuth.env[0] : ref
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', envRef))
  expect(document.querySelector('[id$="-credential-hint"]')).toBeNull()
  fireEvent.click(screen.getByText(en.customized))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.fetchModels }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(closed).toHaveBeenCalledWith(true) })
  expect(unset).toHaveBeenCalledExactlyOnceWith(ref)
  expect(set).not.toHaveBeenCalled()
  if (removesReference) expect(mutate.mock.calls[0]?.[1])
    .toEqual([{ op: 'unset', path: ['providers', provider, 'apiKeyEnv'] }])
  else expect(mutate).not.toHaveBeenCalled()
})

it.each([
  ['detected', { configured: true, source: 'env', writable: true }],
  ['missing', { configured: false, writable: true }],
] as const)('shows no hint for a cleared key whose environment fallback is %s', (_label, check) => {
  renderPiAiEditor('google', piAiNamespaceWith('google', { apiKeyEnv: 'GOOGLE_API_KEY' }), {
    nativeAuth: { env: ['GEMINI_API_KEY'], oauth: false },
    credential: { configured: true, source: 'file', writable: true, masked: '••••••••' },
    credentialChecks: { GEMINI_API_KEY: check },
  })
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  expect(document.querySelector('[id$="-credential-hint"]')).toBeNull()
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', 'GEMINI_API_KEY'))
})

it('shows no hint after clearing when native authentication has no visible environment reference', () => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', { apiKeyEnv: 'OPENAI_API_KEY' }), {
    nativeAuth: { env: [], oauth: false },
    credential: { configured: true, source: 'file', writable: true, masked: '••••••••' },
  })
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  expect(document.querySelector('[id$="-credential-hint"]')).toBeNull()
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder).toBe(en.keyPlaceholder)
})

it.each(['cancel', 'replace'])('keeps authentication unchanged after refused deletion, then %s', async (action) => {
  const { face, unset, set, mutate } = scriptedFace({
    unset: vi.fn(() => Promise.resolve(remoteFail('credential store locked'))),
  })
  const closed = vi.fn()
  render(<ProviderEditor provider="google" displayName="Google"
    namespace={piAiNamespaceWith('google', { apiKeyEnv: 'GOOGLE_API_KEY' })}
    settingsPath={['providers', 'google']} schema={settingsSchema} operations={operationsWith(face)}
    t={t} readOnly={false} onClose={closed} nativeAuth={{ env: ['GEMINI_API_KEY'], oauth: false }}
    credential={{ configured: true, source: 'file', writable: true, masked: '••••••••' }} />)
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText('credential store locked')
  expect(mutate).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', 'GEMINI_API_KEY'))
  if (action === 'cancel') {
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(closed).toHaveBeenCalledWith(false)
  } else {
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'new-key' } })
    expect(screen.queryByText('credential store locked')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(closed).toHaveBeenCalledWith(true) })
    expect(set).toHaveBeenCalledExactlyOnceWith('GOOGLE_API_KEY', 'new-key')
  }
  expect(unset).toHaveBeenCalledExactlyOnceWith('GOOGLE_API_KEY')
  expect(mutate).not.toHaveBeenCalled()
})

it.each(['retry', 'close'])('reports a completed deletion when settings fail, then %s', async (action) => {
  const namespace = piAiNamespaceWith('google', { apiKeyEnv: 'GOOGLE_API_KEY' })
  const written = { ...namespace, revision: namespace.revision + 1,
    user: { providers: { google: {} } }, value: { providers: { google: {} } } }
  const mutate = vi.fn().mockResolvedValueOnce(remoteFail('settings locked')).mockResolvedValueOnce(remoteOk(written))
  const { face, unset } = scriptedFace({ mutate })
  const closed = vi.fn()
  render(<ProviderEditor provider="google" displayName="Google" namespace={namespace}
    settingsPath={['providers', 'google']} schema={settingsSchema} operations={operationsWith(face)}
    t={t} readOnly={false} onClose={closed} nativeAuth={{ env: ['GEMINI_API_KEY'], oauth: false }}
    credential={{ configured: true, source: 'file', writable: true, masked: '••••••••' }} />)
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText('settings locked')
  expect(screen.getByText(en.keyRemoveApplied)).toBeTruthy()
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(true)
  if (action === 'retry') {
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(closed).toHaveBeenCalledWith(true) })
    expect(mutate).toHaveBeenCalledTimes(2)
  } else {
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(closed).toHaveBeenCalledWith(false)
    expect(mutate).toHaveBeenCalledOnce()
  }
  expect(unset).toHaveBeenCalledExactlyOnceWith('GOOGLE_API_KEY')
})

it('clears the selected reference when refreshed metadata names a different credential', async () => {
  const { face, unset, mutate } = scriptedFace()
  const props: ProviderEditorProps = {
    provider: 'openai', displayName: 'OpenAI', namespace: piAiNamespaceWith('openai', { apiKeyEnv: 'OLD_KEY' }),
    settingsPath: ['providers', 'openai'], schema: settingsSchema, operations: operationsWith(face),
    t, readOnly: false, onClose: vi.fn(), credential: { configured: true, source: 'file', writable: true, masked: '••••••••' },
  }
  const view = render(<ProviderEditor {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  view.rerender(<ProviderEditor {...props} namespace={piAiNamespaceWith('openai', { apiKeyEnv: 'NEW_KEY' })} />)
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(unset).toHaveBeenCalledExactlyOnceWith('OLD_KEY') })
  expect(mutate).not.toHaveBeenCalled()
})

it('clears the detected native key instead of an unused derived reference', async () => {
  const { face, unset, mutate } = scriptedFace()
  render(<ProviderEditor provider="google" displayName="Google" namespace={piAiNamespaceWith('google', {})}
    settingsPath={['providers', 'google']} schema={settingsSchema} operations={operationsWith(face)}
    t={t} readOnly={false} onClose={vi.fn()} nativeAuth={{ env: ['GEMINI_API_KEY'], oauth: false }}
    credentialChecks={{ GEMINI_API_KEY: { configured: true, source: 'file', writable: true, masked: '••••••••' } }} />)
  fireEvent.click(screen.getByRole('button', { name: en.keyClear }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(unset).toHaveBeenCalledExactlyOnceWith('GEMINI_API_KEY') })
  expect(mutate).not.toHaveBeenCalled()
})

it.each([
  ['unconfigured', { apiKeyEnv: 'OPENAI_API_KEY' }, { configured: false, source: 'env', writable: true }],
  ['unknown source', { apiKeyEnv: 'OPENAI_API_KEY' }, { configured: true, source: 'oauth', writable: true }],
  ['native authentication', {}, { configured: true, source: 'file', writable: true, masked: '••••••••' }],
] as const)('does not guess a source for %s', (_label, profile, credential) => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', profile), { credential })
  expect(screen.queryByText(/^API key source:/)).toBeNull()
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('refreshes a blank editor from saved credentials to environment detection without an editor probe', async () => {
  const { face, controller } = await mountSection()
  const reads = face.credentials.describe.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.editProvider) }))
  expect(screen.getByText('••••••••')).toBeTruthy()
  expect(screen.queryByText(/^API key source:/)).toBeNull()
  expect(screen.queryByText(/Env var detected/)).toBeNull()
  expect(face.credentials.describe).toHaveBeenCalledTimes(reads)
  face.credentials.describe.mockImplementation(refs => Promise.resolve(remoteOk(
    Object.fromEntries(refs.map(ref => [ref, { configured: true, source: 'env', writable: true }])),
  )))
  await act(() => controller.load())
  expect(screen.getByText(en.keyFallbackDetected.replace('{hint}', 'OPENAI_API_KEY'))).toBeTruthy()
  expect(screen.queryByText(/^API key source:/)).toBeNull()
  expect(face.credentials.describe).toHaveBeenCalledTimes(reads + 1)
})

it('keeps an OAuth-only provider on its native authentication path', () => {
  renderPiAiEditor('openai-codex', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!, {
    nativeAuth: { env: [], oauth: true },
  })
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(authHelpText()).toBeNull()
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it.each([
  ['anthropic', ['ANTHROPIC_API_KEY'], en.keyHelp.replace('{env}', 'ANTHROPIC_API_KEY')],
  ['openai', ['OPENAI_API_KEY'], en.keyHelp.replace('{env}', 'OPENAI_API_KEY')],
] as const)('opens authentication help for %s on click and dismisses it with Escape', (provider, env, text) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, {}), {
    nativeAuth: { env: [...env], oauth: true },
  })
  const help = screen.getByLabelText(en.authHelp)
  fireEvent.click(help)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.textContent).toBe(text)
  expect(help.getAttribute('aria-describedby')).toBe(tooltip.id)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it.each([
  ['an OAuth-only provider', 'openai-codex', 'CODEX_TOKEN', { env: [], oauth: true }],
  [
    'a provider with catalog variables and an OAuth sign-in', 'anthropic', 'TEAM_ANTHROPIC_KEY',
    { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
  ],
] as const)('names the profile reference of %s instead of its native authentication', (_label, provider, ref, nativeAuth) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, { apiKeyEnv: ref }), { nativeAuth })
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', ref))
  expect(authHelpText()).toBe(en.keyHelp.replace('{env}', ref))
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it.each([
  [
    'with an OAuth sign-in', 'anthropic',
    { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
    'ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY',
  ],
  ['without an OAuth sign-in', 'minimax-cn', { env: ['MINIMAX_CN_API_KEY'], oauth: false }, 'MINIMAX_CN_API_KEY'],
] as const)('lists method-neutral fallbacks for a catalog route %s', (_label, provider, nativeAuth, refs) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, {}), { nativeAuth })
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', nativeAuth.env[0]))
  expect(authHelpText()).toBe(en.keyHelp.replace('{env}', refs))
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('shows the next method-neutral fallback without modifying native authentication metadata', () => {
  const nativeAuth = { env: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true }
  renderPiAiEditor('anthropic', piAiNamespaceWith('anthropic', {}), { nativeAuth })
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', 'ANTHROPIC_API_KEY'))
  expect(authHelpText()).toBe(en.keyHelp.replace('{env}', 'ANTHROPIC_API_KEY'))
  expect(nativeAuth.env).toEqual(['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('detects a hidden native credential without displaying its reference', () => {
  renderPiAiEditor('anthropic', piAiNamespaceWith('anthropic', {}), {
    nativeAuth: { env: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
    credentialChecks: {
      ANTHROPIC_OAUTH_TOKEN: { configured: true, source: 'env', writable: true },
      ANTHROPIC_API_KEY: { configured: false, writable: true },
    },
  })
  expect(screen.queryByText(en.keyFallbackMissing.replace('{hint}', 'ANTHROPIC_API_KEY'))).toBeNull()
  expect(document.body.textContent).toContain('Env var detected.')
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it.each([
  ['cloudflare-ai-gateway', ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'], ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID']],
  ['cloudflare-workers-ai', ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'], ['CLOUDFLARE_ACCOUNT_ID']],
  ['google-vertex', ['GOOGLE_CLOUD_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'], ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION']],
] as const)('does not report endpoint variables as detected credentials for %s', (provider, env, baseURLEnv) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, {}), {
    nativeAuth: { env, oauth: false },
    baseURLEnv,
    credentialChecks: Object.fromEntries(env.map(ref => [ref, {
      configured: baseURLEnv.some(name => name === ref), source: 'env', writable: true,
    }])),
  })
  expect(screen.getByText(en.keyFallbackMissing.replace('{hint}', env[0]))).toBeTruthy()
  expect(authHelpText()).toBe(en.keyHelp.replace('{env}', env[0]))
  expect(screen.queryByText(/Env var detected/)).toBeNull()
})

it('keeps a method-specific profile reference usable without displaying its name', () => {
  renderPiAiEditor('anthropic', piAiNamespaceWith('anthropic', { apiKeyEnv: 'TEAM_OAUTH_TOKEN' }), {
    nativeAuth: { env: ['ANTHROPIC_API_KEY'], oauth: true },
  })
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder).toBe(en.keyPlaceholder)
  expect(authHelpText()).toBeNull()
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('offers a plain key field to a route the adapter reports no authentication or endpoint for', () => {
  renderPiAiEditor('zombie', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!)
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder).toBe(en.keyPlaceholder)
  expect(authHelpText()).toBeNull()
  fireEvent.click(screen.getByText(en.customized))
  expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).placeholder).toBe(en.baseUrlDefault)
})

it('shows endpoint configuration variables without presenting them as credential keys', () => {
  const baseURLEnv = ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME']
  renderPiAiEditor('azure', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!, {
    baseURLEnv, nativeAuth: { env: ['AZURE_OPENAI_API_KEY'], oauth: false },
  })
  expect(authHelpText()).toContain('AZURE_OPENAI_API_KEY')
  expect(authHelpText()).not.toContain('AZURE_OPENAI_BASE_URL')
  fireEvent.click(screen.getByText(en.customized))
  const input = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
  expect(input.placeholder).toBe(en.baseUrlConfigured)
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent)
    .toBe(en.baseUrlEnvironment.replace('{env}', baseURLEnv.join(', ')))
})

it.each([true, false, undefined])('shows the confirmed fallback state without assuming a connection works: %s', (configured) => {
  renderPiAiEditor('deepseek', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!, {
    nativeAuth: { env: ['DEEPSEEK_API_KEY'], oauth: false },
    ...configured === undefined ? {} : { credentialChecks: { DEEPSEEK_API_KEY: { configured, writable: true } } },
  })
  const input = screen.getByLabelText<HTMLInputElement>(en.keyInput)
  expect(input.placeholder).toBe(en.keyPlaceholderFallback.replace('{hint}', 'DEEPSEEK_API_KEY'))
  const hint = configured === true ? en.keyFallbackDetected.replace('{hint}', 'DEEPSEEK_API_KEY')
    : configured === false ? en.keyFallbackMissing.replace('{hint}', 'DEEPSEEK_API_KEY') : en.keyFallbackUnchecked
  expect(screen.getByText(hint).getAttribute('role')).toBeNull()
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(hint)
  fireEvent.change(input, { target: { value: 'new-key' } })
  expect(screen.queryByText(hint)).toBeNull()
  expect(input.getAttribute('aria-describedby')).toBeNull()
})

it('checks all native fallback names and displays a later configured source', () => {
  renderPiAiEditor('anthropic', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!, {
    nativeAuth: { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
    credentialChecks: {
      ANTHROPIC_AUTH_TOKEN: { configured: false, writable: true },
      ANTHROPIC_OAUTH_TOKEN: { configured: true, writable: true },
      ANTHROPIC_API_KEY: { configured: true, source: 'env', writable: true },
    },
  })
  expect(screen.getByText(en.keyFallbackDetectedHidden)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('keeps an inherited profile endpoint ahead of dynamic provider configuration', () => {
  const namespace = wireNamespaces().find(view => view.ns === 'llm-pi-ai')!
  renderPiAiEditor('azure', { ...namespace, value: { providers: { azure: { baseURL: 'https://team.example/openai/v1' } } } }, {
    baseURLEnv: ['AZURE_OPENAI_BASE_URL'],
  })
  fireEvent.click(screen.getByText(en.customized))
  const input = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
  expect(input.placeholder).toBe('https://team.example/openai/v1')
  expect(input.getAttribute('aria-describedby')).toBeNull()
})

it('renders the localized account row as signed in without an edit action', async () => {
  const scripted = scriptedFace({})
  const { controller } = await mountFace(scripted)
  const row = controller.store.getSnapshot().rows[0]!
  await act(async () => { controller.store.update((state) => {
    state.rows = [{ ...row, accountAvailable: true, entry: { ...row.entry, provider: 'deepseek-account' } }]
  }) })
  const item = screen.getByText(en.deepSeekAccount).closest('li')!
  expect(within(item).getByText(en.accountSignedIn)).toBeTruthy()
  expect(within(item).queryByText(en.edit)).toBeNull()
})

it.each([es, fr, de, ru, pt])('keeps capacity examples in translated validation messages parseable', (dictionary) => {
  for (const [key, examples] of [
    ['modelContextInvalid', ['131072', '256K', '1M']],
    ['modelMaxTokensInvalid', ['8192', '64K', '1M']],
  ] as const) {
    for (const example of examples) {
      const token = dictionary[key].match(new RegExp(`(?<![0-9])${example}(?![0-9A-Za-z])`, 'u'))?.[0]
      expect(token, dictionary[key]).toBe(example)
      expect(parseCapacity(token!)).toBeGreaterThan(0)
    }
  }
})
