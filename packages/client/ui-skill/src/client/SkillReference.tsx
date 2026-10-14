/** Skill-reference presentation with activation owned by this keyed entry's Session injection. */
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

/** Session-bound preview action; accepting a preview is not a completion promise. */
export interface SkillReferenceInjected {
  /**
   * Ask the skill source to preview a confirmed name in this entry's Session.
   * @param name - skill name without its slash.
   */
  readonly openSkill: (name: string) => void
}

type SkillReferenceProps = UserTextNodeProps<'skill'> & SkillReferenceInjected

/**
 * Render a skill chip; previews omit activation even when the entry has an injected action.
 * @param props - resolved node, raw token, interaction mode, and Session-bound preview action.
 * @returns an inline skill label or interactive chip.
 */
export function SkillReference({ node, raw, interactive, openSkill }: SkillReferenceProps) {
  return <ReferenceChip
    appearance="skill"
    label={`/${node.data.name}`}
    title={raw}
    {...(interactive ? { onActivate: () => { openSkill(node.data.name) } } : {})}
  />
}
