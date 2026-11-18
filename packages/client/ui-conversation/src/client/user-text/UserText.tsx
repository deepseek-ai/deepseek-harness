/** User-text presentation delegates evaluation to its data-layer document and renders JSON business nodes. */
import { Fragment, useEffect, useMemo } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { HoverCardGroup, ReferenceChip, UserTextRun } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserTextNodeProps } from '../contract/slots.ts'
import type { UserTextNode } from '../contract/user-text.ts'
import css from './UserText.module.css'

type UserTextOwner = Parameters<FactoryComponentPropsOf<'conversation.user.text'>['renderSlot']>[1]

/**
 * Render original text through pure matching rules and business-owned node Slots.
 * A failed parse retains the entire original text and reports the rule error.
 * @param props - original text, confirmed facts, display policy, and framework seats.
 * @returns ordered inline nodes with raw-text fallbacks for missing registrations.
 */
export function UserText({
  text, facts, interactive = false, ellipsis = false,
  useUserTextRevision, createUserTextEvaluator, reportTransformFailure, renderSlot,
}: FactoryComponentPropsOf<'conversation.user.text'>) {
  useUserTextRevision(revision => revision)
  const evaluate = useMemo(createUserTextEvaluator, [createUserTextEvaluator])
  let nodes: readonly UserTextNode[] | undefined
  let error: unknown
  try {
    nodes = evaluate({ text, facts })
  } catch (cause: unknown) {
    error = cause
  }
  const failed = nodes === undefined
  useEffect(() => {
    if (failed) reportTransformFailure(error)
  }, [failed, error, reportTransformFailure])
  const content = useMemo(() => nodes === undefined ? <UserTextRun text={text} /> : <>{nodes.map((node) => {
    const raw = text.slice(node.start, node.end)
    // The node ID determines its payload; TypeScript does not distribute this enclosing owner over the node union.
    const owner = { node, raw, interactive } as UserTextOwner
    return <Fragment key={`${node.id}:${node.start}`}>
      {renderSlot('conversation.user.text.node', owner, {
        entryKey: node.id,
        fallback: <UserTextRun text={node.id === 'text' ? node.data.display ?? raw : raw} />,
      })}
    </Fragment>
  })}</>, [nodes, text, interactive, renderSlot])
  return <HoverCardGroup as="span" className={ellipsis ? css.ellipsis : css.root}>{content}</HoverCardGroup>
}

/**
 * Display an unmatched substring without business interpretation.
 * @param props - parser-produced plain-text node.
 * @returns its inline text.
 */
export function PlainUserText({ node }: UserTextNodeProps<'text'>) {
  return <UserTextRun text={node.data.display ?? node.data.text} />
}

/**
 * Display a confirmed Session label without inventing navigation behavior.
 * @param props - Session reference JSON and its original spelling.
 * @returns the existing non-interactive Session chip.
 */
export function SessionReference({ node, raw }: UserTextNodeProps<'session'>) {
  return <ReferenceChip appearance="session" label={node.data.label} title={raw} />
}
