// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterAll, beforeAll, expect, vi } from 'vitest'
import {
  ClientRoster, createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '@deepseek-ai/dsh-client-locale/src/locale-settings.ts'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import type { SettingsGeneralItemOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'settings.general.group.custom.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
  }
}
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../../ui-settings-models/src/onboarding-copy.ts'
import type { GeneralSectionInjected } from '../src/client/GeneralSection.tsx'

// jsdom has no scrolling implementation; Settings navigation uses the browser API.
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterAll(() => {
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

const GROUP_OWNER = 'test-settings-group-owner'
const ROW_OWNER = 'test-settings-group-rows'
const CUSTOM_SLOT = 'settings.general.group.custom.item'
const BUILTIN_IDS = ['general', 'display', 'interaction', 'notifications', 'data', 'updates']
const ZH_LABELS = ['常规', '会话偏好', '交互与快捷键', '通知', '数据管理', '版本与更新']
const EN_LABELS = ['Preferences', 'Chat experience', 'Interaction and shortcuts', 'Notifications', 'Data management', 'Version and updates']

function CustomGroup({ renderSlot }: PropsRuntime<'settings.general.group'> & PropsRenderSlots<typeof CUSTOM_SLOT>) {
  return renderSlot(CUSTOM_SLOT, {})
}

function CustomRow() { return 'Custom child preference' }
function NullRow() { return null }
function LegacyRow() { return <span>Legacy general preference</span> }
function DisplayRow() { return <span>Targeted display preference</span> }

const it = createClientTest({
  roster: ClientRoster.of([
    ...webApp.rows,
    { name: GROUP_OWNER, inject: [], immediately: false },
    { name: ROW_OWNER, inject: [], immediately: false },
  ]),
  provide: {
    [GROUP_OWNER]: {
      inject: ['slots', 'locale'],
      apply(ctx: Context) {
        ctx.slots.inject('settings.general.group', () => ctx.slots.register({
          name: 'settings.general.group', id: 'custom', order: 15,
          label: () => ctx.locale.getSnapshot().active === 'zh' ? '扩展偏好' : 'Extension preferences',
          children: { [CUSTOM_SLOT]: { kind: 'list', scope: 'root' } },
        }, CustomGroup))
      },
    },
    [ROW_OWNER]: {
      inject: ['slots'],
      apply(ctx: Context) {
        ctx.slots.inject(CUSTOM_SLOT, function* () {
          yield ctx.slots.register({ name: CUSTOM_SLOT, id: 'custom-child', order: 0 }, CustomRow)
          yield ctx.slots.register({ name: CUSTOM_SLOT, id: 'null-child', order: 10 }, NullRow)
        })
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item', id: 'permission',
        }, LegacyRow))
        ctx.slots.inject('settings.general.group.display.item', () => ctx.slots.register({
          name: 'settings.general.group.display.item', id: 'targeted-display',
        }, DisplayRow))
      },
    },
  },
}, { mount: true })

function localeView(preference: string, revision = 0): SettingsNamespaceView {
  return {
    ns: LOCALE_SETTINGS_NAMESPACE,
    schema: JSON.parse(JSON.stringify(LocaleSettingsSchema.toJSON())) as SettingsNamespaceView['schema'],
    value: { preference }, autoGenerate: true, applies: 'live', secrets: [], revision,
  }
}

function groupsOf(client: TestClient) {
  const entry = client.ctx.slots.entries('settings.section').find(row => row.options.id === 'general')!
  const face: Partial<GeneralSectionInjected> | undefined = entry.inject?.()
  if (face?.hooks === undefined) throw new Error('General section did not inject its group source')
  return face.hooks.groups
}

it('assembles ordered localized groups, legacy and targeted rows, and restores children after owner reload', async ({ mock, start }) => {
  const welcome: SettingsNamespaceView = {
    ns: WELCOME_NOTICE_SETTINGS_NAMESPACE, schema: {},
    value: { [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION },
    autoGenerate: true, applies: 'live', secrets: [], revision: 0,
  }
  mock.remote.settings.describe.mockResolvedValue(ok({
    writable: true, hasDocument: false, namespaces: [localeView('zh'), welcome],
  }))
  const client = await start()
  await client.ctx.configForms.describe().ensure()
  const groups = groupsOf(client)
  const product = groups.getSnapshot().filter(row => row.id !== 'custom')
  expect(product.map(row => row.id)).toEqual(BUILTIN_IDS)
  expect(product.map(row => row.label)).toEqual(ZH_LABELS)
  expect(client.ctx.slots.entries('settings.general.group').map(row => row.options.order))
    .toEqual([10, 15, 20, 30, 40, 50, 60])
  // A registrant that omits both order and label still projects a first-position row.
  let removeBare = () => {}
  act(() => {
    removeBare = client.ctx.slots.register({ name: 'settings.general.group', id: 'bare' } as never, NullRow)
  })
  expect(groups.getSnapshot()[0]).toEqual({ id: 'bare', label: '' })
  act(() => { removeBare() })
  expect(groups.getSnapshot().some(row => row.id === 'bare')).toBe(false)
  expect(client.ctx.slots.entries('settings.general.group').filter(row => row.options.id !== 'custom')
    .map(row => Object.keys(row.children ?? {}))).toEqual([
    ['settings.general.item'],
    ['settings.general.group.display.item'], ['settings.general.group.interaction.item'],
    ['settings.general.group.notifications.item'], ['settings.general.group.data.item'],
    ['settings.general.group.updates.item'],
  ])
  expect(client.ctx.slots.entries('settings.general.group.interaction.item')
    .map(row => ({ id: row.options.id, order: row.options.order }))).toEqual([
    { id: 'composer-enter', order: 0 }, { id: 'link-opening', order: 10 }, { id: 'shortcuts', order: 20 },
  ])
  expect(groups.getSnapshot().map(row => row.id))
    .toEqual(['general', 'custom', 'display', 'interaction', 'notifications', 'data', 'updates'])
  expect(groups.getSnapshot()).toBe(groups.getSnapshot())
  expect(client.ctx.slots.spec(CUSTOM_SLOT)).toEqual({ kind: 'list', scope: 'root' })
  expect(client.ctx.slots.entries(CUSTOM_SLOT).map(row => row.options.id)).toEqual(['custom-child', 'null-child'])

  fireEvent.click(screen.getByRole('button', { name: '账号菜单' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '设置' }))
  const custom = screen.getByRole('region', { name: '扩展偏好' })
  expect(within(custom).getByText('Custom child preference')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: '常规' })).getByText('Legacy general preference')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: '会话偏好' })).getByText('Targeted display preference')).toBeTruthy()
  expect(screen.getAllByRole('heading', { level: 3 }).map(row => row.textContent))
    .toEqual(['常规', '扩展偏好', '会话偏好', '交互与快捷键', '通知', '数据管理', '版本与更新'])

  let removeShadow = () => {}
  act(() => {
    removeShadow = client.ctx.slots.register({
      name: 'settings.general.group', id: 'custom', priority: 10,
      order: -100, label: 'Shadowed preferences',
    }, NullRow)
  })
  try {
    expect(client.ctx.slots.entries('settings.general.group').filter(row => row.options.id === 'custom')).toHaveLength(2)
    expect(groups.getSnapshot().filter(row => row.id === 'custom')).toEqual([{ id: 'custom', label: '扩展偏好' }])
    expect(groups.getSnapshot().map(row => row.id))
      .toEqual(['general', 'custom', 'display', 'interaction', 'notifications', 'data', 'updates'])
    expect(screen.getAllByRole('region', { name: '扩展偏好' })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'Shadowed preferences' })).toBeNull()
    expect(screen.getAllByText('Custom child preference')).toHaveLength(1)
  } finally {
    act(() => { removeShadow() })
  }

  const changed = vi.fn()
  const off = groups.subscribe(changed)
  try {
    const before = groups.getSnapshot()
    const ledgerVersion = client.ctx.slots.getVersion('settings.general.group')
    mock.remote.settings.mutate.mockResolvedValueOnce(ok(localeView('en', 1)))
    act(() => { client.ctx.locale.setLocale('en') })
    await client.flush()
    expect(groups.getSnapshot()).not.toBe(before)
    expect(groups.getSnapshot().filter(row => row.id !== 'custom').map(row => row.label)).toEqual(EN_LABELS)
    expect(changed).toHaveBeenCalled()
    expect(client.ctx.slots.getVersion('settings.general.group')).toBe(ledgerVersion)
    expect(screen.getByRole('region', { name: 'Extension preferences' }).textContent).toContain('Custom child preference')

    await client.reload(GROUP_OWNER)
    await client.flush()
    expect(client.ctx.slots.entries(CUSTOM_SLOT).map(row => row.options.id)).toEqual(['custom-child', 'null-child'])
    expect(screen.getAllByText('Custom child preference')).toHaveLength(1)
    expect(groups.getSnapshot().map(row => row.id)).toEqual(['general', 'custom', 'display', 'interaction', 'notifications', 'data', 'updates'])

    await client.unload(GROUP_OWNER)
    await client.flush()
    expect(client.ctx.slots.spec(CUSTOM_SLOT)).toBeUndefined()
    expect(client.ctx.slots.entries(CUSTOM_SLOT)).toEqual([])
    expect(groups.getSnapshot().map(row => row.id)).toEqual(BUILTIN_IDS)
    expect(screen.queryByText('Custom child preference')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Extension preferences' })).toBeNull()
    expect(screen.getByText('Legacy general preference')).toBeTruthy()
    expect(screen.getByText('Targeted display preference')).toBeTruthy()

    await client.unload(ROW_OWNER)
    await client.flush()
    expect(screen.queryByText('Legacy general preference')).toBeNull()
    expect(screen.queryByText('Targeted display preference')).toBeNull()
  } finally {
    off()
  }
}, 60_000)
