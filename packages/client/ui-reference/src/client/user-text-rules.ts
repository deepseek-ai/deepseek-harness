/** Forward file and folder recognition in original text, without Facts or discovery. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

interface PathReferenceData {
  readonly path: string
  readonly label: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    file: PathReferenceData
    folder: PathReferenceData
  }
}

function nextPath(text: string, from: number, folder: boolean) {
  const tokens = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu
  tokens.lastIndex = from
  for (let match = tokens.exec(text); match !== null; match = tokens.exec(text)) {
    const token = match[0]
    const raw = token.startsWith('@"') ? token : token.replace(/[.,;:!?，。；：！？]+$/u, '')
    if (raw.length <= 1) continue
    const path = raw.slice(1).replace(/^"|"$/gu, '')
    if (path.endsWith('/') !== folder) continue
    const label = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? raw.slice(1)
    return { start: match.index, end: match.index + raw.length, data: { path, label } }
  }
  return undefined
}

/** Return the nearest complete file reference using original whitespace boundaries. */
export const fileReferenceRule: UserTextRule<'file'> = {
  id: 'file',
  order: 30,
  match(text, from) {
    const candidate = nextPath(text, from, false)
    return candidate === undefined ? undefined : { id: 'file', ...candidate }
  },
}

/** Return the nearest trailing-slash directory using the file-reference grammar. */
export const folderReferenceRule: UserTextRule<'folder'> = {
  id: 'folder',
  order: 30,
  match(text, from) {
    const candidate = nextPath(text, from, true)
    return candidate === undefined ? undefined : { id: 'folder', ...candidate }
  },
}
