// @vitest-environment jsdom
/** Provider retry-policy fields of the Models editor card. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

// The `retryPolicy` schema both adapters embed (`RetryPolicySchema` in dsh-llm).
const backoff = Schema.object({
  initialDelayMs: Schema.number().max(2_147_483_647).default(500),
  maxDelayMs: Schema.number().max(2_147_483_647).default(10_000),
  jitterRatio: Schema.number().min(0).max(1).default(0.1),
})
const RetryPolicy = Schema.union([
  Schema.object({
    mode: Schema.const('normal').required(),
    maxRetries: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(5),
    retryableCodes: Schema.array(Schema.string()).default(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
    backoff,
  }),
  Schema.object({ mode: Schema.const('always').required(), backoff }),
])

const json = (schema: Schema): JsonValue => JSON.parse(JSON.stringify(schema.toJSON())) as JsonValue

function deepSeekNamespace(layers: { base?: JsonValue; user?: JsonValue } = {}): SettingsNamespaceView {
  return {
    ns: 'llm-deepseek',
    schema: json(Schema.object({
      baseURL: Schema.string(),
      models: Schema.array(Schema.object({ id: Schema.string() })),
      retryPolicy: RetryPolicy,
    })),
    value: { models: [{ id: 'deepseek-v4-flash' }] },
    base: layers.base ?? {},
    user: layers.user ?? {},
    autoGenerate: true, applies: 'live', secrets: [], revision: 3,
  }
}

function piAiNamespace(): SettingsNamespaceView {
  const providers = { openai: { apiKeyEnv: 'OPENAI_API_KEY' } }
  return {
    ns: 'llm-pi-ai',
    schema: json(Schema.object({ providers: Schema.dict(Schema.object({ apiKeyEnv: Schema.string(), retryPolicy: RetryPolicy })) })),
    value: { providers }, user: { providers },
    autoGenerate: true, applies: 'live', secrets: [], revision: 0,
  }
}

function setup(namespace: SettingsNamespaceView, settingsPath: string[] = []) {
  const writeSettings = vi.fn<ModelsOperations['writeSettings']>(() => Promise.resolve({ kind: 'written', view: namespace }))
  const operations: ModelsOperations = {
    storeCredential: vi.fn(() => Promise.resolve(undefined)),
    removeCredential: vi.fn(() => Promise.resolve(undefined)),
    writeSettings,
    discoverModels: vi.fn<ModelsOperations['discoverModels']>(() => Promise.resolve({ kind: 'found', models: [] })),
  }
  const onClose = vi.fn()
  render(<ProviderEditor provider="route" displayName="Route" namespace={namespace} schema={settingsSchema}
    settingsPath={settingsPath} operations={operations} t={key => en[key]} readOnly={false} onClose={onClose} />)
  return { writeSettings, onClose }
}

const mode = () => screen.getByRole<HTMLSelectElement>('combobox', { name: en.retryPolicy })
const input = (label: string) => screen.getByLabelText<HTMLInputElement>(label)
const CODE_LABELS: Record<string, string> = {
  EMPTY_RESPONSE: en.retryCodeEmptyResponse,
  RATE_LIMIT: en.retryCodeRateLimit,
  SERVER: en.retryCodeServer,
  TIMEOUT: en.retryCodeTimeout,
  TRANSPORT: en.retryCodeTransport,
  STREAM_CLOSED: en.retryCodeStreamClosed,
}
const code_ = (code: string) => screen.getByRole<HTMLInputElement>('checkbox', { name: CODE_LABELS[code] ?? code })
const apply = () => screen.getByText<HTMLButtonElement>(en.apply)

describe('retry policy fields', () => {
  it('inherits by default and writes an explicitly chosen normal policy', async () => {
    const { writeSettings, onClose } = setup(deepSeekNamespace())
    expect(mode().value).toBe('')
    expect(mode().selectedOptions[0]?.textContent).toBe(`Default (${en.retryModeNormal})`)
    expect(screen.queryByLabelText(en.retryMaxRetries)).toBeNull()

    fireEvent.change(mode(), { target: { value: 'normal' } })
    expect(input(en.retryMaxRetries).placeholder).toBe('5')
    expect(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'].every(code => code_(code).checked)).toBe(true)
    expect(code_('STREAM_CLOSED').checked).toBe(false)
    expect(input(en.retryInitialDelay).placeholder).toBe('500')
    expect(input(en.retryMaxDelay).placeholder).toBe('10000')
    expect(input(en.retryJitter).placeholder).toBe('0.1')

    fireEvent.change(input(en.retryMaxRetries), { target: { value: '3' } })
    for (const code of ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT']) fireEvent.click(code_(code))
    fireEvent.change(input(en.retryJitter), { target: { value: '0.' } })
    expect(input(en.retryJitter).value).toBe('0.')
    fireEvent.change(input(en.retryJitter), { target: { value: '0.25' } })
    fireEvent.click(apply())

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(writeSettings).toHaveBeenCalledWith('llm-deepseek', [
      { op: 'set', path: ['retryPolicy', 'mode'], value: 'normal' },
      { op: 'set', path: ['retryPolicy', 'maxRetries'], value: 3 },
      { op: 'set', path: ['retryPolicy', 'retryableCodes'], value: ['RATE_LIMIT', 'SERVER'] },
      { op: 'set', path: ['retryPolicy', 'backoff', 'jitterRatio'], value: 0.25 },
    ], 3)
  })

  const delayInvalid = en.retryDelayInvalid.replace('{max}', '2147483647')
  it.each([
    [en.retryMaxRetries, '-1', en.retryMaxRetriesInvalid],
    [en.retryMaxRetries, '1.5', en.retryMaxRetriesInvalid],
    [en.retryMaxRetries, 'many', en.retryMaxRetriesInvalid],
    [en.retryInitialDelay, '0', delayInvalid],
    [en.retryInitialDelay, '0x10', delayInvalid],
    [en.retryMaxDelay, '3000000000', delayInvalid],
    [en.retryInitialDelay, '20000', en.retryDelayOrder],
    [en.retryJitter, '2', en.retryJitterInvalid],
  ])('refuses %s = %s', (label, value, message) => {
    setup(deepSeekNamespace())
    fireEvent.change(mode(), { target: { value: 'normal' } })
    fireEvent.change(input(label), { target: { value } })
    expect(screen.getByText(message)).toBeTruthy()
    expect(input(label).getAttribute('aria-invalid')).toBe('true')
    expect(input(label).getAttribute('aria-describedby')).toBe('route-retry-failure')
    const other = label === en.retryJitter ? en.retryMaxRetries : en.retryJitter
    expect(input(other).getAttribute('aria-invalid')).toBe('false')
    expect(apply().disabled).toBe(true)
    fireEvent.change(input(label), { target: { value: '' } })
    expect(screen.queryByText(message)).toBeNull()
    expect(apply().disabled).toBe(false)
  })

  it('explains a refused stored policy beside the fields, or outside the fold while it is closed', async () => {
    setup(deepSeekNamespace({ user: { retryPolicy: { mode: 'sometimes' } } }))
    expect(apply().disabled).toBe(true)
    expect(mode().getAttribute('aria-describedby')).toBe('route-retry-failure')
    expect(document.getElementById('route-retry-failure')?.closest('details')).toBeNull()
    fireEvent.click(screen.getByText(en.customized))
    await waitFor(() => { expect(document.getElementById('route-retry-failure')?.closest('details')).not.toBeNull() })
  })

  it.each([
    ['the inherited mode', { mode: 'always' }, 'always'],
    ['normal mode when nothing is inherited', undefined, 'normal'],
  ])('names %s for a stored policy without a mode', async (_name, inherited, expected) => {
    const { writeSettings } = setup(deepSeekNamespace({
      ...inherited === undefined ? {} : { base: { retryPolicy: inherited } },
      user: { retryPolicy: { backoff: { maxDelayMs: 2_000 } } },
    }))
    expect(mode().value).toBe(expected)
    expect(input(en.retryMaxDelay).value).toBe('2000')
    fireEvent.click(apply())
    await waitFor(() => { expect(writeSettings).toHaveBeenCalled() })
    expect(writeSettings.mock.calls[0]?.[1]).toEqual([{ op: 'set', path: ['retryPolicy', 'mode'], value: expected }])
  })

  it('removes a stored policy without a mode when Default is chosen', async () => {
    const { writeSettings } = setup(deepSeekNamespace({ user: { retryPolicy: { backoff: { maxDelayMs: 2_000 } } } }))
    fireEvent.change(mode(), { target: { value: '' } })
    fireEvent.click(apply())
    await waitFor(() => { expect(writeSettings).toHaveBeenCalled() })
    expect(writeSettings.mock.calls[0]?.[1]).toEqual([{ op: 'unset', path: ['retryPolicy'] }])
  })

  it('unsets a cleared field so the inherited value applies again', async () => {
    const { writeSettings } = setup(deepSeekNamespace({
      base: { retryPolicy: { mode: 'normal', maxRetries: 7 } },
      user: { retryPolicy: { mode: 'normal', maxRetries: 1 } },
    }))
    fireEvent.change(input(en.retryMaxRetries), { target: { value: '' } })
    expect(input(en.retryMaxRetries).placeholder).toBe('7')
    fireEvent.click(apply())
    await waitFor(() => { expect(writeSettings).toHaveBeenCalled() })
    expect(writeSettings.mock.calls[0]?.[1]).toEqual([{ op: 'unset', path: ['retryPolicy', 'maxRetries'] }])
  })

  it.each([
    ['an empty code list', [], en.retryCodesInvalid],
    ['a blank code', [''], en.retryCodesInvalid],
    ['a numeric code', [500], en.retryCodesInvalid],
    ['a repeated code', ['SERVER', 'SERVER'], en.retryCodesDuplicate],
  ])('refuses a stored policy with %s', (_name, codes, message) => {
    setup(deepSeekNamespace({ user: { retryPolicy: { mode: 'normal', retryableCodes: codes } } }))
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByRole('group', { name: en.retryCodes }).getAttribute('aria-invalid')).toBe('true')
    expect(apply().disabled).toBe(true)
  })

  it('picks codes from a list, keeps stored custom codes, and inherits an unchanged selection', async () => {
    const { writeSettings } = setup(deepSeekNamespace({
      base: { retryPolicy: { mode: 'normal', retryableCodes: ['SERVER', 'CUSTOM'] } },
      user: { retryPolicy: { mode: 'normal' } },
    }))
    expect(code_('CUSTOM').checked).toBe(true)
    expect(code_('RATE_LIMIT').checked).toBe(false)
    fireEvent.click(code_('CUSTOM'))
    expect(code_('SERVER').disabled).toBe(true)
    fireEvent.click(code_('STREAM_CLOSED'))
    fireEvent.click(code_('STREAM_CLOSED'))
    fireEvent.click(code_('CUSTOM'))
    expect(apply().disabled).toBe(false)
    fireEvent.click(code_('RATE_LIMIT'))
    fireEvent.click(apply())
    await waitFor(() => { expect(writeSettings).toHaveBeenCalled() })
    expect(writeSettings.mock.calls[0]?.[1]).toEqual([
      { op: 'set', path: ['retryPolicy', 'retryableCodes'], value: ['RATE_LIMIT', 'SERVER', 'CUSTOM'] },
    ])
  })

  it('refuses a stored policy that is not an object', () => {
    setup(deepSeekNamespace({ user: { retryPolicy: 'sometimes' } }))
    expect(mode().value).toBe('')
    expect(apply().disabled).toBe(true)
  })

  it('treats a stored null policy as inheriting', () => {
    setup(deepSeekNamespace({ user: { retryPolicy: null } }))
    expect(mode().value).toBe('')
    expect(apply().disabled).toBe(false)
  })

  it('offers no retry fields on a namespace without a curated editor', () => {
    const namespace = deepSeekNamespace({ user: { retryPolicy: { mode: 'sometimes' } } })
    setup({ ...namespace, ns: 'llm-plain' })
    expect(screen.queryByRole('group', { name: en.retryPolicy })).toBeNull()
    expect(document.getElementById('route-retry-failure')).toBeNull()
  })

  it('drops an uncorrectable retry count when switching to always', async () => {
    const { writeSettings } = setup(deepSeekNamespace())
    fireEvent.change(mode(), { target: { value: 'normal' } })
    fireEvent.change(input(en.retryMaxRetries), { target: { value: 'many' } })
    fireEvent.change(input(en.retryJitter), { target: { value: '  ' } })
    expect(input(en.retryJitter).value).toBe('')
    fireEvent.change(mode(), { target: { value: 'always' } })
    expect(apply().disabled).toBe(false)
    fireEvent.click(apply())
    await waitFor(() => { expect(writeSettings).toHaveBeenCalled() })
    expect(writeSettings.mock.calls[0]?.[1]).toEqual([{ op: 'set', path: ['retryPolicy', 'mode'], value: 'always' }])
  })

  it('shows inherited values and removes the user policy when Default is chosen', async () => {
    const { writeSettings } = setup(deepSeekNamespace({
      base: { retryPolicy: { mode: 'always', backoff: { maxDelayMs: 2_000 } } },
      user: { retryPolicy: { mode: 'normal', maxRetries: 1 } },
    }))
    expect(mode().value).toBe('normal')
    expect(input(en.retryMaxRetries).value).toBe('1')
    expect(input(en.retryMaxDelay).placeholder).toBe('2000')
    expect(screen.getByRole('option', { name: `Default (${en.retryModeAlways})` })).toBeTruthy()

    fireEvent.change(mode(), { target: { value: 'always' } })
    expect(screen.getByText(en.retryAlwaysHint)).toBeTruthy()
    expect(screen.queryByLabelText(en.retryMaxRetries)).toBeNull()

    fireEvent.change(mode(), { target: { value: '' } })
    expect(screen.queryByLabelText(en.retryMaxDelay)).toBeNull()
    fireEvent.click(apply())
    await waitFor(() => { expect(writeSettings).toHaveBeenCalled() })
    expect(writeSettings.mock.calls[0]?.[1]).toEqual([{ op: 'unset', path: ['retryPolicy'] }])
  })

  it('writes a pi-ai route policy under its profile path', async () => {
    const { writeSettings } = setup(piAiNamespace(), ['providers', 'openai'])
    fireEvent.change(mode(), { target: { value: 'always' } })
    fireEvent.change(input(en.retryInitialDelay), { target: { value: '250' } })
    fireEvent.change(input(en.retryInitialDelay), { target: { value: '' } })
    fireEvent.click(apply())
    await waitFor(() => { expect(writeSettings).toHaveBeenCalled() })
    expect(writeSettings.mock.calls[0]?.[1]).toEqual([
      { op: 'set', path: ['providers', 'openai', 'retryPolicy', 'mode'], value: 'always' },
    ])
  })

  it('leaves placeholders empty when the schema declares no normal mode', () => {
    const namespace = deepSeekNamespace()
    const always = Schema.union([Schema.object({ mode: Schema.const('always').required() })])
    setup({ ...namespace, schema: json(Schema.object({ retryPolicy: always })) })
    fireEvent.change(mode(), { target: { value: 'always' } })
    expect(input(en.retryMaxDelay).placeholder).toBe('')
    fireEvent.change(mode(), { target: { value: 'normal' } })
    expect(code_('SERVER').checked).toBe(false)
  })

  it('renders no retry fields when the namespace schema has no retry policy', () => {
    const namespace = deepSeekNamespace()
    setup({ ...namespace, schema: json(Schema.object({ baseURL: Schema.string() })) })
    expect(screen.queryByRole('group', { name: en.retryPolicy })).toBeNull()
  })
})
