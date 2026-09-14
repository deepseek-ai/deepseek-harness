// @vitest-environment jsdom
/**
 * Composer editor pure core: ReferenceChipNode semantics, the three-view
 * projections, and detect-span application. Headless editors drive every
 * case — no React tree, no contenteditable; the chip's visual face has its
 * own component spec.
 */
import { describe, expect, it } from 'vitest'
import { createHeadlessEditor } from '@lexical/headless'
import type { LexicalEditor, NodeKey, ParagraphNode } from 'lexical'
import {
  $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $getSelection,
  $isTextNode, $setSelection,
} from 'lexical'
import type { ReferenceInsert } from '../src/client/contract/input.ts'
import {
  $createReferenceChipNode, $isReferenceChipNode, ReferenceChipNode,
} from '../src/client/input/editor/chip-node.tsx'
import { registerClaimDecoration } from '../src/client/input/editor/claim-decor.ts'
import { registerTextRefDecoration, TextRefNode } from '../src/client/input/editor/text-ref.ts'
import type { SerializedReferenceChipNode } from '../src/client/input/editor/chip-node.tsx'
import {
  $composerLayout, $detectOffsetOfPoint, $projectComposer, ATOMIC_CHAR,
} from '../src/client/input/editor/projection.ts'
import {
  $replaceDetectSpanWithNodes, $replaceDetectSpanWithText,
} from '../src/client/input/editor/span-map.ts'

const SESSION_REF: ReferenceInsert = {
  source: 'session-reference',
  ref: 'session-a',
  label: '随意回复不调用工具',
  appearance: 'session',
  clipboardText: '@session:随意回复不调用工具',
}

const SKILL_REF: ReferenceInsert = {
  source: 'skill',
  ref: 'commit-helper',
  label: 'commit-helper',
  clipboardText: '/commit-helper',
}

function makeEditor(): LexicalEditor {
  return createHeadlessEditor({
    namespace: 'core-spec',
    nodes: [ReferenceChipNode, TextRefNode],
    onError: (error) => { throw error },
  })
}

/** Ids per NodeKey the way the shell will assign them (stable, monotonic). */
function idAssigner(): (key: NodeKey) => number {
  const ids = new Map<NodeKey, number>()
  let seq = 0
  return (key) => {
    const existing = ids.get(key)
    if (existing !== undefined) return existing
    seq += 1
    ids.set(key, seq)
    return seq
  }
}

/** Seed one paragraph of mixed content and return the chip key. */
function seedMixed(editor: LexicalEditor): NodeKey {
  let chipKey = '' as NodeKey
  editor.update(() => {
    const p = $createParagraphNode()
    const chip = $createReferenceChipNode(SESSION_REF)
    chipKey = chip.getKey()
    p.append($createTextNode('ask '), chip, $createTextNode(' now'))
    $getRoot().append(p)
  }, { discrete: true })
  return chipKey
}

describe('ReferenceChipNode', () => {
  it('carries the owner projections and answers the clipboard text', () => {
    const editor = makeEditor()
    editor.update(() => {
      const chip = $createReferenceChipNode(SESSION_REF)
      expect(chip.getSource()).toBe('session-reference')
      expect(chip.getReference()).toBe('session-a')
      expect(chip.getLabel()).toBe('随意回复不调用工具')
      expect(chip.getAppearance()).toBe('session')
      expect(chip.getTextContent()).toBe('@session:随意回复不调用工具')
      expect(chip.isInvalid()).toBe(false)
      expect(chip.isInline()).toBe(true)
      expect(chip.isKeyboardSelectable()).toBe(false)
      expect($isReferenceChipNode(chip)).toBe(true)
      expect($isReferenceChipNode($createTextNode('x'))).toBe(false)
    }, { discrete: true })
  })

  it('round-trips JSON with and without an appearance', () => {
    const editor = makeEditor()
    editor.update(() => {
      const withIcon = $createReferenceChipNode(SESSION_REF).exportJSON()
      expect(withIcon.appearance).toBe('session')
      const backWithIcon = ReferenceChipNode.importJSON(withIcon)
      expect(backWithIcon.getAppearance()).toBe('session')
      expect(backWithIcon.getTextContent()).toBe(SESSION_REF.clipboardText)

      const bare = $createReferenceChipNode(SKILL_REF).exportJSON()
      expect('appearance' in bare).toBe(false)
      const backBare = ReferenceChipNode.importJSON(bare)
      expect(backBare.getAppearance()).toBeUndefined()
      expect(backBare.getLabel()).toBe('commit-helper')
    }, { discrete: true })
  })

  it('imports the invalid bit from JSON', () => {
    const editor = makeEditor()
    editor.update(() => {
      const json: SerializedReferenceChipNode = {
        ...$createReferenceChipNode(SKILL_REF).exportJSON(),
        invalid: true,
      }
      expect(ReferenceChipNode.importJSON(json).isInvalid()).toBe(true)
    }, { discrete: true })
  })

  it('flips the invalid bit through the writable transaction', () => {
    const editor = makeEditor()
    const chipKey = seedMixed(editor)
    editor.update(() => {
      const chip = [...$getRoot().getChildren()].flatMap(block =>
        'getChildren' in block ? (block as ParagraphNode).getChildren() : []).find($isReferenceChipNode)
      expect(chip?.getKey()).toBe(chipKey)
      chip?.setInvalid(true)
    }, { discrete: true })
    editor.read(() => {
      const chip = [...$getRoot().getChildren()].flatMap(block =>
        'getChildren' in block ? (block as ParagraphNode).getChildren() : []).find($isReferenceChipNode)
      expect(chip?.isInvalid()).toBe(true)
    })
  })

  it('mounts a non-editable inline host with the composer anchor', () => {
    const editor = makeEditor()
    seedMixed(editor)
    // Headless editors never call createDOM; exercise it directly.
    editor.read(() => {
      const chip = [...$getRoot().getChildren()].flatMap(block =>
        'getChildren' in block ? (block as ParagraphNode).getChildren() : []).find($isReferenceChipNode)
      expect(chip).toBeDefined()
      if (chip === undefined) return
      const el = chip.createDOM({ namespace: 'core-spec', theme: {} })
      expect(el.getAttribute('data-composer-chip')).toBe('session-reference')
      expect(el.getAttribute('contenteditable')).toBe('false')
      expect(chip.updateDOM()).toBe(false)
    })
  })
})

describe('$projectComposer', () => {
  it('projects the empty document', () => {
    const editor = makeEditor()
    editor.read(() => {
      const projection = $projectComposer(idAssigner())
      expect(projection.detectText).toBe('')
      expect(projection.clipboardText).toBe('')
      expect(projection.occurrences).toEqual([])
      expect(projection.caret).toBeNull()
    })
  })

  it('projects chips atomically in detect text and expanded in clipboard text', () => {
    const editor = makeEditor()
    seedMixed(editor)
    editor.read(() => {
      const projection = $projectComposer(idAssigner())
      expect(projection.detectText).toBe(`ask ${ATOMIC_CHAR} now`)
      expect(projection.clipboardText).toBe('ask @session:随意回复不调用工具 now')
      expect(projection.occurrences).toHaveLength(1)
      const occurrence = projection.occurrences[0]
      expect(occurrence).toMatchObject({
        occurrenceId: 1,
        source: 'session-reference',
        ref: 'session-a',
        offset: 4,
        length: SESSION_REF.clipboardText.length,
        label: SESSION_REF.label,
        appearance: 'session',
        clipboardText: SESSION_REF.clipboardText,
      })
      expect(occurrence !== undefined && 'invalid' in occurrence).toBe(false)
    })
  })

  it('marks invalid chips and keeps ids stable across projections', () => {
    const editor = makeEditor()
    const chipKey = seedMixed(editor)
    const idOf = idAssigner()
    editor.read(() => {
      expect($projectComposer(idOf).occurrences[0]?.occurrenceId).toBe(1)
    })
    editor.update(() => {
      const layout = $composerLayout()
      const chip = layout.segments.find(segment => segment.kind === 'chip')?.node
      if ($isReferenceChipNode(chip)) chip.setInvalid(true)
    }, { discrete: true })
    editor.read(() => {
      const projection = $projectComposer(idOf)
      expect(projection.occurrences[0]?.occurrenceId).toBe(1)
      expect(projection.occurrences[0]?.invalid).toBe(true)
      void chipKey
    })
  })

  it('projects paragraph gaps and line breaks as newlines in both views', () => {
    const editor = makeEditor()
    editor.update(() => {
      const first = $createParagraphNode()
      first.append($createTextNode('a'), $createLineBreakNode(), $createTextNode('b'))
      const second = $createParagraphNode()
      second.append($createTextNode('c'))
      $getRoot().append(first, second)
    }, { discrete: true })
    editor.read(() => {
      const projection = $projectComposer(idAssigner())
      expect(projection.detectText).toBe('a\nb\nc')
      expect(projection.clipboardText).toBe('a\nb\nc')
    })
  })

  it('folds a collapsed text-point selection to a detect caret', () => {
    const editor = makeEditor()
    seedMixed(editor)
    editor.update(() => {
      const text = $getRoot().getAllTextNodes()[0]
      if ($isTextNode(text)) text.select(2, 2)
    }, { discrete: true })
    editor.read(() => {
      expect($projectComposer(idAssigner()).caret).toBe(2)
    })
  })

  it('reports null caret for ranged and absent selections', () => {
    const editor = makeEditor()
    seedMixed(editor)
    editor.update(() => {
      const text = $getRoot().getAllTextNodes()[0]
      if ($isTextNode(text)) text.select(0, 2)
    }, { discrete: true })
    editor.read(() => {
      expect($projectComposer(idAssigner()).caret).toBeNull()
    })
    editor.update(() => { $setSelection(null) }, { discrete: true })
    editor.read(() => {
      expect($projectComposer(idAssigner()).caret).toBeNull()
    })
  })

  it('folds element points: chip-adjacent and paragraph-end positions', () => {
    const editor = makeEditor()
    seedMixed(editor)
    editor.update(() => {
      // Element point at child index 1 = right before the chip (detect 4).
      const p = $getRoot().getFirstChild()
      if (p === null) throw new Error('paragraph missing')
      const selection = $getSelection()
      void selection
      const paragraph = p as ParagraphNode
      paragraph.select(1, 1)
    }, { discrete: true })
    editor.read(() => {
      expect($projectComposer(idAssigner()).caret).toBe(4)
    })
    editor.update(() => {
      const p = $getRoot().getFirstChild() as ParagraphNode
      p.select(3, 3) // after the trailing text child = paragraph end (detect 9)
    }, { discrete: true })
    editor.read(() => {
      expect($projectComposer(idAssigner()).caret).toBe(`ask ${ATOMIC_CHAR} now`.length)
    })
  })

  it('returns null for points that reference unknown nodes', () => {
    const editor = makeEditor()
    seedMixed(editor)
    editor.read(() => {
      const layout = $composerLayout()
      expect($detectOffsetOfPoint(layout, { key: 'missing', offset: 0, type: 'text' } as never)).toBeNull()
      expect($detectOffsetOfPoint(layout, { key: 'missing', offset: 0, type: 'element' } as never)).toBeNull()
    })
  })
})

describe('detect-span application', () => {
  it('replaces a mid-text span with text and lands the caret after it', () => {
    const editor = makeEditor()
    editor.update(() => {
      const p = $createParagraphNode()
      p.append($createTextNode('hello world'))
      $getRoot().append(p)
    }, { discrete: true })
    editor.update(() => {
      expect($replaceDetectSpanWithText({ start: 6, end: 11 }, 'there')).toBe(true)
    }, { discrete: true })
    editor.read(() => {
      const projection = $projectComposer(idAssigner())
      expect(projection.clipboardText).toBe('hello there')
      expect(projection.caret).toBe(11)
    })
  })

  it('replaces a trigger token span with a chip node', () => {
    const editor = makeEditor()
    editor.update(() => {
      const p = $createParagraphNode()
      p.append($createTextNode('see @ses please'))
      $getRoot().append(p)
    }, { discrete: true })
    editor.update(() => {
      expect($replaceDetectSpanWithNodes({ start: 4, end: 8 }, [$createReferenceChipNode(SESSION_REF)])).toBe(true)
    }, { discrete: true })
    editor.read(() => {
      const projection = $projectComposer(idAssigner())
      expect(projection.detectText).toBe(`see ${ATOMIC_CHAR} please`)
      expect(projection.occurrences).toHaveLength(1)
      expect(projection.caret).toBe(5)
    })
  })

  it('deletes a span with empty replacement text (consume-token shape)', () => {
    const editor = makeEditor()
    editor.update(() => {
      const p = $createParagraphNode()
      p.append($createTextNode('/goal keep'))
      $getRoot().append(p)
    }, { discrete: true })
    editor.update(() => {
      expect($replaceDetectSpanWithText({ start: 0, end: 6 }, '')).toBe(true)
    }, { discrete: true })
    editor.read(() => {
      expect($projectComposer(idAssigner()).clipboardText).toBe('keep')
    })
  })

  it('removes a chip whose range the span covers (claim over a chip)', () => {
    const editor = makeEditor()
    seedMixed(editor)
    editor.update(() => {
      // [0, 5) covers 'ask ' plus the chip.
      expect($replaceDetectSpanWithText({ start: 0, end: 5 }, '/goal ')).toBe(true)
    }, { discrete: true })
    editor.read(() => {
      const projection = $projectComposer(idAssigner())
      expect(projection.detectText).toBe('/goal  now')
      expect(projection.occurrences).toEqual([])
    })
  })

  it('merges paragraphs when the span crosses a gap', () => {
    const editor = makeEditor()
    editor.update(() => {
      const first = $createParagraphNode()
      first.append($createTextNode('one'))
      const second = $createParagraphNode()
      second.append($createTextNode('two'))
      $getRoot().append(first, second)
    }, { discrete: true })
    editor.update(() => {
      expect($replaceDetectSpanWithText({ start: 2, end: 5 }, '-')).toBe(true)
    }, { discrete: true })
    editor.read(() => {
      expect($projectComposer(idAssigner()).clipboardText).toBe('on-wo')
    })
  })

  it('inserts into the empty document and grows a paragraph', () => {
    const editor = makeEditor()
    editor.update(() => {
      expect($replaceDetectSpanWithText({ start: 0, end: 0 }, 'seed')).toBe(true)
    }, { discrete: true })
    editor.read(() => {
      expect($projectComposer(idAssigner()).clipboardText).toBe('seed')
    })
  })

  it('inserts at a chip boundary without touching the chip', () => {
    const editor = makeEditor()
    seedMixed(editor)
    editor.update(() => {
      expect($replaceDetectSpanWithText({ start: 4, end: 4 }, '@')).toBe(true)
    }, { discrete: true })
    editor.read(() => {
      const projection = $projectComposer(idAssigner())
      expect(projection.detectText).toBe(`ask @${ATOMIC_CHAR} now`)
      expect(projection.occurrences).toHaveLength(1)
    })
  })

  it('rejects out-of-bounds and inverted spans', () => {
    const editor = makeEditor()
    seedMixed(editor)
    editor.update(() => {
      expect($replaceDetectSpanWithText({ start: 0, end: 99 }, 'x')).toBe(false)
      expect($replaceDetectSpanWithText({ start: 5, end: 4 }, 'x')).toBe(false)
      expect($replaceDetectSpanWithText({ start: -1, end: 2 }, 'x')).toBe(false)
      expect($replaceDetectSpanWithNodes({ start: 0, end: 99 }, [])).toBe(false)
    }, { discrete: true })
  })

  it('selects the whole document across blocks (submit-clear shape)', () => {
    const editor = makeEditor()
    editor.update(() => {
      const first = $createParagraphNode()
      first.append($createTextNode('a'), $createReferenceChipNode(SKILL_REF))
      const second = $createParagraphNode()
      second.append($createTextNode('b'))
      $getRoot().append(first, second)
    }, { discrete: true })
    editor.update(() => {
      const layout = $composerLayout()
      expect($replaceDetectSpanWithText({ start: 0, end: layout.detectLength }, '')).toBe(true)
    }, { discrete: true })
    editor.read(() => {
      const projection = $projectComposer(idAssigner())
      expect(projection.clipboardText).toBe('')
      expect(projection.occurrences).toEqual([])
    })
  })
})

describe('claim precedence over text-ref entities', () => {
  const TOKEN_STYLE = 'color: var(--dsw-alias-state-warn-label)'
  const LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map([['/', ['plan']]])

  it.each(['/plan', '/plan '])('keeps the lexicon-listed %j claim plain and warn-styled until release', (token) => {
    const editor = makeEditor()
    let claim: string | null = token
    registerClaimDecoration(editor, () => claim)
    registerTextRefDecoration(editor, () => LEXICON, () => claim)
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('/plan rest'))
      $getRoot().clear().append(paragraph)
    }, { discrete: true })
    const leaf = (): { type: string; style: string; text: string } | null =>
      editor.getEditorState().read(() => {
        const first = ($getRoot().getFirstChild() as ParagraphNode).getFirstChild()
        return first === null ? null : {
          type: first.getType(),
          style: $isTextNode(first) ? first.getStyle() : '',
          text: first.getTextContent(),
        }
      })
    // Claimed: the entity transform yields the seat, the claim transform styles it.
    expect(leaf()).toEqual({ type: 'text', style: TOKEN_STYLE, text: token })
    // Released (the shell's refresh nudges the seat dirty): the entity captures it.
    claim = null
    editor.update(() => {
      const first = ($getRoot().getFirstChild() as ParagraphNode).getFirstChild()
      if ($isTextNode(first)) first.markDirty()
    }, { discrete: true })
    expect(leaf()).toEqual({ type: 'composer-text-ref', style: '', text: '/plan' })
    // Re-claimed: the entity reverts to plain text and the warn style returns.
    claim = token
    editor.update(() => {
      const first = ($getRoot().getFirstChild() as ParagraphNode).getFirstChild()
      if ($isTextNode(first)) first.markDirty()
    }, { discrete: true })
    expect(leaf()).toEqual({ type: 'text', style: TOKEN_STYLE, text: token })
  })
})
