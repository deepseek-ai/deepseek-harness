/** Fence presets: the code and math blocks a Markdown document renders for one fence. */
import type { ReactNode } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import { renderTexToReact } from './katex.tsx'
import type { MarkdownCodeLabels } from './render.tsx'

/** Inputs of {@link FenceCodeBlock}. */
export interface FenceCodeBlockProps {
  /** Grammar hint and banner text; omitted renders plain code. */
  lang?: string | undefined
  /** The fence body without its closing newline. */
  code: string
  /** The surrounding document is still streaming; the block keeps its instance as `code` grows. */
  streaming: boolean
  /** Localized code-block chrome. */
  labels: MarkdownCodeLabels
  /** Unified-diff rows; omitted follows `lang` as {@link CodeBlock} does. */
  diff?: boolean | undefined
}

/**
 * Render one fence body as a code block.
 * @param props - fence language, body, streaming state, chrome labels, and diff choice.
 * @returns the code block.
 */
export function FenceCodeBlock({ lang, code, streaming, labels, diff }: FenceCodeBlockProps): ReactNode {
  return (
    <CodeBlock
      // The replaced hast pipeline appended one synthetic newline that
      // CodeBlock's display trim removes; feeding the bare value would make
      // that trim eat a REAL trailing blank line inside the fence instead.
      code={`${code}\n`}
      lang={lang}
      streaming={streaming}
      diff={diff}
      copyLabel={labels.copyLabel}
      copiedLabel={labels.copiedLabel}
      toolbarLabels={labels.toolbarLabels}
    />
  )
}

/**
 * Render one `math` fence body as display TeX.
 * @param props - the fence body without its closing newline.
 * @returns the typeset formula.
 */
export function FenceMathBlock({ code }: { code: string }): ReactNode {
  // rehype-katex parity: its text extraction saw the code block's trailing newline.
  return <>{renderTexToReact(`${code}\n`, true)}</>
}
