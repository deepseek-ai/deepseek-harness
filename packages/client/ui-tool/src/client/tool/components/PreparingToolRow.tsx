/** Tool-owned non-expandable chrome without dispatched argument material. */
import type { ReactNode } from 'react'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { classifyTool } from '../models/tool-call-model.ts'
import { ToolRow, type ToolRowProps } from './ToolRow.tsx'

/** Inputs contain a tool-owned icon/title and no expandable body. */
type PreparingToolRowProps = Pick<ToolCallViewProps, 'toolName' | 'useDisclosure'> & {
  readonly icon: ReactNode
  readonly title: string
  readonly summary?: string
  readonly t: ToolRowProps['t']
}

/**
 * Render a non-expandable tool prefix with an optional preparation summary.
 * @param props - tool prefix and locale.
 * @returns the preparation row.
 */
export function PreparingToolRow({ toolName, useDisclosure, icon, title, summary = '', t }: PreparingToolRowProps) {
  return <ToolRow useDisclosure={useDisclosure} t={t} variant={classifyTool(toolName)} toolName={toolName}
    icon={icon} title={title} summary={summary} state="preparing" />
}
