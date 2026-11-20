import { expect, expectTypeOf, it, vi } from 'vitest'
import type { ComposerBarInjected, ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotCore, type ChildrenDecl, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

it('accepts props supplied by existing composer bar registrations', () => {
  const slots = new SlotCore()
  slots.register({
    name: 'root',
    children: { 'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' } },
  }, (_props: PropsRenderSlots<'conversation.composer.bar'>) => null)

  const children = {
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
    'conversation.input.activity': { kind: 'single', scope: 'session' },
    'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
    'conversation.input.model': { kind: 'single', scope: 'session' },
    'conversation.input.overlay': { kind: 'list', scope: 'session' },
    'conversation.input.permission': { kind: 'single', scope: 'session' },
    'conversation.input.plan': { kind: 'single', scope: 'session' },
    'conversation.input.right': { kind: 'list', scope: 'session' },
  } satisfies ChildrenDecl

  const ExistingBar = ({ renderSlot }: ComposerBarProps) => renderSlot('conversation.input.left', {})
  slots.register({
    name: 'conversation.composer.bar',
    locale: 'conversation',
    children,
    inject: vi.fn<() => ComposerBarInjected>(),
  }, ExistingBar)

  expect(slots.entries('conversation.composer.bar')[0]?.component).toBe(ExistingBar)
  expectTypeOf<Parameters<ComposerBarProps['renderSlot']>[0]>().toEqualTypeOf<keyof typeof children>()
  expectTypeOf<ComposerBarProps>().not.toHaveProperty('renderSlotChain')
})

it('dispatches only the children declared by a custom composer bar', () => {
  const children = {
    'conversation.input.placeholder': { kind: 'chain', scope: 'session', inline: true },
    'conversation.input.left': { kind: 'list', scope: 'session' },
  } satisfies ChildrenDecl
  type Props = ComposerBarProps<keyof typeof children>

  expectTypeOf<Parameters<Props['renderSlot']>[0]>().toEqualTypeOf<'conversation.input.left'>()
  expectTypeOf<Parameters<Props['renderSlotChain']>[0]>().toEqualTypeOf<'conversation.input.placeholder'>()
})
