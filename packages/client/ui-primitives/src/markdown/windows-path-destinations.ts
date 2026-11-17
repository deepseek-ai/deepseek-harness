/** Keep backslash separators in Markdown destinations written as Windows paths. */
import type { Definition, Image, Link } from 'mdast'
import type { CompileContext, Extension, Token } from 'mdast-util-from-markdown'
import { decodeString } from 'micromark-util-decode-string'

/**
 * A raw destination is a Windows path when it has a backslash and no URL
 * scheme, and either has no `/` or has a backslash before a letter or digit,
 * which CommonMark cannot read as an escape. A drive letter is not a scheme.
 */
function isWindowsPath(raw: string): boolean {
  return raw.includes('\\') && !/^[a-z][a-z\d+.-]+:/iu.test(raw)
    && (!raw.includes('/') || /\\[\p{L}\p{N}]/u.test(raw))
}

function exitDestination(this: CompileContext, token: Token): void {
  const parsed = this.resume()
  const raw = this.sliceSerialize(token)
  const node = this.stack.at(-1) as Link | Image | Definition
  // Doubling each backslash makes every one literal; character references still decode.
  node.url = isWindowsPath(raw) ? decodeString(raw.replaceAll('\\', '\\\\')) : parsed
}

/**
 * CommonMark reads `\.` or `\_` in a destination as an escaped character, so
 * `D:\repo\.github` would parse as `D:\repo.github`. For a destination that
 * is a Windows path, this `fromMarkdown` extension keeps every backslash
 * literally, including one before punctuation such as `\(`, while character
 * references such as `&amp;` still decode; other destinations parse unchanged.
 * @returns The mdast extension.
 */
export function windowsPathDestinations(): Extension {
  return { exit: { resourceDestinationString: exitDestination, definitionDestinationString: exitDestination } }
}
