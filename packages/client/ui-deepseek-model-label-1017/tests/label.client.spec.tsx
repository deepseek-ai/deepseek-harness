// @vitest-environment jsdom
import { expect, it, onTestFinished } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelLabelOwner } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import * as HostPlugin from '../src/index.ts'
import * as LabelPlugin from '../src/client/index.ts'

const SLOT = 'conversation.input.model.label'
const NAME = 'DeepSeek-V4.1-Flash'

function owner(provider: string, name = NAME, id = 'deepseek-flash', placement: ModelLabelOwner['placement'] = 'option'): ModelLabelOwner {
  return { provider: { id: provider, name: provider }, model: { id, name }, placement, selected: true }
}

async function runtime() {
  const host = await SlotTestRuntime.create()
  onTestFinished(() => host.dispose())
  const locale = new LocaleRuntime(host.ctx)
  host.ctx.provide('locale', locale)
  host.slots.installLocale(locale)
  await host.mount(HostPlugin)
  await host.sessions.add({ id: SessionId('release-badge') })
  const session = host.sessions.retainFor(host.ctx, SessionId('release-badge'))
  return { host, session }
}

const placements = ['trigger', 'menu', 'option'] as const
const targets = ['deepseek-official', 'deepseek-account'].flatMap(provider => placements.map(placement => ({ provider, placement })))
it.each(targets)('shows the badge for $provider at $placement without rewriting its catalog entry', async ({ provider, placement }) => {
  const { host, session } = await runtime()
  await host.declare({ [SLOT]: { kind: 'single', scope: 'session', inline: true } })
  await host.mount(LabelPlugin)
  const input = owner(provider, NAME, 'deepseek-flash', placement)
  const view = host.renderSlot(SLOT, input, { session, fallback: input.model.name })
  expect(view.container.textContent).toBe(`${NAME} 1017`)
  expect(view.view.getByText('1017').tagName).toBe('SPAN')
  expect(input.model).toEqual({ id: 'deepseek-flash', name: NAME })
})

it.each([
  { label: 'another provider', value: owner('external') },
  { label: 'another model id', value: owner('deepseek-official', NAME, 'other-model') },
  { label: 'a custom name', value: owner('deepseek-account', 'My Flash') },
  { label: 'a dated name', value: owner('deepseek-account', `${NAME}-1017`) },
  { label: 'a later release name', value: owner('deepseek-official', `${NAME}-1024`) },
])('preserves $label', async ({ value }) => {
  const { host, session } = await runtime()
  await host.declare({ [SLOT]: { kind: 'single', scope: 'session', inline: true } })
  await host.mount(LabelPlugin)
  const view = host.renderSlot(SLOT, value, { session, fallback: value.model.name })
  expect(view.container.textContent).toBe(value.model.name)
  expect(view.view.queryByText('1017')).toBeNull()
})

it('waits for the label declaration, follows changed model props, and restores the fallback on unload', async () => {
  const { host, session } = await runtime()
  const plugin = await host.mount(LabelPlugin)
  expect(host.slots.entries(SLOT)).toHaveLength(0)
  await host.declare({ [SLOT]: { kind: 'single', scope: 'session', inline: true } })
  const input = owner('deepseek-official')
  const view = host.renderSlot(SLOT, input, { session, fallback: NAME })
  expect(view.container.textContent).toBe(`${NAME} 1017`)
  view.update(owner('deepseek-official', 'My Flash'))
  expect(view.container.textContent).toBe('My Flash')
  view.update(input)
  expect(view.container.textContent).toBe(`${NAME} 1017`)
  await plugin.dispose()
  expect(host.slots.entries(SLOT)).toHaveLength(0)
  expect(view.container.textContent).toBe(NAME)
  await host.mount(LabelPlugin)
  expect(view.container.textContent).toBe(`${NAME} 1017`)
})
