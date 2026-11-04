/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useCallback, useMemo, type ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallOwnerProps, ToolCallPhaseProps, ToolTreeProps } from '../contract/slots.ts'
import { toolRowModel } from './models/tool-call-model.ts'
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
  renderSlot, callId, toolName, call, openFile, renderFallback, cwd, home, inspectCall, loadImage, useDisclosure, children,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'cwd' | 'inspectCall' | 'loadImage' | 'useDisclosure'> & {
  renderFallback: (owner: ToolCallOwnerProps) => ReactNode
  callId: string
  toolName: string
  call: ToolCallPhaseProps
  home?: string | undefined
  children?: ReactNode
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
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
    >
      {autoReviewDenied
        ? renderFallback(owner)
        : renderSlot('tool.call.toolview', owner, {
          entryKey: toolName,
          fallback: renderFallback(owner),
        })}
      {children}
    </div>
  )
})

const ToolCallBranch = memo(function ToolCallBranch({
  renderSlot, block, cwd, home, openFile, renderFallback, inspectCall, loadImage, useDisclosure,
}: Pick<ToolTreeProps, 'renderSlot' | 'cwd' | 'openFile' | 'inspectCall' | 'loadImage' | 'useDisclosure'> & {
  renderFallback: (owner: ToolCallOwnerProps) => ReactNode
  block: ToolCallBlock
  home?: string | undefined
}) {
  const call = useMemo(() => toolCallPhase(block), [block])
  return (
    <ToolCall
      renderSlot={renderSlot}
      callId={call.block.callId}
      toolName={callName(call)}
      call={call}
      openFile={openFile}
      renderFallback={renderFallback}
      cwd={cwd}
      home={home}
      inspectCall={inspectCall}
      useDisclosure={useDisclosure}
      loadImage={loadImage}
    >
      {call.phase !== 'preparing' && call.block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {call.block.subCalls.map(child => (
            <ToolCallBranch
              key={child.callId}
              renderSlot={renderSlot}
              block={child}
              cwd={cwd}
              home={home}
              openFile={openFile}
              renderFallback={renderFallback}
              inspectCall={inspectCall}
              useDisclosure={useDisclosure}
              loadImage={loadImage}
            />
          ))}
        </div>
      ) : null}
    </ToolCall>
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
    />
  )
}
