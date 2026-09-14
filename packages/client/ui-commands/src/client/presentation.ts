/** Composer menu grouping, localized labels, descriptions, and icons. */
import type { ComponentType } from 'react'
import type { InputTriggerCandidate } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  IconCompactOutline16, IconDownloadOutline16, IconGoalOutline16, IconPaperPlaneOutline14, IconPlanOutline14,
  IconShieldOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'
import type { CommandKey } from './locales.ts'
import { builtinCommandName } from './resolution.ts'
import type { BuiltinCommandName } from './resolution.ts'

/** The menu's two sections. */
export type MenuSection = 'add' | 'commands'

/** Row names per section, highest usage first; rows outside both lists close the Commands section in catalog order. */
const SECTION_ROWS: Readonly<Record<MenuSection, readonly string[]>> = {
  add: ['file', 'goal', 'plan', 'feedback'],
  commands: ['compact', 'permission', 'model', 'export'],
}

/** The dictionary keys and glyph of one built-in Host command's client face. */
interface HostFace {
  readonly label: CommandKey
  readonly description: CommandKey
  readonly icon: ComponentType<IconProps>
}

/** One built-in Host command's face, keyed by its dictionary entries. */
function hostFace(name: BuiltinCommandName, icon: ComponentType<IconProps>): readonly [BuiltinCommandName, HostFace] {
  return [name, {
    label: `label.${name}`,
    description: `description.${name}`,
    icon,
  }]
}

/** Built-in Host commands whose client face this package owns. */
const HOST_FACES: ReadonlyMap<BuiltinCommandName, HostFace> = new Map([
  hostFace('goal', IconGoalOutline16),
  hostFace('plan', IconPlanOutline14),
  hostFace('feedback', IconPaperPlaneOutline14),
  hostFace('compact', IconCompactOutline16),
  hostFace('permission', IconShieldOutline16),
  hostFace('export', IconDownloadOutline16),
])

/**
 * The localized menu face of a catalog row.
 * @param descriptor - effective Host command descriptor.
 * @param t - the `command` namespace translator.
 * @returns title, description, and glyph for a built-in command; undefined
 * for any other row, which keeps its catalog description.
 */
export function builtinRowFace(
  descriptor: CommandDescriptor,
  t: TranslateNS<'command'>,
): Pick<InputTriggerCandidate, 'label' | 'description' | 'icon'> | undefined {
  const name = builtinCommandName(descriptor)
  const face = name === undefined ? undefined : HOST_FACES.get(name)
  return face === undefined ? undefined : { label: t(face.label), description: t(face.description), icon: face.icon }
}

/**
 * Arrange the empty-query menu: the Add section, then the Commands section,
 * each in usage order, with unlisted rows closing Commands in their input
 * order; each row carries its section heading.
 * @param rows - the visible candidates in catalog-then-contribution order.
 * @param t - the `command` namespace translator.
 * @returns the sectioned rows.
 */
export function sectionRows(rows: readonly InputTriggerCandidate[], t: TranslateNS<'command'>): readonly InputTriggerCandidate[] {
  const listed = new Set([...SECTION_ROWS.add, ...SECTION_ROWS.commands])
  const byName = new Map(rows.map(row => [row.name, row]))
  const pick = (names: readonly string[]): InputTriggerCandidate[] =>
    names.flatMap((name) => {
      const row = byName.get(name)
      return row === undefined ? [] : [row]
    })
  const add = pick(SECTION_ROWS.add).map(row => ({ ...row, section: t('section.add') }))
  const commands = [...pick(SECTION_ROWS.commands), ...rows.filter(row => !listed.has(row.name))]
    .map(row => ({ ...row, section: t('section.commands') }))
  return [...add, ...commands]
}
