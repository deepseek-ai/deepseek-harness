/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { DisclosureRow, IconEllipsisOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallOwnerProps, ToolCallPhaseProps, ToolTreeProps } from '../contract/slots.ts'
import { ProgramCallRow } from './components/ProgramCallRow.tsx'
import { classifyTool, toolRowModel } from './models/tool-call-model.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

function toolCallPhase(block: ToolCallBlock): ToolCallPhaseProps {
  if ('kind' in block) return { phase: 'result', block }
  return block.phase === 'preparing' ? { phase: 'preparing', block } : { phase: 'start', block }
}

/** Resolve a Tool call's wire name from its current stage. */
function callName(call: ToolCallPhaseProps): string {
  return call.phase === 'result' ? call.block.call?.name ?? '' : call.block.name
}

/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = memo(function ToolCall({
  renderSlot, callId, toolName, call, openFile, renderFallback, cwd, home, inspectCall, loadImage, useDisclosure,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'cwd' | 'inspectCall' | 'loadImage' | 'useDisclosure'> & {
  renderFallback: (owner: ToolCallOwnerProps) => ReactNode
  callId: string
  toolName: string
  call: ToolCallPhaseProps
  home?: string | undefined
}) {
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    ...call,
    openFile,
    cwd,
    home,
    loadImage,
    useDisclosure,
    inspect: inspectCall === undefined ? undefined : () => { inspectCall(callId) },
  }), [callId, toolName, call, openFile, cwd, home, loadImage, inspectCall, useDisclosure])
  const autoReviewDenied = useMemo(
    () => call.phase === 'result' && toolRowModel(toolName, call.block).autoReviewDenial !== null,
    [toolName, call],
  )
  return autoReviewDenied
    ? renderFallback(owner)
    : renderSlot('tool.call.toolview', owner, {
      entryKey: toolName,
      fallback: renderFallback(owner),
    })
})

/** Sub-call count above which a call lists only its first sub-calls, followed by an omission row. */
const SUB_CALL_LIST_LIMIT = 24
/** Sub-calls listed in a list above the limit until the omission row is first activated; each activation doubles the count. */
const SUB_CALL_LIST_INITIAL = 20

const OMISSION_ICON = <IconEllipsisOutlineRegular size={14} />

/** The omission row reveals sub-calls through its own button; its row is not a disclosure. */
function noToggle(): void {}

type SubCallListProps = Pick<ToolTreeProps, 'renderSlot' | 'cwd' | 'openFile' | 'inspectCall' | 'loadImage' | 'useDisclosure' | 't'> & {
  renderFallback: (owner: ToolCallOwnerProps) => ReactNode
  subCalls: readonly ToolCallBlock[]
  home?: string | undefined
}

/**
 * Render a call's sub-call rows. Above the limit, the list mounts only its first
 * {@link SUB_CALL_LIST_INITIAL} sub-calls followed by an omission row; each activation of that row
 * doubles the listed count, up to every sub-call. The listed count is local state, so remounting
 * the list returns to the initial count.
 * @param props - The sub-calls and the props each sub-call branch forwards.
 * @returns The sub-call rows.
 */
function SubCallList({ subCalls, t, ...branch }: SubCallListProps) {
  const [limit, setLimit] = useState(SUB_CALL_LIST_INITIAL)
  const listed = subCalls.length > SUB_CALL_LIST_LIMIT ? subCalls.slice(0, limit) : subCalls
  const omitted = subCalls.length - listed.length
  const reveal = () => { setLimit(count => count * 2) }
  const revealFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    reveal()
  }
  return (
    <div className={css.rows} data-subcalls>
      {listed.map(child => <ToolCallBranch key={child.callId} {...branch} block={child} t={t} />)}
      {omitted > 0 && (
        <div
          className={css.omission}
          data-subcalls-omitted={omitted}
          role="button"
          tabIndex={0}
          onClick={reveal}
          onKeyDown={revealFromKeyboard}
        >
          <DisclosureRow
            icon={OMISSION_ICON}
            title={t('row.subCallsOmitted', { count: omitted })}
            open={false}
            expandable={false}
            onToggle={noToggle}
          />
        </div>
      )}
    </div>
  )
}

/** One call's rows: its dispatched view and its sub-calls, under a header row when the call runs a program. */
const ToolCallBranch = memo(function ToolCallBranch({
  renderSlot, block, cwd, home, openFile, renderFallback, inspectCall, loadImage, useDisclosure, t,
}: Pick<ToolTreeProps, 'renderSlot' | 'cwd' | 'openFile' | 'inspectCall' | 'loadImage' | 'useDisclosure' | 't'> & {
  renderFallback: (owner: ToolCallOwnerProps) => ReactNode
  block: ToolCallBlock
  home?: string | undefined
}) {
  const call = useMemo(() => toolCallPhase(block), [block])
  const callId = block.callId
  const toolName = callName(call)
  const view = (
    <ToolCall
      renderSlot={renderSlot}
      callId={callId}
      toolName={toolName}
      call={call}
      openFile={openFile}
      renderFallback={renderFallback}
      cwd={cwd}
      home={home}
      inspectCall={inspectCall}
      useDisclosure={useDisclosure}
      loadImage={loadImage}
    />
  )
  const subCallRows = block.subCalls.length > 0 ? (
    <SubCallList
      renderSlot={renderSlot}
      subCalls={block.subCalls}
      cwd={cwd}
      home={home}
      openFile={openFile}
      renderFallback={renderFallback}
      inspectCall={inspectCall}
      useDisclosure={useDisclosure}
      loadImage={loadImage}
      t={t}
    />
  ) : null
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
    >
      {classifyTool(toolName) === 'code' ? (
        <ProgramCallRow toolName={toolName} block={block} useDisclosure={useDisclosure} t={t}>
          <div className={clsx(css.nested, css.rows)}>
            {view}
            {subCallRows}
          </div>
        </ProgramCallRow>
      ) : (
        <>
          {view}
          {subCallRows !== null && <div className={css.nested}>{subCallRows}</div>}
        </>
      )}
    </div>
  )
})

/**
 * Render one root Tool call and its recursive children through the same
 * atomic keyed dispatch.
 * @param props - whole-Tool owner data and the Tool-owned child-slot share.
 * @returns the Tool call tree.
 */
export function ToolCallTree({
  renderSlot, node, cwd, openFile, inspectCall, loadImage, useDisclosure, useHostInfo, t, useContextMenu, sessionId, resolveFilePath,
}: ToolTreeProps) {
  const { getTriggerProps } = useContextMenu()
  const getFileTriggerProps = useCallback((path: string) => getTriggerProps(() => ({
    kind: 'file', value: { sessionId, path: resolveFilePath(path) },
  })), [getTriggerProps, sessionId, resolveFilePath])
  const renderFallback = useCallback((owner: ToolCallOwnerProps) =>
    <GenericToolCard {...owner} t={t} getFileTriggerProps={getFileTriggerProps} />, [t, getFileTriggerProps])
  const home = useHostInfo(info => info.home)
  return (
    <ToolCallBranch
      renderSlot={renderSlot}
      block={node.data.root}
      cwd={cwd}
      home={home}
      openFile={openFile}
      renderFallback={renderFallback}
      inspectCall={inspectCall}
      useDisclosure={useDisclosure}
      loadImage={loadImage}
      t={t}
    />
  )
}
