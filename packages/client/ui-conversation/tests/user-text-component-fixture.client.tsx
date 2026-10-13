/** Production UserText assembly for component units that supply their own outer Slot seats. */
import { Context } from '@deepseek-ai/cordis'
import { createElement, type ComponentProps, type ReactNode } from 'react'
import { onTestFinished } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { UserTextInput, UserTextNodeOwnerProps } from '../src/client/contract/slots.ts'
import type { UserTextNode } from '../src/client/contract/user-text.ts'
import { UserTextRegistry } from '../src/client/conversation/user-text-registry.ts'
import { UserText, PlainUserText, SessionReference } from '../src/client/user-text/UserText.tsx'
import { sessionReferenceRule } from '../src/client/user-text/session-reference-rule.ts'
import { collapseWhitespaceRule, trimWhitespaceRule } from '../src/client/user-text/whitespace-rules.ts'
import { skillReferenceRule } from '../../ui-skill/src/client/user-text-rules.ts'
import { SkillReference } from '../../ui-skill/src/client/SkillReference.tsx'
import { fileReferenceRule, folderReferenceRule } from '../../ui-reference/src/client/user-text-rules.ts'
import { FileReference, FolderReference } from '../../ui-reference/src/client/FileReference.tsx'
import { zh as referenceZh } from '../../ui-reference/src/client/locales.ts'
import { goalCommandReferenceRule } from '../../ui-goal/src/client/user-text-rules.ts'
import { GoalCommandReference } from '../../ui-goal/src/client/GoalCommandReference.tsx'

/** Actions supplied by the unit's business-injection fixture, not by UserText owner data. */
interface UserTextFixtureActions {
  openFile?: (path: string) => void
  openSkill?: (name: string) => void
}

type UserTextProps = ComponentProps<typeof UserText>

/**
 * Bind the production evaluator and node components without replacing matching or display behavior.
 * Integration tests install the actual Slot registrations separately.
 * @param actions - reference operations owned by the surrounding test fixture.
 * @returns renderer accepting the production Factory's input fields.
 */
export function createUserTextFixture(actions: UserTextFixtureActions = {}): (input: UserTextInput) => ReactNode {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  for (const rule of [
    sessionReferenceRule, skillReferenceRule, fileReferenceRule, folderReferenceRule,
    goalCommandReferenceRule, collapseWhitespaceRule, trimWhitespaceRule,
  ]) registry.register(rule)
  const useUserTextRevision = bindSnapshotSelector({
    getSnapshot: () => registry.getSnapshot(),
    subscribe: listener => registry.subscribe(listener),
  })
  const createUserTextEvaluator = () => registry.createEvaluator()
  const reportTransformFailure = (error: unknown): never => { throw error }
  const openFile = actions.openFile ?? (() => { throw new Error('This fixture has no file navigation action') })
  const openSkill = actions.openSkill ?? (() => { throw new Error('This fixture has no skill navigation action') })
  const t = makeTranslate(referenceZh, commonZh)
  const renderSlot: UserTextProps['renderSlot'] = (name: string, input: object, options?: { fallback?: ReactNode }) => {
    if (name !== 'conversation.user.text.node') throw new Error(`Unexpected UserText Slot: ${name}`)
    const owner = input as UserTextNodeOwnerProps & { node: UserTextNode }
    switch (owner.node.id) {
      // The production components only read these owner, action and locale seats in these units.
      case 'text': return createElement(PlainUserText, owner as ComponentProps<typeof PlainUserText>)
      case 'session': return createElement(SessionReference, owner as ComponentProps<typeof SessionReference>)
      case 'file': return createElement(FileReference, { ...owner, openFile, t } as ComponentProps<typeof FileReference>)
      case 'folder': return createElement(FolderReference, owner as ComponentProps<typeof FolderReference>)
      case 'skill': return createElement(SkillReference, { ...owner, openSkill } as ComponentProps<typeof SkillReference>)
      case 'command': return createElement(GoalCommandReference, owner as ComponentProps<typeof GoalCommandReference>)
      default: return options?.fallback ?? null
    }
  }
  return input => createElement(UserText, {
    ...input, useUserTextRevision, createUserTextEvaluator, reportTransformFailure, renderSlot,
  } as UserTextProps)
}
