// @vitest-environment jsdom
/** Model-list editing, endpoint interrogation, and hand-declared provider creation. */
import { act, within, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ModelsSection, providerCopy } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { CustomProviderCard } from '../src/client/CustomProviderCard.tsx'
import { formatCapacity, parseCapacity } from '../src/client/DeepSeekModelsEditor.tsx'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore, PI_AI_PROFILE_PATH, deriveKeyRef, protocolChoices, reasoningLevelChoices } from '../src/client/store.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The pi-ai profile shape as the host serializes it, including the layer-1 fields. */
const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKey: Schema.string().role('secret'),
    apiKeyEnv: Schema.string().role('credential-ref'),
    displayName: Schema.string(),
    api: Schema.union(PROTOCOLS),
    baseURL: Schema.string(),
    models: Schema.array(Schema.object({
      id: Schema.string().required(),
      name: Schema.string(),
      contextWindow: Schema.number(),
      maxTokens: Schema.number(),
      reasoningEfforts: Schema.union([
        Schema.const(false),
        Schema.dict(Schema.union([Schema.string(), Schema.const(null)]), Schema.union(LEVELS)),
      ]),
    })),
    reasoning: Schema.union(['off', 'high']),
  })),
})

function ok<T>(value: T) {
  return { ok: true as const, value }
}
/** One draft-interrogation failure per code, each carrying its own details. */
const DISCOVERY_FAILURES: {
  [Code in 'gateway/internal' | 'llm/model-discovery-rejected']: (message: string) => RemoteError<Code>
} = {
  'gateway/internal': message => new RemoteError('gateway/internal', message, {}),
  'llm/model-discovery-rejected': message =>
    new RemoteError('llm/model-discovery-rejected', message, { settingsNs: 'llm-pi-ai' }),
}
function fail(message: string, code: keyof typeof DISCOVERY_FAILURES) {
  return { ok: false as const, error: DISCOVERY_FAILURES[code](message) }
}
/** Credentials answers over the Remote carrier, which has no envelope. */
function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}
/** The codes this page's scripted Host answers refuse with. */
type RefusalCode = 'credential/rejected' | 'settings/conflict' | 'settings/rejected'

/** One refusal per code, each carrying the details its own code declares. */
const REFUSALS: { [Code in RefusalCode]: (message: string) => RemoteError<Code> } = {
  'credential/rejected': message => new RemoteError('credential/rejected', message, { ref: 'OPENAI_API_KEY' }),
  'settings/conflict': message =>
    new RemoteError('settings/conflict', message, { ns: 'llm-pi-ai', expected: 7, actual: 8 }),
  'settings/rejected': message => new RemoteError('settings/rejected', message, { ns: 'llm-pi-ai' }),
}
function remoteFail(message: string, code: RefusalCode = 'credential/rejected') {
  return { ok: false as const, error: REFUSALS[code](message) }
}

function piAiNamespace(
  providers: Record<string, JsonValue>,
  userProviders: Record<string, JsonValue> = providers,
  baseProviders: Record<string, JsonValue> = {},
): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    // `value` is the effective section; `user` is only the layer this page
    // writes. They differ whenever a composition `base` supplies something.
    value: { providers },
    base: { providers: baseProviders },
    user: { providers: userProviders },
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision: 3,
  }
}

function scriptedFace(options: {
  providers?: Record<string, JsonValue>
  /** User layer, when it differs from the effective section. */
  userProviders?: Record<string, JsonValue>
  /** Composition layer, for a route a `cordis.yml` pins rather than the page. */
  baseProviders?: Record<string, JsonValue>
  /** Routes the adapter reports as hand-declared; the rest come back as shipped. */
  declaredRoutes?: readonly string[]
  discover?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
} = {}) {
  const providers = options.providers ?? {
    openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy.example/v1' },
  }
  const namespace = piAiNamespace(providers, options.userProviders ?? providers, options.baseProviders ?? {})
  const discover = options.discover ?? vi.fn(() => Promise.resolve(ok([])))
  const mutate = options.mutate ?? vi.fn(() => Promise.resolve(remoteOk(namespace)))
  const set = options.set ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const face = {
    llm: {
      listProviders: vi.fn(() => Promise.resolve(ok(
        Object.keys(providers).map(provider => ({ id: provider, name: provider })),
      ))),
      listConfigurableProviders: vi.fn(() => Promise.resolve(ok(
        Object.keys(providers).map(provider => ({
          provider,
          displayName: provider,
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', provider],
          declared: options.declaredRoutes?.includes(provider) ?? false,
        })),
      ))),
      discoverModels: discover,
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(remoteOk({ writable: true, namespaces: [namespace] }))),
      mutate,
    },
    credentials: {
      describe: vi.fn((refs: string[]) => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
      ))),
      set,
      unset: vi.fn(),
    },
  }
  return { face, discover, mutate, set, namespace }
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

/** The settings write one card produced, as the scripted face recorded it. */
interface MutateCall {
  ns: string
  expectedRevision?: number
  ops: { op: string; path: string[]; value?: unknown }[]
}

/** The latest interrogation payload; fails the case when nothing was asked. */
function lastProbe(discover: ReturnType<typeof vi.fn>): unknown {
  const call = (discover.mock.calls as [string, Record<string, unknown>][]).at(-1)
  if (call === undefined) throw new Error('no interrogation was recorded')
  return { settingsNs: call[0], ...call[1] }
}

/**
 * The first recorded settings write, as one record. The Remote method takes
 * three positional arguments; the cases read the write as a whole, so the
 * regrouping lives here rather than in every assertion.
 */
function firstMutate(mutate: ReturnType<typeof vi.fn>): MutateCall {
  const call = mutate.mock.calls[0] as [string, MutateCall['ops'], number | undefined] | undefined
  if (call === undefined) throw new Error('no settings write was recorded')
  const [ns, ops, expectedRevision] = call
  return { ns, ops, ...expectedRevision === undefined ? {} : { expectedRevision } }
}

async function mountSection(options: Parameters<typeof scriptedFace>[0] = {}) {
  const scripted = scriptedFace(options)
  const controller = new ModelsSettingsStore(
    ctxWith(scripted.face), settingsSchema, new SettingsDescribeMirror(ctxWith(scripted.face)))
  await controller.load()
  const injected: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    operations: operationsWith(scripted.face),
    schema: settingsSchema,
    t,
    renderSlot: () => null,
  }
  render(<ModelsSection {...injected} />)
  return { ...scripted, controller }
}

/** Unfold every folded model row, so its fields are on the page. */
function unfoldModels(): void {
  for (const toggle of screen.queryAllByRole('button', { name: new RegExp(`^${en.modelAdvanced} \\d+$`) })) {
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
  }
}

/** Open the editor of one configured row as it first appears: advanced settings and stored model rows folded. */
function openRow(provider: string): void {
  const row = screen.getByText(provider).closest('li')
  if (row === null) throw new Error(`no row for ${provider}`)
  fireEvent.click(within_(row, en.edit))
}

/** Open the editor of one configured row with its advanced fold and every model row unfolded. */
function openEditor(provider: string): void {
  openRow(provider)
  fireEvent.click(screen.getByRole('button', { name: en.customized }))
  unfoldModels()
}

/** Open the add card from the section and switch it to the custom-API mode. */
function openCustomMode(): void {
  fireEvent.click(screen.getByRole('button', { name: en.add }))
  fireEvent.click(screen.getByRole('tab', { name: en.addCustom }))
}

/** Unfold one model row, where its fields live; a row that is already unfolded stays so. */
function expandModel(index: number): void {
  const toggle = screen.getByLabelText(`${en.modelAdvanced} ${index}`)
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
}

/** The row of one model, folded or unfolded. */
function modelRow(index: number): HTMLElement {
  const row = screen.getByLabelText(`${en.modelAdvanced} ${index}`).closest<HTMLElement>('[data-row-key]')
  if (row === null) throw new Error(`no model row ${index}`)
  return row
}

/** The reason a refused save put under one model-row field, inside that field's label; `undefined` while the field is not marked. */
function markOf(label: string): string | undefined {
  const field = screen.getByLabelText(label)
  if (field.getAttribute('aria-invalid') !== 'true') return undefined
  const reason = field.closest('label')?.querySelector(`[id="${field.getAttribute('aria-describedby') ?? ''}"]`)
  return reason?.textContent ?? undefined
}

/** The labels of the fields the page marks invalid, in document order. */
function invalidFields(): (string | null)[] {
  return [...document.querySelectorAll('[aria-invalid="true"]')].map(el => el.getAttribute('aria-label'))
}

/** The labels of the fields on the page, in document order, leaving out those inside a folded section. */
function shownFields(): (string | null)[] {
  return [...document.querySelectorAll('input,select')]
    .filter(el => el.closest('[hidden]') === null)
    .map(el => el.getAttribute('aria-label'))
}

/** The notes-and-actions row holding the button `label`. */
function footerOf(label: string): HTMLElement {
  const footer = buttonNamed(label).closest<HTMLElement>('[class*="editorFooter"]')
  if (footer === null) throw new Error(`"${label}" is outside a footer`)
  return footer
}

/** The button carrying `label`, typed so its disabled/title state is readable. */
function buttonNamed(label: string): HTMLButtonElement {
  const found = screen.getByText(label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`"${label}" is not a button`)
  return found
}

/** Click the button with `label` inside `scope`. */
function within_(scope: HTMLElement, label: string): HTMLElement {
  const found = [...scope.querySelectorAll('button')].find(button => button.textContent === label)
  if (found === undefined) throw new Error(`no "${label}" button`)
  return found
}

describe('protocolChoices', () => {
  it('reads the protocols out of the namespace schema and nothing else', async () => {
    const { namespace } = scriptedFace()
    expect(protocolChoices(namespace, PI_AI_PROFILE_PATH, settingsSchema)).toEqual(PROTOCOLS)
    expect(protocolChoices(undefined, PI_AI_PROFILE_PATH, settingsSchema)).toEqual([])
    const plain = { ...namespace, schema: JSON.parse(JSON.stringify(Schema.object({}).toJSON())) as JsonValue }
    expect(protocolChoices(plain, PI_AI_PROFILE_PATH, settingsSchema)).toEqual([])
    await Promise.resolve()
  })
})

describe('reasoningLevelChoices', () => {
  it('reads the levels out of the reasoningEfforts key schema and nothing else', () => {
    const { namespace } = scriptedFace()
    expect(reasoningLevelChoices(namespace, PI_AI_PROFILE_PATH, settingsSchema)).toEqual(LEVELS)
    expect(reasoningLevelChoices(undefined, PI_AI_PROFILE_PATH, settingsSchema)).toEqual([])
    const plain = { ...namespace, schema: JSON.parse(JSON.stringify(Schema.object({}).toJSON())) as JsonValue }
    expect(reasoningLevelChoices(plain, PI_AI_PROFILE_PATH, settingsSchema)).toEqual([])
    const withoutDict = Schema.object({
      providers: Schema.dict(Schema.object({
        models: Schema.array(Schema.object({ reasoningEfforts: Schema.union([Schema.const(false)]) })),
      })),
    })
    const falseOnly = { ...namespace, schema: JSON.parse(JSON.stringify(withoutDict.toJSON())) as JsonValue }
    expect(reasoningLevelChoices(falseOnly, PI_AI_PROFILE_PATH, settingsSchema)).toEqual([])
  })
})

describe('model list editing', () => {
  it('changes image input without rewriting a neighboring model declaration', async () => {
    const neighbor = { id: 'vision', input: ['image'], name: 'Kept vision model' }
    const { mutate } = await mountSection({
      providers: { openai: { models: [{ id: 'preview' }, neighbor] } },
    })
    openEditor('openai')
    expandModel(1)
    fireEvent.click(within(screen.getByRole('group', { name: `${en.modelInputTypes} 1` })).getByRole('checkbox', { name: en.modelInputImage }))
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops).toEqual([{
      op: 'set', path: ['providers', 'openai', 'models'],
      value: [{ id: 'preview', input: ['text', 'image'] }, neighbor],
    }])
  })

  it('adds, edits, and removes rows without storing emptied optional fields', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    expandModel(1)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).placeholder).toBe('1M')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).placeholder).toBe('128K')
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: '65536' } })
    fireEvent.click(within(screen.getByRole('group', { name: `${en.modelInputTypes} 1` })).getByRole('checkbox', { name: en.modelInputImage }))
    fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: 'Acme' } })
    // Clearing an optional field must drop it rather than store an empty value.
    fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate)).toMatchObject({
      ns: 'llm-pi-ai',
      expectedRevision: 3,
      ops: [{ op: 'set', path: ['providers', 'openai', 'models'], value: [{ id: 'acme-large', contextWindow: 65_536, input: ['text', 'image'] }] }],
    })
  })

  it('marks a duplicate model id on its field in the edit flow too', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'dup' }] } },
    })
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'dup' } })

    // Nothing is reported while typing, and the action stays available.
    expect(buttonNamed(en.apply).disabled).toBe(false)
    expect(invalidFields()).toEqual([])

    // The create card refuses this in place; an edited route must not have to
    // learn it from the host's refusal instead. The reason sits under the
    // field it is about, which takes the keyboard.
    fireEvent.click(screen.getByText(en.apply))
    expect(markOf(`${en.modelId} 2`)).toBe(en.modelIdDuplicate)
    expect(invalidFields()).toEqual([`${en.modelId} 2`])
    expect(modelRow(2).hasAttribute('data-invalid')).toBe(true)
    expect(modelRow(1).hasAttribute('data-invalid')).toBe(false)
    expect(document.activeElement).toBe(screen.getByLabelText(`${en.modelId} 2`))
    expect(footerOf(en.apply).querySelector('p')).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('unfolds the model list and the row a refused save names, and leaves the passing rows folded', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'same' }, { id: 'same' }] } },
    })
    openRow('openai')
    const models = screen.getByRole('button', { name: en.models })
    fireEvent.click(models)
    expect(models.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByText(en.apply))

    expect(models.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText(`${en.modelAdvanced} 2`).getAttribute('aria-expanded')).toBe('true')
    expect(markOf(`${en.modelId} 2`)).toBe(en.modelIdDuplicate)
    expect(document.activeElement).toBe(screen.getByLabelText(`${en.modelId} 2`))
    expect(screen.getByLabelText(`${en.modelAdvanced} 1`).getAttribute('aria-expanded')).toBe('false')
    expect(modelRow(1).hasAttribute('data-invalid')).toBe(false)
    expect(mutate).not.toHaveBeenCalled()

    // Folded again, the row still says it holds a refused field, and the
    // reason is back under the field when the row unfolds.
    fireEvent.click(screen.getByLabelText(`${en.modelAdvanced} 2`))
    expect(modelRow(2).querySelector('input')).toBeNull()
    expect(modelRow(2).getAttribute('data-invalid')).toBe('true')
    expandModel(2)
    expect(markOf(`${en.modelId} 2`)).toBe(en.modelIdDuplicate)

    // Meeting the requirement removes the mark at once.
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'other' } })
    expect(invalidFields()).toEqual([])
    expect(modelRow(2).hasAttribute('data-invalid')).toBe(false)
  })

  it('shows a failure that appears after a refused save only at the next refused save', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'kept' }] } },
    })
    openRow('openai')
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.click(screen.getByText(en.apply))
    expect(markOf(`${en.modelId} 2`)).toBe(en.modelIdRequired)

    // Neither a row added afterwards nor a field broken afterwards is reported yet.
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelName} 2`), { target: { value: 'Second' } })
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 2`), { target: { value: 'abc' } })
    expect(invalidFields()).toEqual([`${en.modelId} 2`])
    expect(modelRow(3).hasAttribute('data-invalid')).toBe(false)

    // A row the last refused save marked is cleared by the next one once it passes.
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'second' } })
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 2`), { target: { value: '' } })
    fireEvent.click(screen.getByLabelText(`${en.modelAdvanced} 2`))
    fireEvent.click(screen.getByText(en.apply))
    expect(invalidFields()).toEqual([`${en.modelId} 3`])
    expect(markOf(`${en.modelId} 3`)).toBe(en.modelIdRequired)
    expect(screen.getByLabelText(`${en.modelAdvanced} 2`).getAttribute('aria-expanded')).toBe('false')
    expect(modelRow(2).hasAttribute('data-invalid')).toBe(false)
    expect(document.activeElement).toBe(screen.getByLabelText(`${en.modelId} 3`))
    expect(mutate).not.toHaveBeenCalled()
  })

  it('marks every refused field of one row, each with its own reason', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'kept' }] } },
    })
    openEditor('openai')
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: '64 KiB' } })
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 1`), { target: { value: '-1' } })

    fireEvent.click(screen.getByText(en.apply))

    expect(markOf(`${en.modelId} 1`)).toBe(en.modelIdRequired)
    expect(markOf(`${en.contextWindow} 1`)).toBe(en.modelContextInvalid)
    expect(markOf(`${en.maxTokens} 1`)).toBe(en.modelMaxTokensInvalid)
    expect(markOf(`${en.modelName} 1`)).toBeUndefined()
    expect(document.activeElement).toBe(screen.getByLabelText(`${en.modelId} 1`))

    // Each mark goes with its own fault; the row stays marked while one is left.
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'kept' } })
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: '64K' } })
    expect(invalidFields()).toEqual([`${en.maxTokens} 1`])
    expect(modelRow(1).hasAttribute('data-invalid')).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('reads K and M suffixes and keeps the text the user typed', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: '1M' } })
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 1`), { target: { value: '32K' } })

    // The field keeps the spelling rather than snapping to the expansion, and
    // a plain count is not rewritten into a suffix mid-word either.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).value).toBe('1M')
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 1`), { target: { value: '1000' } })
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).value).toBe('1000')

    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    // What lands in settings is always a plain token count.
    expect(firstMutate(mutate).ops[0]?.value)
      .toEqual([{ id: 'm', contextWindow: 1_000_000, maxTokens: 1000 }])
  })

  it('refuses to apply while a capacity is unreadable', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 1`), { target: { value: 'abc' } })

    // Silently dropping it would store a route sized differently from what the
    // field shows, so the text stays put and the write is refused instead.
    expect(buttonNamed(en.apply).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.apply))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).value).toBe('abc')
    expect(markOf(`${en.maxTokens} 1`)).toBe(en.modelMaxTokensInvalid)
    expect(document.activeElement).toBe(screen.getByLabelText(`${en.maxTokens} 1`))
    expect(mutate).not.toHaveBeenCalled()

    // A readable count clears the mark, and the same action then writes.
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 1`), { target: { value: '8K' } })
    expect(markOf(`${en.maxTokens} 1`)).toBeUndefined()
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([{ id: 'm', maxTokens: 8000 }])
  })

  it('spells a stored capacity back the way it is typed', async () => {
    await mountSection({
      providers: {
        openai: {
          baseURL: 'https://proxy.example/v1',
          models: [{ id: 'kept', contextWindow: 1_000_000, maxTokens: 256_000 }],
        },
      },
    })
    openEditor('openai')
    expandModel(1)

    // Opening a row reads the stored counts, which are plain integers; showing
    // them as such would make an already-configured route look unlike one the
    // user just typed, and re-applying would rewrite the field it read.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).value).toBe('1M')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).value).toBe('256K')
  })

  it('edits one row of several and lets a cleared capacity leave the profile', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'first' }, { id: 'second' }] } },
    })
    openEditor('openai')

    expandModel(2)
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 2`), { target: { value: '2048' } })
    fireEvent.change(screen.getByLabelText(`${en.modelName} 2`), { target: { value: 'Second' } })
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 2`), { target: { value: '4096' } })
    // Clearing it back to empty must drop the field, not store a zero.
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 2`), { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([
      { id: 'first' },
      { id: 'second', name: 'Second', maxTokens: 2048 },
    ])
  })

  it('shows the adapter defaults as inherited until an edit takes them over', async () => {
    await mountSection({ providers: { openai: { baseURL: 'https://proxy.example/v1' } } })
    openEditor('openai')

    // The user layer names no models, so the list belongs to the adapter and
    // says so; taking it over is an explicit act, not a side effect of opening.
    expect(screen.getByText(en.modelsInherited)).toBeTruthy()
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
    expect(screen.queryByText(en.resetModels)).toBeNull()

    // A first row makes the list the user's, which the heading row then states
    // beside the action that hands it back.
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    expect(screen.queryByText(en.modelsInherited)).toBeNull()
    expect(screen.getByText(en.modelsCustomized)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.resetModels }))
    expect(screen.getByText(en.modelsInherited)).toBeTruthy()
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
  })

  it('says nothing under the empty list of a route with no catalog to inherit', async () => {
    await mountSection({
      providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    expect(screen.getByRole('button', { name: en.addModel })).toBeTruthy()
    expect(screen.queryByText(en.modelsInherited)).toBeNull()
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
  })

  it('opens with the model list in view and the advanced settings folded', async () => {
    await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'kept' }] } },
    })
    openRow('openai')

    const models = screen.getByRole('button', { name: en.models })
    const advanced = screen.getByRole('button', { name: en.customized })
    expect(models.getAttribute('aria-expanded')).toBe('true')
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(shownFields()).toEqual([en.keyInput])
    expect(screen.queryByRole('textbox', { name: en.baseUrl })).toBeNull()

    fireEvent.click(advanced)
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.baseUrl }).value).toBe('https://proxy.example/v1')

    // Folding the list hides its rows and keeps the heading row's actions; an
    // unfolded row is still unfolded when the list comes back.
    expandModel(1)
    fireEvent.click(models)
    expect(models.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: en.addModel })).toBeNull()
    expect(screen.queryByRole('textbox', { name: `${en.modelId} 1` })).toBeNull()
    expect(screen.getByRole('button', { name: en.fetchModels })).toBeTruthy()
    fireEvent.click(models)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: `${en.modelId} 1` }).value).toBe('kept')
  })


  it('keeps expansion on the row it belongs to after an earlier one is removed', async () => {
    await mountSection({
      providers: {
        openai: {
          baseURL: 'https://proxy.example/v1',
          models: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
        },
      },
    })
    openRow('openai')

    // Expansion is keyed by position, so removing an earlier row shifts the
    // rest down; without reindexing, row 3 would inherit row 2's open state.
    expandModel(2)
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 1`))

    // 'second' now sits at position 1 and keeps its fields open; 'third'
    // moved to position 2 and stays folded.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('second')
    expect(screen.queryByLabelText(`${en.contextWindow} 1`)).not.toBeNull()
    expect(modelRow(2).textContent).toBe('third')
    expect(modelRow(2).querySelector('input')).toBeNull()
  })

  it('leaves an earlier row expanded and forgets the removed row\u2019s own state', async () => {
    await mountSection({
      providers: {
        openai: {
          baseURL: 'https://proxy.example/v1',
          models: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
        },
      },
    })
    openRow('openai')

    // A row before the removal keeps its own position and stays open.
    expandModel(1)
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 2`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('first')
    expect(screen.queryByLabelText(`${en.contextWindow} 1`)).not.toBeNull()

    // Removing the expanded row itself drops that state rather than handing it
    // to whichever row slides into the position.
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 1`))
    expect(modelRow(1).textContent).toBe('third')
    expect(modelRow(1).querySelector('input')).toBeNull()
  })

  it('separates emptying the list from restoring the adapter defaults', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'kept' }] } },
    })
    openEditor('openai')

    // An empty override is a route that serves no models — a different intent
    // from handing the catalog back, which is what the reset affordance does.
    expect(screen.getByText(en.modelsCustomized)).toBeTruthy()
    fireEvent.click(screen.getByText(en.resetModels))
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops)
      .toContainEqual({ op: 'unset', path: ['providers', 'openai', 'models'] })
  })

  it('declares reasoning levels on a catalog route model and stores them in its models list', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5', name: 'GPT-5' }] } },
    })
    openEditor('openai')
    expandModel(1)
    // Switched off, the field is absent and the model keeps the installed catalog's levels.
    const toggle = screen.getByRole('switch', { name: `${en.modelReasoning} 1` })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{
      op: 'set', path: ['providers', 'openai', 'models'],
      value: [{ id: 'gpt-5', name: 'GPT-5', reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } }],
    }])
  })
})

describe('capacity spellings', () => {
  it.each([
    ['', undefined],
    ['65536', 65_536],
    ['256K', 256_000],
    ['1m', 1_000_000],
    // A decimal multiple is exact in intent but not in binary floating point,
    // so an integral result snaps back instead of landing a few ULPs high.
    ['2.3M', 2_300_000],
    // Not an integral count: kept as written rather than silently rounded.
    ['1.0005K', 1000.5],
  ])('reads %j as %j', (text, expected) => {
    expect(parseCapacity(text)).toBe(expected)
  })

  it.each(['abc', '12x', '1 000', '-5', ''])('refuses %j rather than guessing', (text) => {
    const parsed = parseCapacity(text)
    expect(parsed === undefined || Number.isNaN(parsed)).toBe(true)
  })

  it.each([
    [1_000_000, '1M'],
    [256_000, '256K'],
    [65_536, '65536'],
    // Never a spelling that would not survive being read back.
    [0, '0'],
    [1.5, '1.5'],
  ])('spells %j as %j', (value, expected) => {
    expect(formatCapacity(value)).toBe(expected)
  })

  it('round-trips every spelling it produces', () => {
    for (const value of [1_000_000, 256_000, 65_536, 4096, 1000]) {
      expect(parseCapacity(formatCapacity(value))).toBe(value)
    }
  })
})

describe('endpoint interrogation', () => {
  it.each([[undefined], [[]], [['text']]])('renders catalog input inheritance for a stored declaration of %j', async (input) => {
    const discover = vi.fn(() => Promise.resolve(ok([
      { id: 'vision', inputModalities: ['text', 'image'] },
    ])))
    const model = { id: 'vision', ...input === undefined ? {} : { input } }
    const { mutate } = await mountSection({ discover, providers: { openai: { models: [model] } } })
    openEditor('openai')
    expandModel(1)
    const types = within(screen.getByRole('group', { name: `${en.modelInputTypes} 1` }))
    await waitFor(() => { expect(types.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).disabled).toBe(false) })
    expect(types.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(input?.length !== 1)
    expect(discover).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', { provider: 'openai' })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(screen.queryByRole('button', { name: en.apply })).toBeNull() })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('inherits a custom provider default input and persists an explicit model override', async () => {
    const { discover, mutate } = await mountSection({
      providers: {
        'acme-gateway': {
          api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1',
          defaultInput: ['text', 'image'], models: [{ id: 'custom' }],
        },
      },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')
    expandModel(1)
    const types = within(screen.getByRole('group', { name: `${en.modelInputTypes} 1` }))
    expect(types.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText }).checked).toBe(true)
    const image = types.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage })
    expect(image.checked).toBe(true)
    expect(image.disabled).toBe(false)
    expect(discover).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(image)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{
      op: 'set', path: ['providers', 'acme-gateway', 'models'],
      value: [{ id: 'custom', input: ['text'] }],
    }])
  })

  it('asks the endpoint the form shows, with a key that is not yet stored', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'acme-large', contextWindow: 65_536 }])))
    await mountSection({ discover })
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'typed-not-saved' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://edited.example/v1' } })
    fireEvent.click(screen.getByText(en.fetchModels))

    await waitFor(() => { expect(discover).toHaveBeenCalled() })
    expect(lastProbe(discover)).toEqual({
      settingsNs: 'llm-pi-ai',
      // The route is named, so an adapter that already describes it answers
      // from its own registry rather than the endpoint.
      provider: 'openai',
      baseURL: 'https://edited.example/v1',
      apiKey: 'typed-not-saved',
    })
  })

  it('carries the protocol the profile already names', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([])))
    await mountSection({
      discover,
      providers: { openai: { baseURL: 'https://proxy.example/v1', api: 'openai-responses' } },
    })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))

    await waitFor(() => { expect(discover).toHaveBeenCalled() })
    expect(lastProbe(discover)).toEqual({
      settingsNs: 'llm-pi-ai',
      provider: 'openai',
      baseURL: 'https://proxy.example/v1',
      api: 'openai-responses',
    })
  })

  it('opens on the configured models and appends a newly checked one, keeping a row the user already tuned', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([
      { id: 'kept', contextWindow: 999, inputModalities: ['text', 'image'] },
      { id: 'fresh', contextWindow: 4096, maxTokens: 2048, name: 'Fresh', inputModalities: ['text', 'image'] },
    ])))
    const { mutate } = await mountSection({
      discover,
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'kept', contextWindow: 111 }] } },
    })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    const dialog = await screen.findByRole('dialog')
    expect(screen.queryByRole('checkbox', { name: 'Fresh' })).toBeNull()
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.map(box => box.checked)).toEqual([true, false])
    fireEvent.click(screen.getByRole<HTMLInputElement>('checkbox', { name: 'fresh' }))
    fireEvent.click(screen.getByText(en.fetchAdopt))

    // An adopted model joins the list folded, named by its ID and display name.
    expect(modelRow(2).textContent).toBe('fresh Fresh')
    expect(modelRow(2).querySelector('input')).toBeNull()
    expandModel(2)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 2`).value).toBe('fresh')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelName} 2`).value).toBe('Fresh')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 2`).value).toBe('4096')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 2`).value).toBe('2048')

    expect(within(screen.getByRole('group', { name: `${en.modelInputTypes} 2` })).getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([
      { id: 'kept', contextWindow: 111 },
      { id: 'fresh', contextWindow: 4096, maxTokens: 2048, name: 'Fresh', input: ['text', 'image'] },
    ])
  })

  it('removes an unchecked configured model and keeps one the provider does not list', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'gone' }, { id: 'stays' }, { id: 'new' }])))
    const { mutate } = await mountSection({
      discover,
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [
        { id: 'gone' }, { id: 'unlisted', maxTokens: 512 }, { id: 'stays', contextWindow: 111 },
      ] } },
    })
    openEditor('openai')
    expandModel(3)

    fireEvent.click(screen.getByText(en.fetchModels))
    await screen.findByText(en.fetchTitle)
    fireEvent.click(screen.getByRole('checkbox', { name: 'gone' }))
    fireEvent.click(screen.getByText(en.fetchAdopt))

    // The disclosure follows its row up the list.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 2`).value).toBe('111')
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([
      { id: 'unlisted', maxTokens: 512 }, { id: 'stays', contextWindow: 111 },
    ])
  })

  it('checks a row drafted while the fetch is in flight', async () => {
    const reply = Promise.withResolvers<ReturnType<typeof ok>>()
    const discover = vi.fn(() => reply.promise)
    const { mutate } = await mountSection({
      discover,
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'a' }] } },
    })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'b' } })
    await act(async () => { reply.resolve(ok([{ id: 'a' }, { id: 'b' }, { id: 'c' }])) })
    const boxes = [...screen.getByRole('dialog').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.map(box => box.checked)).toEqual([true, true, false])
    fireEvent.click(screen.getByText(en.fetchAdopt))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('refuses to empty the list, since an empty list serves the whole catalog', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'a' }, { id: 'b' }, { id: 'c' }])))
    await mountSection({
      discover,
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'a' }, { id: 'b' }] } },
    })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within_(dialog, en.fetchSelectAll))
    fireEvent.click(within_(dialog, en.fetchDeselectAll))
    const adopt = within_(dialog, en.fetchAdopt) as HTMLButtonElement
    expect(adopt.disabled).toBe(true)
    expect(adopt.title).toBe(en.fetchKeepOne)

    // Removing several configured models at once still leaves one.
    fireEvent.click(screen.getByRole('checkbox', { name: 'c' }))
    expect(adopt.disabled).toBe(false)
    fireEvent.click(adopt)
    expect(modelRow(1).textContent).toBe('c')
    expect(screen.queryByLabelText(`${en.modelAdvanced} 2`)).toBeNull()
  })

  it('lists a repeated candidate id once and starts it checked beside a blank row', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'x' }, { id: 'x', maxTokens: 64 }])))
    await mountSection({ discover, providers: { openai: { baseURL: 'https://proxy.example/v1' } } })
    openEditor('openai')
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))

    fireEvent.click(screen.getByText(en.fetchModels))
    await screen.findByText(en.fetchTitle)
    expect(screen.getAllByRole<HTMLInputElement>('checkbox', { name: 'x' }).map(box => box.checked)).toEqual([true])
    fireEvent.click(screen.getByText(en.fetchAdopt))
    // The blank row keeps its fields open; the adopted model joins it folded.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('')
    expect(modelRow(2).textContent).toBe('x')
    expect(screen.queryByLabelText(`${en.modelAdvanced} 3`)).toBeNull()
  })

  it('keeps the rows editable when the provider cannot be interrogated', async () => {
    const discover = vi.fn(() => Promise.resolve(
      fail('https://proxy.example/v1/models answered 401; check the API key', 'llm/model-discovery-rejected'),
    ))
    await mountSection({ discover })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))

    await screen.findByText(/answered 401; check the API key/)
    // The failure is a detour, not a dead end: hand-entry is still offered.
    expect(screen.getByRole('button', { name: en.addModel })).toBeTruthy()
  })

  it('reports an empty listing', async () => {
    const empty = vi.fn(() => Promise.resolve(ok([])))
    await mountSection({ discover: empty })
    openEditor('openai')
    fireEvent.click(screen.getByText(en.fetchModels))
    await screen.findByText(en.fetchEmpty)
  })

  it('reports a failed fetch while the model section is folded', async () => {
    const empty = vi.fn(() => Promise.resolve(ok([])))
    await mountSection({ discover: empty })
    openEditor('openai')
    fireEvent.click(screen.getByRole('button', { name: en.models }))
    expect(screen.getByRole('button', { name: en.addModel, hidden: true }).closest('[hidden]')).not.toBeNull()

    fireEvent.click(screen.getByText(en.fetchModels))
    const failure = await screen.findByText(en.fetchEmpty)
    expect(failure.closest('[hidden]')).toBeNull()

    // Unfolding leaves it where it is: under the heading, above the rows.
    fireEvent.click(screen.getByRole('button', { name: en.models }))
    expect(failure.isConnected).toBe(true)
    expect(failure.compareDocumentPosition(screen.getByRole('button', { name: en.addModel }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('can be asked for a configured route even with no endpoint', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'from-registry' }])))
    await mountSection({ discover, providers: { openai: {} } })
    openEditor('openai')

    // A route the adapter already describes needs no endpoint at all.
    expect(buttonNamed(en.fetchModels).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.fetchModels))

    await waitFor(() => { expect(discover).toHaveBeenCalled() })
    expect(lastProbe(discover)).toEqual({ settingsNs: 'llm-pi-ai', provider: 'openai' })
  })

  it('keeps the create card asking only once it has an endpoint', () => {
    // A provider being declared has no route yet, so the endpoint is the only
    // thing an interrogation could go on.
    const scripted = scriptedFace()
    render(
      <CustomProviderCard
        taken={[]} protocols={PROTOCOLS} reasoningLevels={LEVELS} revision={7} operations={operationsWith(scripted.face)}
        t={t} readOnly={false} onClose={vi.fn()}
      />,
    )
    expect(buttonNamed(en.fetchModels).disabled).toBe(true)
    expect(buttonNamed(en.fetchModels).title).toBe(en.fetchNeedsBaseUrl)

    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    expect(buttonNamed(en.fetchModels).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.fetchModels))

    // A provider being declared names no route, so only the endpoint travels.
    expect(lastProbe(scripted.discover)).toEqual({
      settingsNs: 'llm-pi-ai',
      baseURL: 'https://acme.test/v1',
      api: 'openai-completions',
    })
  })

  it('shows a stored row as text until its fields are asked for', async () => {
    await mountSection({
      providers: {
        openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'only', name: 'Only model' }, { id: 'bare' }] },
      },
    })
    openRow('openai')

    // A folded row names its model and carries no field; a model without a
    // display name is named by its ID alone.
    const toggle = screen.getByLabelText(`${en.modelAdvanced} 1`)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(modelRow(1).textContent).toBe('only Only model')
    expect(modelRow(2).textContent).toBe('bare')
    expect(screen.getByRole('region', { name: en.models }).querySelector('input')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('only')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelName} 1`).value).toBe('Only model')
    expect(screen.getByLabelText(`${en.contextWindow} 1`)).toBeTruthy()

    fireEvent.click(toggle)
    expect(modelRow(1).querySelector('input')).toBeNull()

    // The text unfolds the row too.
    fireEvent.click(screen.getByText('Only model'))
    expect(screen.getByLabelText(`${en.contextWindow} 1`)).toBeTruthy()
    expect(modelRow(2).querySelector('input')).toBeNull()
  })

  it('unfolds a newly added row and leaves the stored rows folded', async () => {
    await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'kept' }] } },
    })
    openRow('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))

    // A row without a model ID has nothing to show as text, so its fields open.
    expect(screen.getByLabelText(`${en.modelAdvanced} 2`).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 2`).value).toBe('')
    expect(screen.getByLabelText(`${en.contextWindow} 2`)).toBeTruthy()
    expect(modelRow(1).textContent).toBe('kept')
    expect(modelRow(1).querySelector('input')).toBeNull()

    // Naming the model does not fold the row being typed in.
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'fresh' } })
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 2`).value).toBe('fresh')
  })

  it('closes the picker without adopting anything on cancel', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'fresh' }])))
    const { mutate } = await mountSection({ discover })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    const dialog = await screen.findByRole('dialog')
    // The editor card carries a Cancel of its own; this one is the dialog's.
    fireEvent.click(within_(dialog, en.cancel))

    await waitFor(() => { expect(screen.queryByText(en.fetchTitle)).toBeNull() })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('toggles a candidate off and back on before adopting', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([
      { id: 'a' }, { id: 'b', maxTokens: 2048 },
    ])))
    const { mutate } = await mountSection({ discover })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    await screen.findByText(en.fetchTitle)
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    const first = boxes[0] as HTMLInputElement
    fireEvent.click(first)
    fireEvent.click(first)
    fireEvent.click(screen.getByText(en.fetchAdopt))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    // A disclosed output cap rides along with the candidate that has one.
    expect(firstMutate(mutate).ops[0]?.value).toEqual([{ id: 'a' }, { id: 'b', maxTokens: 2048 }])
  })

  it('filters by model id or name and selects or deselects only visible candidates', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([
      { id: 'alpha' }, { id: 'opaque-id', name: 'Beta Display' }, { id: 'gamma' },
    ])))
    await mountSection({ discover })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    const dialog = await screen.findByRole('dialog')
    const search = screen.getByLabelText<HTMLInputElement>(en.fetchSearch)
    expect(dialog.textContent).toContain('opaque-id')
    expect(dialog.textContent).not.toContain('Beta Display')
    expect([...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .map(box => box.checked)).toEqual([true, true, true])

    fireEvent.change(search, { target: { value: 'ALP' } })
    expect(dialog.textContent).toContain('alpha')
    expect(dialog.textContent).not.toContain('opaque-id')

    fireEvent.change(search, { target: { value: 'beta' } })
    expect(dialog.textContent).toContain('opaque-id')
    expect(dialog.textContent).not.toContain('alpha')

    fireEvent.change(search, { target: { value: 'opaque' } })
    expect(dialog.textContent).toContain('opaque-id')
    expect(dialog.textContent).not.toContain('alpha')

    fireEvent.click(within_(dialog, en.fetchDeselectAll))
    expect([...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .map(box => box.checked)).toEqual([false])

    // Hidden candidates keep their state, so a configured model is never
    // removed unseen.
    fireEvent.change(search, { target: { value: '' } })
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.map(box => box.checked)).toEqual([true, false, true])
    fireEvent.click(within_(dialog, en.fetchSelectAll))
    expect(boxes.map(box => box.checked)).toEqual([true, true, true])
    fireEvent.click(within_(dialog, en.fetchDeselectAll))
    expect(boxes.map(box => box.checked)).toEqual([false, false, false])

    // Selecting while filtered adds only visible candidates.
    fireEvent.change(search, { target: { value: 'alpha' } })
    fireEvent.click(within_(dialog, en.fetchSelectAll))
    fireEvent.change(search, { target: { value: '' } })
    expect(boxes.map(box => box.checked)).toEqual([true, false, false])

    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText(en.fetchNoMatches)).toBeTruthy()
    expect((within_(dialog, en.fetchSelectAll) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('provider rows', () => {
  it('tags the routes the adapter declared, and only those', async () => {
    await mountSection({
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY' },
        'acme-gateway': { apiKeyEnv: 'ACME_GATEWAY_API_KEY', baseURL: 'https://acme.test/v1' },
      },
      declaredRoutes: ['acme-gateway'],
    })

    const rowOf = (provider: string): HTMLElement => {
      const row = screen.getByText(provider).closest('li')
      if (row === null) throw new Error(`no row for ${provider}`)
      return row
    }
    expect(rowOf('acme-gateway').textContent).toContain(en.customTag)
    // `openai` carries a stored profile too — the tag follows the adapter's
    // catalog, not the presence of settings, so it stays off here.
    expect(rowOf('openai').textContent).not.toContain(en.customTag)
  })

  it('shows no tag when the adapter draws no catalog distinction', async () => {
    const scripted = scriptedFace({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } })
    scripted.face.llm.listConfigurableProviders = vi.fn(() => Promise.resolve(ok([{
      provider: 'openai',
      displayName: 'openai',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
    }]))) as never
    const controller = new ModelsSettingsStore(
      ctxWith(scripted.face), settingsSchema, new SettingsDescribeMirror(ctxWith(scripted.face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(scripted.face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)

    // Absent is "unknown", never "shipped": an adapter that answers nothing
    // must not have its routes labelled either way.
    expect(screen.queryByText(en.customTag)).toBeNull()
  })
})

describe('hand-declared providers', () => {
  function mountCard(
    overrides: Partial<Parameters<typeof CustomProviderCard>[0]> = {},
    wire: Parameters<typeof scriptedFace>[0] = {},
  ) {
    const scripted = scriptedFace(wire)
    const onClose = vi.fn()
    render(
      <CustomProviderCard
        taken={['openai']}
        protocols={PROTOCOLS}
        reasoningLevels={LEVELS}
        revision={7}
        operations={operationsWith(scripted.face)}
        t={t}
        readOnly={false}
        onClose={onClose}
        {...overrides}
      />,
    )
    return { ...scripted, onClose }
  }

  it('creates a custom provider without changing the default model', async () => {
    const { face, mutate, set, onClose } = mountCard()
    const initialize = vi.spyOn(ctxWith(face).remote.session, 'initializeDefaultModel')
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.example/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'test-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'model' } })
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).toHaveBeenCalledOnce()
    expect(initialize).not.toHaveBeenCalled()
  })

  it('writes the whole profile and the key under the derived reference', async () => {
    const { mutate, set, onClose } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.customDisplayName), { target: { value: 'Acme Gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: '65536' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(firstMutate(mutate)).toEqual({
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'acme-gateway'],
        value: {
          displayName: 'Acme Gateway',
          apiKeyEnv: 'ACME_GATEWAY_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{ id: 'acme-large', contextWindow: 65_536 }],
        },
      }],
      // The section this card was drafted over: a route another tab declared
      // meanwhile makes this a conflict rather than an overwrite.
      expectedRevision: 7,
    })
    expect(set).toHaveBeenCalledWith('ACME_GATEWAY_API_KEY', 'gw-key')
  })

  it('scopes each card to fields a provider can actually own', async () => {
    // Reasoning effort is a per-MODEL capability and the
    // models under one provider disagree about it, so a provider-scoped
    // control could only be set to a value some of them reject — which would
    // take the whole provider out of the picker. The composer's model picker
    // owns the choice, and a switch there records provider+model+effort together.
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    // The two names of the route come first, then the protocol beside the
    // endpoint whose example it decides.
    expect(shownFields()).toEqual([en.customRoute, en.customDisplayName, en.customApi, en.baseUrl, en.keyInput])
    cleanup()

    // A shipped route's models each carry their own protocol, so its editor
    // offers no route-level protocol to override them with.
    await mountSection({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } })
    openEditor('openai')
    expect(shownFields()).toEqual([en.keyInput, en.baseUrl])
    cleanup()

    // A hand-declared route named its own protocol at creation, so editing it
    // reaches the same field the create card asked for.
    await mountSection({
      providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')
    expect(shownFields()).toEqual([en.keyInput, en.customDisplayName, en.baseUrl, en.customApi])
  })

  it('requires a key before a keyless declared route switches to the Gemini protocol', async () => {
    const { mutate, set } = await mountSection({
      providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test/v1beta' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'google-generative-ai' } })

    // A requirement still to meet reads as guidance until a save is refused for it.
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(screen.getByText(en.keyRequired).className).toMatch(/advancedHint/)
    expect(key.required).toBe(true)
    expect(key.getAttribute('aria-invalid')).toBe('false')
    expect(buttonNamed(en.apply).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.apply))
    expect(screen.getByText(en.keyRequired).className).toMatch(/error/)
    expect(key.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(key)
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()

    fireEvent.change(key, { target: { value: 'gemini-key' } })
    expect(screen.queryByText(en.keyRequired)).toBeNull()
    expect(key.getAttribute('aria-invalid')).toBe('false')
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledOnce() })
    expect(firstMutate(mutate).ops).toContainEqual(
      { op: 'set', path: ['providers', 'acme-gateway', 'apiKeyEnv'], value: 'ACME_GATEWAY_API_KEY' })
  })

  it('needs no typed key on a Gemini route that names its key reference', async () => {
    await mountSection({
      providers: { 'acme-gateway': { apiKeyEnv: 'ACME_KEY', api: 'google-generative-ai', baseURL: 'https://acme.test/v1beta' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')
    expect(screen.queryByText(en.keyRequired)).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).required).toBe(false)
  })

  it('refuses a protocol switch that the route\'s inherited reasoning levels would break', async () => {
    const { mutate } = await mountSection({
      providers: { 'acme-gateway': {
        apiKeyEnv: 'ACME_KEY', api: 'openai-completions', baseURL: 'https://acme.test/v1',
        models: [{ id: 'm', reasoningEfforts: { off: null, high: 'high' } }],
      } },
      userProviders: { 'acme-gateway': { apiKeyEnv: 'ACME_KEY', api: 'openai-completions', baseURL: 'https://acme.test/v1' } },
      baseProviders: { 'acme-gateway': { models: [{ id: 'm', reasoningEfforts: { off: null, high: 'high' } }] } },
      declaredRoutes: ['acme-gateway'],
    })
    openRow('acme-gateway')
    fireEvent.click(screen.getByRole('button', { name: en.customized }))
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'google-generative-ai' } })
    expect(buttonNamed(en.apply).disabled).toBe(false)
    expect(screen.getByLabelText(`${en.modelAdvanced} 1`).getAttribute('aria-expanded')).toBe('false')

    // The refused save unfolds the inherited row, whose reasoning control says what the protocol refuses.
    fireEvent.click(screen.getByText(en.apply))
    expect(screen.getByLabelText(`${en.modelAdvanced} 1`).getAttribute('aria-expanded')).toBe('true')
    expect(within(screen.getByRole('group', { name: `${en.modelReasoning} 1` })).getByText(en.modelReasoningLevelsOnly)).toBeTruthy()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('renames a declared route and falls back to its id when the name is cleared', async () => {
    const { mutate } = await mountSection({
      providers: {
        'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://acme.test/v1' },
      },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    const name = screen.getByLabelText<HTMLInputElement>(en.customDisplayName)
    expect(name.value).toBe('Acme Gateway')
    // The route id, not the stored name: it is what the route will be called
    // the moment the field is cleared.
    expect(name.placeholder).toBe('acme-gateway')
    fireEvent.change(name, { target: { value: 'Acme 网关' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops)
      .toEqual([{ op: 'set', path: ['providers', 'acme-gateway', 'displayName'], value: 'Acme 网关' }])
  })

  it('offers the composition name as what a cleared field falls back to', async () => {
    // A `cordis.yml` can pin a route the catalog does not ship, so a declared
    // route's profile is not always the page's own. The field edits the user
    // layer alone, and clearing it restores the layer beneath — the
    // composition name here, not the route id — so that is what it offers.
    await mountSection({
      providers: { 'acme-gateway': { displayName: 'Acme (pinned)', api: 'openai-completions' } },
      baseProviders: { 'acme-gateway': { displayName: 'Acme (pinned)', api: 'openai-completions' } },
      userProviders: {},
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    const name = screen.getByLabelText<HTMLInputElement>(en.customDisplayName)
    expect(name.value).toBe('')
    expect(name.placeholder).toBe('Acme (pinned)')
  })

  it('names the provider as the refreshed directory reports it after a rename', async () => {
    // A name can change after the card opens, so the saved status reads the
    // refreshed directory name rather than the target captured at open.
    const { face } = await mountSection({
      providers: { 'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions' } },
      declaredRoutes: ['acme-gateway'],
    })
    // The reload after the write answers with the renamed route, exactly as
    // the adapter re-registers it.
    face.llm.listConfigurableProviders = vi.fn(() => Promise.resolve(ok([{
      provider: 'acme-gateway',
      displayName: 'Acme 网关',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'acme-gateway'],
      declared: true,
    }])))
    openEditor('acme-gateway')

    fireEvent.change(screen.getByLabelText(en.customDisplayName), { target: { value: 'Acme 网关' } })
    fireEvent.click(screen.getByText(en.apply))

    const notice = await screen.findByRole('status')
    expect(notice.textContent).toBe(providerCopy(en.savedProvider, {
      provider: 'acme-gateway',
      displayName: 'Acme 网关',
    }))
  })

  it('drops the stored name rather than storing an empty one the adapter refuses', async () => {
    // `llm-pi-ai` rejects an empty displayName outright, so clearing the field
    // must unset it — which is also what the user means: use the route id.
    const { mutate } = await mountSection({
      providers: { 'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    fireEvent.change(screen.getByLabelText(en.customDisplayName), { target: { value: '   ' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops)
      .toEqual([{ op: 'unset', path: ['providers', 'acme-gateway', 'displayName'] }])
  })

  it('edits the protocol a declared route was created with', async () => {
    const { mutate } = await mountSection({
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{ id: 'acme-large' }],
        },
      },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    const protocol = screen.getByLabelText<HTMLSelectElement>(en.customApi)
    expect(protocol.value).toBe('openai-completions')
    fireEvent.change(protocol, { target: { value: 'anthropic-messages' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // Only the protocol travels: every other stored field is unchanged, so no
    // op restates it.
    expect(firstMutate(mutate)).toEqual({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'acme-gateway', 'api'], value: 'anthropic-messages' }],
      expectedRevision: 3,
    })
  })

  it('selects nothing for a declared route whose profile names no protocol', async () => {
    // A route hand-written into settings.yaml with no model needs no protocol
    // to resolve, so the card can be opened over one. The select must not read
    // as if that route had picked its first choice.
    await mountSection({
      providers: { 'acme-gateway': { baseURL: 'https://gateway.acme.example/v1' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    expect(screen.getByLabelText<HTMLSelectElement>(en.customApi).value).toBe('')
  })

  it.each([
    ['a hand-declared route', true],
    ['a catalog route', false],
  ])('refuses to save %s whose stored reasoning levels the adapter refuses', async (_label, declared) => {
    // The adapter refuses the same declarations on both kinds of route, and
    // both edit them, so a refused save unfolds the row, whose reasoning
    // control names the fault beside the switch that repairs it.
    const { mutate } = await mountSection({
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          models: [{ id: 'acme-large', reasoningEfforts: { off: null } }],
        },
      },
      declaredRoutes: declared ? ['acme-gateway'] : [],
    })
    openRow('acme-gateway')
    const toggle = screen.getByLabelText(`${en.modelAdvanced} 1`)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(buttonNamed(en.apply).disabled).toBe(false)

    fireEvent.click(screen.getByText(en.apply))

    // The row's four fields pass, so none is marked: its reasoning levels are the only fault.
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(within(screen.getByRole('group', { name: `${en.modelReasoning} 1` })).getByText(en.modelReasoningNeedsLevel)).toBeTruthy()
    expect(invalidFields()).toEqual([])
    expect(modelRow(1).hasAttribute('data-invalid')).toBe(false)
    expect(mutate).not.toHaveBeenCalled()

    // Turning the levels off repairs the row, and the same action then writes it.
    fireEvent.click(screen.getByRole('switch', { name: `${en.modelReasoning} 1` }))
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{
      op: 'set', path: ['providers', 'acme-gateway', 'models'], value: [{ id: 'acme-large' }],
    }])
  })

  it('retries only the key after the profile landed, and reports the provider on cancel', async () => {
    const set = vi.fn()
      .mockResolvedValueOnce(remoteFail('credential store is read-only'))
      .mockResolvedValueOnce(remoteOk(undefined))
    const { mutate, onClose } = mountCard({}, { set })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '  gw-key  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    // The profile landed; only the key failed. The card says so and stays open.
    await waitFor(() => { expect(screen.getByText('credential store is read-only')).toBeTruthy() })
    expect(onClose).not.toHaveBeenCalled()
    expect(mutate).toHaveBeenCalledTimes(1)
    // The key is stored trimmed, matching the editor.
    expect(set).toHaveBeenNthCalledWith(1, 'ACME_API_KEY', 'gw-key')

    // The provider exists now, so the fields describing it are settled and
    // only the key can still be corrected.
    expect(screen.getByLabelText<HTMLInputElement>(en.customRoute).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(false)

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key-2' } })
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    // Re-running the profile write would carry the revision this card's own
    // first write superseded, so the Host would answer settings-conflict and
    // the key could never be stored from here at all.
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenNthCalledWith(2, 'ACME_API_KEY', 'gw-key-2')
  })

  it('reports the created provider when cancelled after its profile landed', async () => {
    const set = vi.fn().mockResolvedValue(remoteFail('nope'))
    const { onClose } = mountCard({}, { set })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(screen.getByText('nope')).toBeTruthy() })

    // Walking away leaves a real provider behind; reporting no change would
    // leave the page without the row it now has.
    fireEvent.click(screen.getByText(en.cancel))
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('never contradicts a filled-in field when a create is refused for another one', () => {
    const { mutate } = mountCard()
    const routeField = screen.getByLabelText(en.customRoute)
    fireEvent.change(routeField, { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })

    // The route field explains itself right under the input, before and after
    // the refused create; the endpoint and the list, which are filled in, are
    // not reported.
    expect(screen.getByText(en.customRouteInvalid)).toBeTruthy()
    fireEvent.click(screen.getByText(en.create))
    expect(invalidFields()).toEqual([en.customRoute])
    expect(document.activeElement).toBe(routeField)
    expect(screen.queryByText(en.customNeedsBaseUrl)).toBeNull()
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    // Fixing the route leaves nothing reported.
    fireEvent.change(routeField, { target: { value: 'acme' } })
    expect(invalidFields()).toEqual([])
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(buttonNamed(en.create).disabled).toBe(false)
  })

  it('refuses a route id whose derived credential reference would be illegal', async () => {
    const { mutate, onClose } = mountCard()
    const routeField = screen.getByLabelText(en.customRoute)
    fireEvent.change(routeField, { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })

    // Without this check a digit-leading id passes the card and fails at the
    // credential seam with a raw regular expression: the
    // reference derives as `123_API_KEY`, and a credential reference is a
    // POSIX shell identifier, which cannot start with a digit.
    fireEvent.change(routeField, { target: { value: '123' } })
    expect(screen.getByText(en.customRouteInvalid)).toBeTruthy()
    expect(routeField.getAttribute('aria-invalid')).toBe('true')
    fireEvent.click(screen.getByText(en.create))
    expect(document.activeElement).toBe(routeField)
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.change(routeField, { target: { value: 'a1' } })
    expect(screen.queryByText(en.customRouteInvalid)).toBeNull()
    expect(routeField.getAttribute('aria-invalid')).toBe('false')
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(firstMutate(mutate).ops[0]?.path).toEqual(['providers', 'a1'])
  })

  it('refuses a route id another provider already uses', () => {
    const { mutate } = mountCard()
    const routeField = screen.getByLabelText(en.customRoute)
    fireEvent.change(routeField, { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })

    expect(screen.getByText(en.customRouteTaken)).toBeTruthy()
    expect(routeField.getAttribute('aria-invalid')).toBe('true')
    fireEvent.click(screen.getByText(en.create))
    expect(document.activeElement).toBe(routeField)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('styles a rejected route id as a fault and its guidance as a hint', () => {
    mountCard()
    const routeField = screen.getByLabelText(en.customRoute)
    // Same split the key field makes: what the user got wrong reads as a
    // fault, what they have yet to do reads as guidance.
    expect(screen.getByText(en.customRouteHint).className).toMatch(/advancedHint/)

    fireEvent.change(routeField, { target: { value: '2' } })
    expect(screen.getByText(en.customRouteInvalid).className).toMatch(/error/)

    fireEvent.change(routeField, { target: { value: 'openai' } })
    expect(screen.getByText(en.customRouteTaken).className).toMatch(/error/)
  })

  it.each(['not-a-url', 'localhost:11434', 'ftp://gateway.acme.example/v1'])(
    'rejects the non-HTTP base URL %j before discovery or creation', (baseURL) => {
      const { discover, mutate } = mountCard()
      fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
      fireEvent.click(screen.getByRole('button', { name: en.addModel }))
      fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
      fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: baseURL } })

      expect(screen.getByText(en.customBaseUrlInvalid)).toBeTruthy()
      expect(screen.getByLabelText(en.baseUrl).getAttribute('aria-invalid')).toBe('true')
      expect(buttonNamed(en.fetchModels).disabled).toBe(true)
      expect(buttonNamed(en.fetchModels).title).toBe(en.customBaseUrlInvalid)
      // The address is filled in, so a refused create adds no "needs an address" beside the syntax fault.
      fireEvent.click(screen.getByText(en.create))
      expect(invalidFields()).toEqual([en.baseUrl])
      expect(document.activeElement).toBe(screen.getByLabelText(en.baseUrl))
      expect(screen.queryByText(en.customNeedsBaseUrl)).toBeNull()
      expect(discover).not.toHaveBeenCalled()
      expect(mutate).not.toHaveBeenCalled()
    },
  )

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1',
    'https://gateway.acme.example:8443/v1',
  ])('allows the HTTP base URL %j to be interrogated', (baseURL) => {
    const { discover } = mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: baseURL } })

    expect(screen.queryByText(en.customBaseUrlInvalid)).toBeNull()
    expect(buttonNamed(en.fetchModels).disabled).toBe(false)
    expect(buttonNamed(en.create).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.fetchModels))
    expect(lastProbe(discover)).toMatchObject({ baseURL })
  })

  it('normalizes surrounding whitespace before interrogating and storing a base URL', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'm' }])))
    const { mutate, onClose } = mountCard({}, { discover })
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), {
      target: { value: '  https://gateway.acme.example/v1  ' },
    })

    expect(screen.queryByText(en.customBaseUrlInvalid)).toBeNull()
    fireEvent.click(screen.getByText(en.fetchModels))
    await waitFor(() => { expect(discover).toHaveBeenCalledTimes(1) })
    expect(lastProbe(discover)).toMatchObject({ baseURL: 'https://gateway.acme.example/v1' })

    fireEvent.click(await screen.findByText(en.fetchAdopt))
    await waitFor(() => { expect(buttonNamed(en.create).disabled).toBe(false) })
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(firstMutate(mutate).ops[0]?.value).toMatchObject({ baseURL: 'https://gateway.acme.example/v1' })
  })

  it('keeps a network failure distinct from base URL syntax', async () => {
    const discover = vi.fn(() => Promise.resolve(fail('connection refused', 'gateway/internal')))
    mountCard({}, { discover })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'http://localhost:11434/v1' } })
    fireEvent.click(screen.getByText(en.fetchModels))

    await screen.findByText('connection refused')
    expect(screen.queryByText(en.customBaseUrlInvalid)).toBeNull()
  })

  it('derives a reference the credential seam accepts for every id it admits', () => {
    // The two rules have to stay in step; this is the relation, checked
    // directly rather than through the DOM.
    const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
    for (const id of ['a', 'ds', 'a1', 'acme-gateway', 'x-1-y', 'zz9']) {
      expect(CREDENTIAL_REF.test(deriveKeyRef(id))).toBe(true)
    }
  })

  it('marks each unmet requirement on its own field when a create is refused, and nothing once it is met', async () => {
    const { mutate, set, onClose } = mountCard()
    const routeField = screen.getByLabelText(en.customRoute)
    const baseUrl = screen.getByLabelText(en.baseUrl)
    const models = screen.getByRole('region', { name: en.models })

    // An untouched card reports nothing and offers the action.
    expect(buttonNamed(en.create).disabled).toBe(false)
    expect(invalidFields()).toEqual([])
    expect(screen.getByText(en.customRouteHint)).toBeTruthy()

    fireEvent.click(screen.getByText(en.create))

    // A blank id is no valid id, so it is refused in the words of an invalid one.
    expect(routeField.closest('div')?.querySelector('p')?.textContent).toBe(en.customRouteInvalid)
    expect(screen.queryByText(en.customRouteHint)).toBeNull()
    expect(baseUrl.closest('div')?.querySelector('p')?.textContent).toBe(en.customNeedsBaseUrl)
    // The missing model is reported under the Models heading, above the rows.
    const needsModels = within(models).getByText(en.customNeedsModels)
    expect(needsModels.className).toMatch(/error/)
    expect(needsModels.compareDocumentPosition(within(models).getByRole('button', { name: en.addModel }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The key is optional on this protocol, so it is not among them.
    expect(invalidFields()).toEqual([en.customRoute, en.baseUrl])
    expect(document.activeElement).toBe(routeField)
    expect(footerOf(en.create).querySelector('p')).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    // Each mark goes when its own requirement is met, and the others stay.
    fireEvent.change(routeField, { target: { value: 'acme' } })
    expect(screen.queryByText(en.customRouteInvalid)).toBeNull()
    expect(screen.getByText(en.customRouteHint)).toBeTruthy()
    expect(invalidFields()).toEqual([en.baseUrl])
    expect(screen.getByText(en.customNeedsModels)).toBeTruthy()

    // An address of spaces alone is reported once, as no valid URL.
    fireEvent.change(baseUrl, { target: { value: '   ' } })
    expect([...baseUrl.closest('div')?.querySelectorAll('p') ?? []].map(reason => reason.textContent))
      .toEqual([en.customBaseUrlInvalid])

    fireEvent.change(baseUrl, { target: { value: 'https://acme.test/v1' } })
    expect(screen.queryByText(en.customNeedsBaseUrl)).toBeNull()
    expect(invalidFields()).toEqual([])
    expect(screen.getByText(en.customNeedsModels)).toBeTruthy()

    // The list has a row now. That the row has no id yet appeared after the
    // refused create, so it waits for the next one.
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(invalidFields()).toEqual([])
    expect(modelRow(1).hasAttribute('data-invalid')).toBe(false)

    fireEvent.click(screen.getByText(en.create))
    expect(markOf(`${en.modelId} 1`)).toBe(en.modelIdRequired)
    expect(invalidFields()).toEqual([`${en.modelId} 1`])
    expect(document.activeElement).toBe(screen.getByLabelText(`${en.modelId} 1`))
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    expect(invalidFields()).toEqual([])
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('keeps the required model list in view and says nothing about the missing model until a create is refused', () => {
    mountCard()

    // A provider cannot be created without a model, so the heading does not fold the list.
    const models = screen.getByRole('region', { name: en.models })
    expect(screen.queryByRole('button', { name: en.models })).toBeNull()
    expect(within(models).getByRole('button', { name: en.addModel })).toBeTruthy()
    expect(within(models).getByRole('button', { name: en.fetchModels })).toBeTruthy()

    // The empty list has no catalog to fall back on and no owner to restore.
    expect(models.querySelector('p')).toBeNull()
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
    expect(screen.queryByText(en.resetModels)).toBeNull()
  })

  it('refuses to create while a capacity is unreadable', () => {
    const { mutate } = mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: '64 KiB' } })

    expect(buttonNamed(en.create).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.create))
    expect(markOf(`${en.contextWindow} 1`)).toBe(en.modelContextInvalid)
    expect(invalidFields()).toEqual([`${en.contextWindow} 1`])
    expect(document.activeElement).toBe(screen.getByLabelText(`${en.contextWindow} 1`))
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps each half-typed capacity with its own row across a removal', () => {
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    for (const [at, id] of [[1, 'first'], [2, 'second'], [3, 'third']] as const) {
      fireEvent.click(screen.getByRole('button', { name: en.addModel }))
      fireEvent.change(screen.getByLabelText(`${en.modelId} ${String(at)}`), { target: { value: id } })
      expandModel(at)
      // Deliberately mid-word: the buffer exists so text like this survives.
      fireEvent.change(screen.getByLabelText(`${en.contextWindow} ${String(at)}`),
        { target: { value: `${String(at)}.` } })
    }

    // Removing the middle row: the one before keeps its position and text, the
    // one after moves down carrying its own, and the removed row's text goes.
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 2`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('first')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).value).toBe('1.')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 2`).value).toBe('third')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 2`).value).toBe('3.')
  })

  it('refuses two models sharing one id', async () => {
    const { mutate, onClose } = mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'same' } })
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'same' } })
    // Folded, the second row shows no field for a reason to sit under.
    fireEvent.click(screen.getByLabelText(`${en.modelAdvanced} 2`))

    // The adapter refuses a duplicate outright, so the form does not write
    // one: it unfolds the row that repeats the id and marks the field.
    fireEvent.click(screen.getByText(en.create))
    expect(markOf(`${en.modelId} 2`)).toBe(en.modelIdDuplicate)
    expect(invalidFields()).toEqual([`${en.modelId} 2`])
    expect(modelRow(2).hasAttribute('data-invalid')).toBe(true)
    expect(document.activeElement).toBe(screen.getByLabelText(`${en.modelId} 2`))
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'other' } })
    expect(invalidFields()).toEqual([])
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(firstMutate(mutate).ops[0]?.value).toMatchObject({ models: [{ id: 'same' }, { id: 'other' }] })
  })

  it('creates a model with no capacities, which the route\u2019s fallbacks size', async () => {
    const { mutate, onClose } = mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'bare' } })

    // A listing that discloses nothing but ids is enough to create a working
    // provider; the adapter sizes what configuration leaves out.
    expect(buttonNamed(en.create).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(firstMutate(mutate).ops[0]?.value).toMatchObject({ models: [{ id: 'bare' }] })
  })

  it('refuses to create until the route, endpoint, and a model are usable', async () => {
    const { mutate, onClose } = mountCard()
    const create = (): void => { fireEvent.click(screen.getByText(en.create)) }

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'Acme Gateway' } })
    expect(screen.getByText(en.customRouteInvalid)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'openai' } })
    expect(screen.getByText(en.customRouteTaken)).toBeTruthy()

    // Each requirement is named only by the create it stops.
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    expect(screen.queryByText(en.customNeedsBaseUrl)).toBeNull()
    create()
    expect(screen.getByText(en.customNeedsBaseUrl)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText(en.baseUrl))
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    expect(screen.getByText(en.customNeedsModels)).toBeTruthy()
    create()
    expect(screen.getByText(en.customNeedsModels)).toBeTruthy()
    // The list has no field of its own to take the keyboard.
    expect(invalidFields()).toEqual([])

    // A model row with no id is not a model.
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    create()
    expect(markOf(`${en.modelId} 1`)).toBe(en.modelIdRequired)
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    create()
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('surfaces a refused write without closing', async () => {
    const refused = vi.fn(() => Promise.resolve(remoteFail('read-only settings', 'settings/rejected')))
    const { onClose } = mountCard({ operations: operationsWith(scriptedFace({ mutate: refused }).face) })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await screen.findByText('read-only settings')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('translates a create refused by a newer namespace revision', async () => {
    const conflicting = vi.fn(() => Promise.resolve(remoteFail('changed since it was read', 'settings/conflict')))
    const { onClose } = mountCard({ operations: operationsWith(scriptedFace({ mutate: conflicting }).face) })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await screen.findByText(en.conflict)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reports a stored profile whose key write was refused', async () => {
    const set = vi.fn(() => Promise.resolve(remoteFail('credential is read-only')))
    const { onClose } = mountCard({ operations: operationsWith(scriptedFace({ set }).face) })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'k' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await screen.findByText('credential is read-only')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('creates with the chosen protocol and no display name', async () => {
    const { mutate, onClose } = mountCard()
    const baseUrl = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    const protocol = screen.getByLabelText(en.customApi)

    expect(baseUrl.placeholder).toBe('https://gateway.example/v1')
    fireEvent.change(protocol, { target: { value: 'openai-responses' } })
    expect(baseUrl.placeholder).toBe('https://gateway.example/v1')
    fireEvent.change(protocol, { target: { value: 'google-generative-ai' } })
    expect(baseUrl.placeholder).toBe('https://gateway.example/v1beta')

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(baseUrl, { target: { value: 'https://acme.test/anthropic' } })
    fireEvent.change(protocol, { target: { value: 'anthropic-messages' } })
    expect(baseUrl.placeholder).toBe('https://gateway.example')
    expect(baseUrl.value).toBe('https://acme.test/anthropic')
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    // No display name configured means none stored; the route id is the name.
    // No key typed means no reference either, matching the editor: the route
    // keeps its provider-native auth path instead of resolving a reference
    // nothing ever sets. The with-key case is covered above.
    expect(firstMutate(mutate).ops[0]?.value).toEqual({
      api: 'anthropic-messages',
      baseURL: 'https://acme.test/anthropic',
      models: [{ id: 'm' }],
    })
  })

  it('offers no protocol when the namespace declares none', () => {
    mountCard({ protocols: [] })
    expect(screen.getByLabelText<HTMLSelectElement>(en.customApi).value).toBe('')
  })

  it('closes without writing on cancel, and honors a read-only deployment', () => {
    const { onClose, mutate } = mountCard()
    fireEvent.click(screen.getByText(en.cancel))
    expect(onClose).toHaveBeenCalledWith(false)
    expect(mutate).not.toHaveBeenCalled()
    cleanup()

    mountCard({ readOnly: true })
    expect(screen.getByLabelText<HTMLInputElement>(en.customRoute).disabled).toBe(true)
    expect(buttonNamed(en.create).disabled).toBe(true)
  })

  it('closes the add card when an existing row is opened for editing', async () => {
    await mountSection({ providers: { openai: { baseURL: 'https://proxy.example/v1' } } })

    openCustomMode()
    expect(screen.getByRole('textbox', { name: en.customRoute })).toBeTruthy()

    // Two cards at once would each be closable by the other: whichever one is
    // dismissed clears the shared state and discards the other's draft.
    openEditor('openai')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('textbox', { name: en.customRoute })).toBeNull()
  })

  it('reaches the custom form from the section and returns to the button on cancel', async () => {
    await mountSection()

    openCustomMode()
    expect(screen.getByRole('textbox', { name: en.customRoute })).toBeTruthy()

    fireEvent.click(screen.getByText(en.cancel))
    await waitFor(() => { expect(screen.queryByRole('textbox', { name: en.customRoute })).toBeNull() })
    expect(screen.getByRole('button', { name: en.add })).toBeTruthy()
  })

  it('names each protocol by its product name and falls back to the identifier of an unknown one', () => {
    mountCard({ protocols: [...PROTOCOLS, 'future-protocol'] })
    const protocol = screen.getByLabelText<HTMLSelectElement>(en.customApi)
    const labels = [...protocol.options].map(option => [option.value, option.textContent])
    expect(labels).toEqual([
      ['openai-completions', en.protocolOpenAiCompletions],
      ['openai-responses', en.protocolOpenAiResponses],
      ['anthropic-messages', en.protocolAnthropicMessages],
      ['google-generative-ai', en.protocolGemini],
      ['future-protocol', 'future-protocol'],
    ])
  })

  it('requires a key for the Gemini protocol, which cannot authenticate without one', async () => {
    const { mutate, set, onClose } = mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'gemini-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.example/v1beta' } })
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'google-generative-ai' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'gemini-pro' } })

    // A requirement still to meet reads as guidance; the create it stops turns it into a fault on the field.
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(screen.getByText(en.keyRequired).className).toMatch(/advancedHint/)
    expect(key.required).toBe(true)
    expect(key.getAttribute('aria-invalid')).toBe('false')
    expect(buttonNamed(en.create).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.create))
    expect(screen.getByText(en.keyRequired).className).toMatch(/error/)
    expect(invalidFields()).toEqual([en.keyInput])
    expect(document.activeElement).toBe(key)
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.change(key, { target: { value: 'gemini-key' } })
    expect(screen.queryByText(en.keyRequired)).toBeNull()
    expect(invalidFields()).toEqual([])
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(firstMutate(mutate).ops[0]?.value).toMatchObject({ api: 'google-generative-ai', apiKeyEnv: 'GEMINI_GATEWAY_API_KEY' })
    expect(set).toHaveBeenCalledOnce()
  })

  it('treats a whitespace key as missing on the Gemini protocol', () => {
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'google-generative-ai' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '   ' } })
    expect(screen.getByText(en.keyRequired).className).toMatch(/advancedHint/)
    expect(screen.queryByText(en.keyBlankNew)).toBeNull()
    expect(screen.getByLabelText(en.keyInput).getAttribute('aria-invalid')).toBe('false')
  })

  it('offers a Gemini model only the levels the protocol accepts', () => {
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'google-generative-ai' } })
    // The row just added is unfolded, so its reasoning control is on the page.
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.click(screen.getByRole('switch', { name: `${en.modelReasoning} 1` }))

    const level = screen.getByRole<HTMLSelectElement>('combobox', { name: `${en.modelReasoningLevel} 1` })
    expect(level.value).toBe('low')
    expect([...level.options].map(option => option.value)).toEqual(['minimal', 'low'])
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: `low ${en.modelReasoningValue}` }).disabled).toBe(true)
  })

  it('refuses an unusable key on the field and blocks creation', () => {
    const { mutate, set } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })

    // A hand-declared route reaches the same judgement as an edited one, so a
    // key that no header can carry never becomes a profile plus a bad secret.
    // The fault is on the field as soon as it is typed.
    const key = screen.getByLabelText(en.keyInput)
    expect(screen.getByText(en.keyIllegalCharacters).className).toMatch(/error/)
    expect(key.getAttribute('aria-invalid')).toBe('true')
    expect(buttonNamed(en.create).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.create))
    expect(document.activeElement).toBe(key)
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('stays silent about the other requirements when only the key is refused', () => {
    mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })
    fireEvent.click(screen.getByText(en.create))

    // Route, endpoint, and models are all satisfied, so reporting one of
    // them would print a second, false fault beside the real one.
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(invalidFields()).toEqual([en.keyInput])
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(screen.queryByText(en.customNeedsBaseUrl)).toBeNull()
    expect(screen.queryByText(en.customRouteInvalid)).toBeNull()
  })

  it('tells a whitespace-only key what a blank field means on a create card', () => {
    const { mutate } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '   ' } })

    // There is no stored key to keep here, so the blank case says the thing
    // that is true of a route being declared: it may authenticate elsewhere.
    expect(screen.getByText(en.keyBlankNew).className).toMatch(/error/)
    expect(screen.queryByText(en.keyBlank)).toBeNull()
    expect(buttonNamed(en.fetchModels).title).toBe(en.keyBlankNew)
    expect(buttonNamed(en.create).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.create))
    expect(invalidFields()).toEqual([en.keyInput])
    expect(document.activeElement).toBe(screen.getByLabelText(en.keyInput))
    expect(mutate).not.toHaveBeenCalled()
  })

  it('creates without a key when the route authenticates some other way', async () => {
    const { set, onClose } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'ambient-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(set).not.toHaveBeenCalled()
  })
})

describe('API key field', () => {
  it('submits with a blank key field without writing a credential', async () => {
    const { mutate, set } = await mountSection()
    openEditor('openai')

    // The field opens empty even for a provider whose key is stored, where it
    // means "keep that one" — so editing anything else must not require it.
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://moved.example/v1' } })
    expect(buttonNamed(en.apply).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(set).not.toHaveBeenCalled()
  })

  it('clears a whitespace-only base URL instead of writing the spaces', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    // The field renders this as empty, so the draft must agree: storing the
    // spaces would hand both adapters a non-empty string they accept as a URL.
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: '   ' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    const ops = firstMutate(mutate).ops
    expect(ops.some(op => op.op === 'set' && op.path.includes('baseURL'))).toBe(false)
    expect(ops.some(op => op.op === 'unset' && op.path.includes('baseURL'))).toBe(true)
  })

  /** Press Apply on a card whose key field already names a fault, and expect the save refused on that field. */
  function expectKeyRefused(wire: { mutate: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }): void {
    const key = screen.getByLabelText(en.keyInput)
    expect(key.getAttribute('aria-invalid')).toBe('true')
    expect(buttonNamed(en.apply).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.apply))
    expect(invalidFields()).toEqual([en.keyInput])
    expect(document.activeElement).toBe(key)
    expect(wire.mutate).not.toHaveBeenCalled()
    expect(wire.set).not.toHaveBeenCalled()
  }

  it('refuses the save and names the field when the key holds only whitespace', async () => {
    const wire = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '   ' } })

    expect(screen.getByText(en.keyBlank)).toBeTruthy()
    expectKeyRefused(wire)
  })

  it('refuses the save when the key contains characters no header can carry', async () => {
    const wire = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })

    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expectKeyRefused(wire)
  })

  it('refuses the save when a whole NAME=value line was pasted', async () => {
    const wire = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'OPENAI_API_KEY=sk-abc' } })

    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expectKeyRefused(wire)
  })

  it('trims a padded key before storing it', async () => {
    const { set } = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '  sk-abc  ' } })
    expect(buttonNamed(en.apply).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(set).toHaveBeenCalled() })
    expect(set.mock.calls[0]?.[1]).toBe('sk-abc')
  })

  it('blocks the interrogation too, rather than spending a round trip on a refused key', async () => {
    const { discover } = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })

    // The host would refuse this before building the header anyway; asking is
    // a round trip to be told what the field already says.
    expect(buttonNamed(en.fetchModels).disabled).toBe(true)
    expect(buttonNamed(en.fetchModels).title).toBe(en.keyIllegalCharacters)
    expect(discover).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', { provider: 'openai' })
  })

  it('carries the trimmed key into an interrogation, not the padded draft', async () => {
    const { discover } = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '  sk-abc  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))

    await waitFor(() => { expect(discover).toHaveBeenCalled() })
    expect(lastProbe(discover)).toMatchObject({ apiKey: 'sk-abc' })
  })

  it('reloads the section after creating a hand-declared provider', async () => {
    const { controller, mutate } = await mountSection()
    const load = vi.spyOn(controller, 'load')

    openCustomMode()
    fireEvent.change(screen.getByRole('textbox', { name: en.customRoute }), { target: { value: 'acme' } })
    fireEvent.change(screen.getByRole('textbox', { name: en.baseUrl }), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('textbox', { name: en.customRoute })).toBeNull()
  })
})
