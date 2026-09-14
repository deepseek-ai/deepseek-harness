// @vitest-environment jsdom
/** First-run DeepSeek prompt behavior over the shared Models join. */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { DeepSeekOnboardingDialog } from '../src/client/DeepSeekOnboardingDialog.tsx'
import type { DeepSeekOnboardingDialogProps } from '../src/client/DeepSeekOnboardingDialog.tsx'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

/** Credentials answers over the Remote carrier, which has no envelope. */
function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}
function remoteFail(message: string) {
  return { ok: false as const, error: new RemoteError('gateway/internal', message, {}) }
}

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
  })),
})

type AttentionSnapshot = Parameters<Parameters<DeepSeekOnboardingDialogProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: DeepSeekOnboardingDialogProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function deepSeekNamespace(apiKeyEnv: string | null): SettingsNamespaceView {
  const value = apiKeyEnv === null ? {} : { apiKeyEnv }
  return {
    ns: 'llm-deepseek',
    schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
    value,
    base: value,
    user: {},
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function harness(options: {
  provider?: boolean
  providerSettingsNs?: string
  providerActive?: boolean
  settingsNamespace?: boolean
  apiKeyEnv?: string | null
  configured?: () => boolean
  credential?: { source?: string; writable: boolean }
  describeFailure?: string
  settingsWritable?: boolean
  providersFailure?: string
  setFailure?: string
} = {}) {
  if (document.getElementById('root') === null) {
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
  }
  let fileConfigured = false
  const configured = options.configured ?? (() => fileConfigured)
  const apiKeyEnv = options.apiKeyEnv === undefined ? 'DEEPSEEK_API_KEY' : options.apiKeyEnv
  const mutate = vi.fn(() => Promise.resolve(remoteOk(deepSeekNamespace(apiKeyEnv))))
  const set = vi.fn((_ref: string, _value: string) => {
    if (options.setFailure !== undefined) return Promise.resolve(remoteFail(options.setFailure))
    fileConfigured = true
    return Promise.resolve(remoteOk(undefined))
  })
  const face = {
    llm: {
      listProviders: () => {
        if (options.providersFailure !== undefined) return Promise.resolve(remoteFail(options.providersFailure))
        return Promise.resolve(remoteOk(
          options.provider === false || options.providerActive === false
            ? []
            : [{ id: 'deepseek-official', name: 'DeepSeek' }],
        ))
      },
      listConfigurableProviders: () => Promise.resolve(remoteOk(
        options.provider === false
          ? []
          : [{
            provider: 'deepseek-official',
            displayName: 'DeepSeek',
            settingsNs: options.providerSettingsNs ?? 'llm-deepseek',
            settingsPath: [],
          }],
      )),
      discoverModels: () => Promise.resolve(remoteOk([])),
    },
    settings: {
      describe: () => Promise.resolve(remoteOk({
        writable: options.settingsWritable ?? true,
        hasDocument: false,
        namespaces: options.settingsNamespace === false ? [] : [deepSeekNamespace(apiKeyEnv)],
      })),
      mutate,
    },
    credentials: {
      describe: () => options.describeFailure === undefined
        ? Promise.resolve(remoteOk({
          DEEPSEEK_API_KEY: {
            configured: configured(),
            ...configured() && options.credential?.source !== undefined
              ? { source: options.credential.source }
              : {},
            writable: options.credential?.writable ?? true,
          },
        }))
        : Promise.resolve(remoteFail(options.describeFailure)),
      set,
    },
  }
  // The page plugin's context, scripted down to the namespaces it reaches.
  const ctx = { remote: face } as never
  const operations = createModelsOperations(ctx)
  const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
  const openSection = vi.fn()
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: DeepSeekOnboardingDialogProps = {
    stepId: 'deepseek-official',
    complete,
    openSection,
    useSessions: unusedHook,
    useSessionPendingInteraction,
    usePanelInfo, useResource,
    useWorkspaces: unusedHook,
    controller,
    useModels: bindSnapshotSelector(controller.store),
    operations,
    schema: settingsSchema,
    t: key => en[key],
  }
  return {
    controller, complete, openSection, props, mutate, set,
    configure: () => { fileConfigured = true },
  }
}

describe('DeepSeekOnboardingDialog', () => {
  it('renders when the shell root is absent', async () => {
    const h = harness()
    document.getElementById('root')!.remove()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
  })

  it('loads a credential-only modal, inerts the product, and focuses the key', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
    expect(document.getElementById('root')?.inert).toBe(true)
    expect(screen.getByText(en.onboardingDescription)).toBeTruthy()
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    await waitFor(() => { expect(document.activeElement).toBe(key) })
    expect(screen.queryByText(en.customized)).toBeNull()
  })

  it('cannot be dismissed implicitly and restores the previous inert state', async () => {
    const h = harness()
    const appRoot = document.getElementById('root')!
    appRoot.inert = true
    const view = render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('[class*="mask"]')!)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()

    view.unmount()
    expect(appRoot.inert).toBe(true)
  })

  it('requires a non-blank key before Save and continue is available', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    const save = screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingSave })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '   ' } })
    expect(save.disabled).toBe(true)
    expect(screen.getByText(en.keyRequired)).toBeTruthy()
    expect(h.set).not.toHaveBeenCalled()
  })

  it('keeps the modal open and reports a refused credential write', async () => {
    for (const [options, message] of [
      [{ setFailure: 'credential was rejected' }, 'credential was rejected'],
    ] as const) {
      const h = harness(options)
      const view = render(<DeepSeekOnboardingDialog {...h.props} />)
      await screen.findByRole('dialog')
      fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-live' } })
      fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
      expect(await screen.findByText(message)).toBeTruthy()
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingSave }).disabled).toBe(false)
      expect(h.complete).not.toHaveBeenCalled()
      expect(h.mutate).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('allows configure-later dismissal without opening settings', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingLater }))
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.openSection).not.toHaveBeenCalled()
    expect(h.set).not.toHaveBeenCalled()
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('does not block the product when DeepSeek setup is unavailable', async () => {
    for (const h of [
      harness({ describeFailure: 'credentials service is absent' }),
      harness({ credential: { writable: false } }),
      harness({ settingsWritable: false }),
      harness({ providersFailure: 'the provider directory is unavailable' }),
      harness({ providerActive: false }),
      harness({ settingsNamespace: false }),
      harness({ apiKeyEnv: null }),
    ]) {
      const view = render(<DeepSeekOnboardingDialog {...h.props} />)
      await act(async () => { await h.controller.load() })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
      expect(h.openSection).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('skips an absent adapter and an already-configured environment credential', async () => {
    for (const h of [
      harness({ provider: false }),
      harness({ providerSettingsNs: '' }),
      harness({ configured: () => true, credential: { source: 'env', writable: false } }),
    ]) {
      const view = render(<DeepSeekOnboardingDialog {...h.props} />)
      await act(async () => { await h.controller.load() })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
      view.unmount()
    }
  })

  it('closes when an external credential invalidation refreshes the shared join', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    h.configure()
    await act(async () => { await h.controller.load() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(h.complete).toHaveBeenCalledOnce()
  })
})
