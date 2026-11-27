import type { ComponentProps } from 'react'
import {
  JsonBlock as LocalizedJsonBlock,
  MarkdownText as LocalizedMarkdownText,
  type MarkdownCodeLabels,
  type MarkdownLabels,
} from '../src/client/index.ts'
import { markdownLabels as defaultMarkdownLabels } from './labels.client.ts'

type MarkdownTextProps = Omit<ComponentProps<typeof LocalizedMarkdownText>, 'labels'> & {
  labels?: MarkdownLabels
  codeLabels?: MarkdownCodeLabels
}

export function MarkdownText({
  labels,
  codeLabels,
  ...props
}: MarkdownTextProps) {
  const resolved = labels ?? (codeLabels === undefined
    ? defaultMarkdownLabels
    : { ...defaultMarkdownLabels, code: codeLabels })
  return <LocalizedMarkdownText {...props} labels={resolved} />
}

type JsonBlockProps = Omit<ComponentProps<typeof LocalizedJsonBlock>, 'truncatedLabel'> & {
  truncatedLabel?: (total: number) => string
}

export function JsonBlock({ truncatedLabel, ...props }: JsonBlockProps) {
  return (
    <LocalizedJsonBlock
      {...props}
      truncatedLabel={truncatedLabel ?? (total => `… 已截断，共 ${total} 字符`)}
    />
  )
}
