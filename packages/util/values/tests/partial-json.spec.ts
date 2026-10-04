import { describe, expect, it, vi } from 'vitest'
import { type JsonValue, PartialArguments } from '../src/index.ts'

/** Complete, valid objects exercising strings, escapes, scalars, nested values, and whitespace. */
const CLOSED_TEXTS = [
  String.raw`{"file_path":"src/a.ts","content":"line 1\nline \"2\"\t\u4e2d\ud83d\ude00","n":-1.5e3,"t":true}`,
  String.raw` { "skip" : "a\"}{b\\" , "todos" : [ { "content" : "x}" } , [ [ ] ] ] , "file_path" : "y" , "content" : "\u00E9" } `,
  String.raw`{"n":1 ,"content":"","m":null}`,
  String.raw`{"o":{"k":[1,2,{"s":"\u00e9]}"}]},"n":-0.5e1}`,
  String.raw`{"file\u005fpath":"x","content":"a\\b\/c"}`,
  String.raw`{"__proto__":{"polluted":true},"constructor":"c","a":1}`,
  '{}',
]

/** Invalid structure or value contents, inspected by the full-reader oracle. */
const INVALID_TEXTS = [
  String.raw`{"file_path":"ab\q"}`,
  String.raw`{"file_path":"ab\u12G4"}`,
  '{"file_path":"ab\nc"}',
  '{"file_path":"ab\tc"}',
  String.raw`{"a":[1,{"b":tru}]}`,
  String.raw`{"n":1.}`,
  '{"a":"b" x',
]

/** Cut `text` into consecutive slices whose sizes come from `nextSize`. */
function slices(text: string, nextSize: () => number): string[] {
  const out: string[] = []
  for (let index = 0; index < text.length;) {
    const size = nextSize()
    out.push(text.slice(index, index + size))
    index += size
  }
  return out
}

/** Deterministic slice sizes in 1..3 (mulberry32), so a failing split is reproducible from its seed. */
function seededSizes(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) % 3 + 1
  }
}

interface FieldView {
  readonly has: boolean
  readonly complete: boolean
  readonly length: number | undefined
  readonly prefix: string | undefined
  readonly exceeds: boolean
  readonly text: string | undefined
  readonly value: JsonValue | undefined
}

interface ViewSnapshot {
  readonly invalid: boolean
  readonly closed: boolean
  readonly keys: readonly string[]
  readonly fields: readonly (readonly [string, FieldView])[]
}

/** Read every answer for `keys` (default: the view's own keys); on a streaming view this also registers the reads. */
function snapshotOf(view: PartialArguments, keys: readonly string[] = view.keys()): ViewSnapshot {
  const fields = keys.map((key): readonly [string, FieldView] => {
    const length = view.stringLength(key)
    const prefix = view.textPrefix(key, 4)
    const exceeds = view.stringExceeds(key, 4)
    const text = view.text(key)
    const value = view.value(key)
    return [key, { has: view.has(key), complete: view.complete(key), length, prefix, exceeds, text, value }]
  })
  return {
    invalid: view.invalid,
    closed: view.closed(),
    keys: [...view.keys()],
    fields,
  }
}

function streamed(chunks: readonly string[]): PartialArguments {
  const view = new PartialArguments()
  for (const chunk of chunks) view.append(chunk)
  return view
}

function appendAndRefresh(view: PartialArguments, fragment: string): boolean {
  view.append(fragment)
  return view.refresh()
}

describe('PartialArguments', () => {
  describe('sealed views', () => {
    it('reports sealing independently of object closure and preserves append rejection', () => {
      const view = streamed(['{"a":"value"}'])
      expect(view.closed()).toBe(true)
      expect(view.isSealed).toBe(false)
      view.append(' ')
      expect(view.settle('{"a":"value"} ')).toBe(view)
      expect(view.isSealed).toBe(true)
      expect(() => { view.append('') }).toThrow('cannot append to a sealed view')
      expect(PartialArguments.EMPTY.isSealed).toBe(true)
      expect(PartialArguments.fromText('{"a":"unfinished').isSealed).toBe(true)
      const partial = streamed(['{"a":"old'])
      expect(partial.settle('{"a":"new"}').isSealed).toBe(true)
      expect(partial.isSealed).toBe(false)
    })

    it('reads sealing without scanning or observing streamed text', () => {
      const view = streamed(['{"a":"value'])
      const search = vi.spyOn(String.prototype, 'indexOf')
      let sealed: boolean
      let searches: number
      try {
        sealed = view.isSealed
        searches = search.mock.calls.length
      } finally {
        search.mockRestore()
      }
      expect(sealed).toBe(false)
      expect(searches).toBe(0)
      view.append(' grows"}')
      expect(view.refresh()).toBe(false)
    })

    it('EMPTY answers every reader with absence and refuses appends', () => {
      const empty = PartialArguments.EMPTY
      expect(empty.keys()).toEqual([])
      expect(empty.has('x')).toBe(false)
      expect(empty.complete('x')).toBe(false)
      expect(empty.stringLength('x')).toBeUndefined()
      expect(empty.text('x')).toBeUndefined()
      expect(empty.value('x')).toBeUndefined()
      expect(empty.invalid).toBe(false)
      expect(() => { empty.append('{') }).toThrow('cannot append to a sealed view')
    })

    it('reports every sealed view as closed, whatever its text says', () => {
      expect(PartialArguments.EMPTY.closed()).toBe(true)
      expect(PartialArguments.fromObject({ a: 1 }).closed()).toBe(true)
      expect(PartialArguments.fromObject(null).closed()).toBe(true)
      for (const text of [...CLOSED_TEXTS, ...INVALID_TEXTS, '', '{"a":1']) {
        expect(PartialArguments.fromText(text).closed()).toBe(true)
      }
    })

    it('never answers with inherited Object.prototype members', () => {
      for (const view of [PartialArguments.EMPTY, PartialArguments.fromObject({ a: 1 })]) {
        for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
          expect(view.has(key)).toBe(false)
          expect(view.complete(key)).toBe(false)
          expect(view.value(key)).toBeUndefined()
          expect(view.text(key)).toBeUndefined()
          expect(view.stringLength(key)).toBeUndefined()
        }
      }
    })

    it('fromObject reads strings and other values straight from the parsed object', () => {
      const view = PartialArguments.fromObject({ file_path: 'src/a.ts', empty: '', n: 12.5, z: null, o: { k: [1] }, a: [1, 'x'] })
      expect(view.keys()).toEqual(['file_path', 'empty', 'n', 'z', 'o', 'a'])
      expect(view.stringLength('file_path')).toBe(8)
      expect(view.text('file_path')).toBe('src/a.ts')
      expect(view.value('file_path')).toBeUndefined()
      expect(view.stringLength('empty')).toBe(0)
      expect(view.text('empty')).toBe('')
      expect(view.value('n')).toBe(12.5)
      expect(view.value('z')).toBeNull()
      expect(view.value('o')).toStrictEqual({ k: [1] })
      expect(view.value('a')).toStrictEqual([1, 'x'])
      expect(view.stringLength('n')).toBeUndefined()
      expect(view.text('n')).toBeUndefined()
      for (const key of view.keys()) {
        expect(view.has(key)).toBe(true)
        expect(view.complete(key)).toBe(true)
      }
      expect(view.has('missing')).toBe(false)
      expect(view.complete('missing')).toBe(false)
      expect(view.value('missing')).toBeUndefined()
      expect(view.invalid).toBe(false)
      expect(() => { view.append('{') }).toThrow('cannot append to a sealed view')
    })

    it('fromObject treats anything but an object as a call without fields', () => {
      for (const input of [undefined, null, 'str', 42, true, [1, 2]]) {
        const view = PartialArguments.fromObject(input)
        expect(view.keys()).toEqual([])
        expect(view.has('0')).toBe(false)
        expect(view.value('0')).toBeUndefined()
      }
    })

    it('fromText answers exactly like fromObject over the parsed text, and refuses appends', () => {
      for (const text of CLOSED_TEXTS) {
        const fromText = PartialArguments.fromText(text)
        expect(snapshotOf(fromText)).toStrictEqual(snapshotOf(PartialArguments.fromObject(JSON.parse(text))))
        expect(() => { fromText.append(' ') }).toThrow('cannot append to a sealed view')
      }
      expect('polluted' in {}).toBe(false)
    })

    it('fromText reports invalid contents when read and retains independent fields', () => {
      for (const text of INVALID_TEXTS) expect(snapshotOf(PartialArguments.fromText(text)).invalid).toBe(true)
      const view = PartialArguments.fromText('{"n":1,"b":tru}')
      expect(view.invalid).toBe(false)
      expect(view.value('n')).toBe(1)
      expect(view.has('b')).toBe(true)
      expect(view.complete('b')).toBe(true)
      expect(view.value('b')).toBeUndefined()
      expect(view.invalid).toBe(true)
      expect(view.complete('b')).toBe(false)
    })

    it('scans nothing until a reader asks', () => {
      const parse = vi.spyOn(JSON, 'parse')
      try {
        const sealed = PartialArguments.fromText('{"todos":[1],"n":2}')
        const streaming = new PartialArguments()
        expect(appendAndRefresh(streaming, '{"todos":[1],')).toBe(false)
        expect(appendAndRefresh(streaming, '"n":2}')).toBe(false)
        expect(parse).not.toHaveBeenCalled()

        expect(sealed.keys()).toEqual(['todos', 'n'])
        expect(sealed.has('todos')).toBe(true)
        expect(sealed.complete('todos')).toBe(true)
        expect(sealed.invalid).toBe(false)
        expect(streaming.keys()).toEqual(['todos', 'n'])
        expect(streaming.has('todos')).toBe(true)
        expect(streaming.complete('todos')).toBe(true)
        expect(parse).not.toHaveBeenCalled()

        expect(streaming.value('todos')).toStrictEqual([1])
        expect(parse).toHaveBeenCalledExactlyOnceWith('[1]')
        const todos = streaming.value('todos')
        expect(streaming.value('todos')).toBe(todos)
        expect(parse).toHaveBeenCalledTimes(1)
        expect(streaming.value('n')).toBe(2)
        expect(parse).toHaveBeenCalledTimes(2)
        expect(parse).toHaveBeenLastCalledWith('2')
      } finally {
        parse.mockRestore()
      }
    })
  })

  describe('settlement', () => {
    it('seals matching chunks without joining and retains previously read values', () => {
      const view = new PartialArguments()
      view.append(String.raw`{"command":"a\u4e`)
      expect(view.text('command')).toBe('a')
      expect(view.stringLength('command')).toBe(1)
      expect(view.textPrefix('command', 2)).toBe('a')
      expect(view.complete('command')).toBe(false)
      view.append('2d","todos":[1]}')
      const todos = view.value('todos')
      expect(todos).toEqual([1])
      const finalText = String.raw`{"command":"a\u4e2d","todos":[1]}`
      const join = vi.spyOn(Array.prototype, 'join')
      let settled: PartialArguments
      let joins: number
      try {
        settled = view.settle(finalText)
        joins = join.mock.calls.length
      } finally {
        join.mockRestore()
      }
      expect(joins).toBe(0)
      expect(settled).toBe(view)
      expect(view).toEqual(PartialArguments.fromText(finalText))
      expect(view.text('command')).toBe('a中')
      expect(view.stringLength('command')).toBe(2)
      expect(view.textPrefix('command', 2)).toBe('a中')
      expect(view.complete('command')).toBe(true)
      expect(view.value('todos')).toBe(todos)
      expect(view.closed()).toBe(true)
      expect(view.invalid).toBe(false)
      expect(view.refresh()).toBe(true)
      expect(view.refresh()).toBe(false)
      expect(view.settle(finalText)).toBe(view)
      expect(() => { view.append(' ') }).toThrow('cannot append to a sealed view')
    })

    it('leaves matching unread containers unparsed until requested after settlement', () => {
      const view = streamed(['{"items":', '[1,2]}'])
      const parse = vi.spyOn(JSON, 'parse')
      try {
        expect(view.settle('{"items":[1,2]}')).toBe(view)
        expect(view.keys()).toEqual(['items'])
        expect(view.has('items')).toBe(true)
        expect(view.complete('items')).toBe(true)
        expect(parse).not.toHaveBeenCalled()
        expect(view.value('items')).toEqual([1, 2])
        expect(parse).toHaveBeenCalledExactlyOnceWith('[1,2]')
      } finally {
        parse.mockRestore()
      }
    })

    it.each<[string, readonly string[], string, string, string]>([
      ['same-length conflicting text', ['x"}'], '{"a":"y"}', 'x', 'y'],
      ['missing deltas', ['x'], '{"a":"xy"}', 'x', 'xy'],
      ['duplicate deltas', ['x', 'x"}'], '{"a":"x"}', 'xx', 'x'],
    ])('uses final text after %s without changing the streaming view', (_label, tail, finalText, before, after) => {
      const view = new PartialArguments()
      view.append('{"a":"')
      expect(view.text('a')).toBe('')
      expect(view.textPrefix('a', 1)).toBe('')
      for (const chunk of tail) view.append(chunk)
      expect(view.text('a')).toBe(before)
      const original = streamed(['{"a":"', ...tail])
      const settled = view.settle(finalText)
      expect(settled).not.toBe(view)
      expect(settled).toEqual(PartialArguments.fromText(finalText))
      expect(settled.text('a')).toBe(after)
      expect(settled.stringLength('a')).toBe(after.length)
      expect(settled.closed()).toBe(true)
      expect(settled.refresh()).toBe(false)
      expect(view).toEqual(original)
      expect(view.text('a')).toBe(before)
      expect(view.refresh()).toBe(true)
      expect(view.refresh()).toBe(false)
      expect(() => { view.append(' ') }).not.toThrow()
      expect(() => { settled.append(' ') }).toThrow('cannot append to a sealed view')
    })

    it('does not carry an invalid reader cache into corrected authoritative text', () => {
      const view = streamed([String.raw`{"a":"ab\q"}`])
      expect(view.text('a')).toBe('ab')
      expect(view.invalid).toBe(true)
      const settled = view.settle(String.raw`{"a":"ab\n"}`)
      expect(settled).not.toBe(view)
      expect(settled.text('a')).toBe('ab\n')
      expect(settled.complete('a')).toBe(true)
      expect(settled.invalid).toBe(false)
      expect(view.text('a')).toBe('ab')
      expect(view.invalid).toBe(true)
    })

    it('seals empty text and uses authoritative text for an object-backed view', () => {
      const empty = streamed(['', ''])
      expect(empty.settle('')).toBe(empty)
      expect(empty.closed()).toBe(true)
      expect(empty.keys()).toEqual([])
      expect(empty).toEqual(PartialArguments.fromText(''))
      expect(() => { empty.append('{}') }).toThrow('cannot append to a sealed view')
      const object = PartialArguments.fromObject({ a: 'old' })
      const settled = object.settle('{"a":"new"}')
      expect(settled).not.toBe(object)
      expect(settled.text('a')).toBe('new')
      expect(object.text('a')).toBe('old')
    })
  })

  describe('structural equality', () => {
    it('compares two views by their source alone, however far each has been read', () => {
      for (const text of [...CLOSED_TEXTS, ...INVALID_TEXTS]) {
        const read = PartialArguments.fromText(text)
        snapshotOf(read)
        const fresh = PartialArguments.fromText(text)
        expect(read).toEqual(fresh)
        expect(fresh).toEqual(read)

        const eager = new PartialArguments()
        snapshotOf(eager, fresh.keys())
        eager.append(text)
        const untouched = new PartialArguments()
        untouched.append(text)
        expect(eager).toEqual(untouched)
      }
      const object = { file_path: 'src/a.ts', n: 1 }
      const readObject = PartialArguments.fromObject(object)
      snapshotOf(readObject)
      expect(readObject).toEqual(PartialArguments.fromObject(object))
    })

    it('distinguishes a streaming view from a sealed view of the same text even though every reader agrees', () => {
      const text = String.raw`{"file_path":"src/a.ts","content":"a\nb","n":1,"todos":[{"content":"x"}]}`
      const sealed = PartialArguments.fromText(text)
      const streaming = streamed(slices(text, seededSizes(3)))
      expect(streaming).not.toEqual(sealed)
      const answers = snapshotOf(streaming)
      expect({ ...answers, closed: sealed.closed() }).toStrictEqual(snapshotOf(sealed))
      expect(answers.closed).toBe(true)
    })

    it('distinguishes views of different sources', () => {
      expect(PartialArguments.fromText('{"a":1}')).not.toEqual(PartialArguments.fromText('{"a":2}'))
      expect(PartialArguments.fromText('{"a":1}')).not.toEqual(PartialArguments.fromText('{"a":1} '))
      expect(PartialArguments.fromObject({ a: 1 })).not.toEqual(PartialArguments.fromObject({ a: 2 }))
      expect(PartialArguments.fromText('{}')).not.toEqual(PartialArguments.EMPTY)
    })
  })

  describe('streaming readers', () => {
    it('distinguishes an open string, a closed string, a pending value, a closed value, and an absent key', () => {
      const view = new PartialArguments()
      view.append('{"file_path":"ab')
      expect(view.keys()).toEqual(['file_path'])
      expect(view.has('file_path')).toBe(true)
      expect(view.complete('file_path')).toBe(false)
      expect(view.stringLength('file_path')).toBe(2)
      expect(view.text('file_path')).toBe('ab')
      expect(view.value('file_path')).toBeUndefined()

      view.append('","content":"xy')
      expect(view.complete('file_path')).toBe(true)
      expect(view.text('file_path')).toBe('ab')
      expect(view.complete('content')).toBe(false)
      expect(view.stringLength('content')).toBe(2)
      expect(view.text('content')).toBe('xy')

      view.append('","n":12')
      expect(view.keys()).toEqual(['file_path', 'content', 'n'])
      expect(view.has('n')).toBe(true)
      expect(view.complete('n')).toBe(false)
      expect(view.value('n')).toBeUndefined()
      expect(view.stringLength('n')).toBeUndefined()
      expect(view.text('n')).toBeUndefined()

      view.append('}')
      expect(view.complete('n')).toBe(true)
      expect(view.value('n')).toBe(12)
      expect(view.has('missing')).toBe(false)
      expect(view.complete('missing')).toBe(false)
      expect(view.stringLength('missing')).toBeUndefined()
      expect(view.text('missing')).toBeUndefined()
      expect(view.value('missing')).toBeUndefined()
      expect(view.invalid).toBe(false)
    })

    it('reports every top-level field of a finished object', () => {
      const view = streamed(['{"file_path":"src/a.ts","content":"hello","n":1,"o":{"file_path":"inner"},"a":[1,2]}'])
      expect(view.keys()).toEqual(['file_path', 'content', 'n', 'o', 'a'])
      expect(view.text('file_path')).toBe('src/a.ts')
      expect(view.stringLength('file_path')).toBe(8)
      expect(view.stringLength('content')).toBe(5)
      expect(view.value('n')).toBe(1)
      expect(view.value('o')).toStrictEqual({ file_path: 'inner' })
      expect(view.value('a')).toStrictEqual([1, 2])
      expect(view.text('o')).toBeUndefined()
      expect(view.value('file_path')).toBeUndefined()
      for (const key of view.keys()) expect(view.complete(key)).toBe(true)
      expect(view.invalid).toBe(false)
    })

    it('treats "__proto__" and Object.prototype member names as ordinary keys', () => {
      const flat = streamed(['{"__proto__":"x","constructor":"c","a":1}'])
      expect(flat.keys()).toEqual(['__proto__', 'constructor', 'a'])
      expect(flat.has('__proto__')).toBe(true)
      expect(flat.text('__proto__')).toBe('x')
      expect(flat.text('constructor')).toBe('c')
      expect(flat.value('a')).toBe(1)

      const nested = streamed(['{"__proto__":{"polluted":true}}'])
      expect(nested.keys()).toEqual(['__proto__'])
      expect(nested.value('__proto__')).toStrictEqual({ polluted: true })
      const parsed = PartialArguments.fromObject(JSON.parse('{"__proto__":{"polluted":true}}'))
      expect(parsed.keys()).toEqual(['__proto__'])
      expect(parsed.value('__proto__')).toStrictEqual({ polluted: true })
      expect('polluted' in {}).toBe(false)
    })

    it('reports numbers and literals once a comma, whitespace, or the closing brace ends them', () => {
      const byComma = streamed(['{"n":12.5,"b":true,"z":null,"file_path":"p"}'])
      expect(byComma.value('n')).toBe(12.5)
      expect(byComma.value('b')).toBe(true)
      expect(byComma.value('z')).toBeNull()
      expect(byComma.has('z')).toBe(true)
      expect(byComma.complete('z')).toBe(true)
      expect(byComma.text('file_path')).toBe('p')

      const byBrace = streamed(['{"file_path":"p","n":-1e3}'])
      expect(byBrace.value('n')).toBe(-1000)
      expect(byBrace.invalid).toBe(false)

      const byWhitespace = streamed(['{"n":1 ,"file_path":"p","m":false\n}'])
      expect(byWhitespace.value('n')).toBe(1)
      expect(byWhitespace.value('m')).toBe(false)
      expect(byWhitespace.invalid).toBe(false)
      expect(streamed(['{"n":1 }']).value('n')).toBe(1)
    })

    it('holds a number or literal open until its delimiter arrives', () => {
      const view = new PartialArguments()
      view.append('{"n":12')
      expect(view.has('n')).toBe(true)
      expect(view.complete('n')).toBe(false)
      expect(view.value('n')).toBeUndefined()
      view.append('.5')
      expect(view.value('n')).toBeUndefined()
      view.append(',')
      expect(view.complete('n')).toBe(true)
      expect(view.value('n')).toBe(12.5)
      view.append('"t":tru')
      expect(view.value('t')).toBeUndefined()
      view.append('e}')
      expect(view.value('t')).toBe(true)
      expect(view.invalid).toBe(false)
    })

    it('parses a nested value when its matching bracket closes, ignoring brackets and escapes inside nested strings', () => {
      const todos = [{ content: 'x}' }, { content: ']"\\' }, [[]], { deep: { a: [1, { b: '}' }] } }]
      const view = new PartialArguments()
      view.append(String.raw`{"todos":[{"content":"x}"},{"content":"]\"\\"},[[]],{"deep":{"a":[1,{"b":"}"}]}}`)
      expect(view.has('todos')).toBe(true)
      expect(view.complete('todos')).toBe(false)
      expect(view.value('todos')).toBeUndefined()
      expect(view.has('content')).toBe(false)
      view.append(']')
      expect(view.complete('todos')).toBe(true)
      expect(view.value('todos')).toStrictEqual(todos)
      view.append(',"file_path":"y"}')
      expect(view.keys()).toEqual(['todos', 'file_path'])
      expect(view.text('file_path')).toBe('y')
      expect(view.invalid).toBe(false)
    })

    it('reports a string whose quotes, backslashes, and braces are escaped by decoded length and text', () => {
      const view = streamed([String.raw`{"skip":"a\"}{b\\","file_path":"x"}`])
      expect(view.stringLength('skip')).toBe(6)
      expect(view.text('skip')).toBe('a"}{b\\')
      expect(view.text('file_path')).toBe('x')
      expect(view.invalid).toBe(false)
    })
  })

  describe('escapes', () => {
    it.each<[string, string, string, string]>([
      ['odd backslash run', String.raw`{"command":"a\\`, String.raw`\"b","later":"ok"}`, 'a\\"b'],
      ['even backslash run', String.raw`{"command":"a\\`, String.raw`\\","later":"ok"}`, 'a\\\\'],
      ['Unicode quote', String.raw`{"command":"a\u00`, '22b","later":"ok"}', 'a"b'],
    ])('keeps a split %s inside its string field', (_label, head, tail, expected) => {
      const view = new PartialArguments()
      view.append(head)
      expect(view.keys()).toEqual(['command'])
      expect(view.complete('command')).toBe(false)
      expect(view.has('later')).toBe(false)
      view.text('command')
      view.stringLength('command')
      view.append(tail)
      expect(view.keys()).toEqual(['command', 'later'])
      expect(view.complete('command')).toBe(true)
      expect(view.text('command')).toBe(expected)
      expect(view.stringLength('command')).toBe(expected.length)
      expect(view.text('later')).toBe('ok')
      expect(view.invalid).toBe(false)
    })

    it('keeps escaped nested quotes inside an unread container across one-character chunks', () => {
      const text = String.raw`{"items":["a\\\"b","a\\\\","\u0022"],"later":"ok"}`
      const view = new PartialArguments()
      for (const chunk of text) {
        view.append(chunk)
        view.keys()
      }
      expect(view.keys()).toEqual(['items', 'later'])
      expect(view.complete('items')).toBe(true)
      expect(view.text('later')).toBe('ok')
      expect(view.value('items')).toEqual(['a\\"b', 'a\\\\', '"'])
      expect(view.invalid).toBe(false)
    })

    it('decodes every simple escape', () => {
      const view = streamed([String.raw`{"file_path":"\"\\\/\b\f\n\r\t"}`])
      expect(view.stringLength('file_path')).toBe(8)
      expect(view.text('file_path')).toBe('"\\/\b\f\n\r\t')
    })

    it('decodes \\uXXXX escapes in either hex case', () => {
      const view = streamed([String.raw`{"file_path":"\u4E2D\u00e9"}`])
      expect(view.stringLength('file_path')).toBe(2)
      expect(view.text('file_path')).toBe('中é')
    })

    it('decodes a \\uXXXX escape split across appends, whether the text was read before or only after', () => {
      const chunkings = [[String.raw`{"file_path":"\u4e`, '2d"}'], ['{"file_path":"\\', 'u', '4', 'e2', 'd"}']]
      for (const chunks of chunkings) {
        const lazy = streamed(chunks)
        expect(lazy.text('file_path')).toBe('中')
        expect(lazy.stringLength('file_path')).toBe(1)

        const eager = new PartialArguments()
        expect(eager.text('file_path')).toBeUndefined()
        for (const chunk of chunks) appendAndRefresh(eager, chunk)
        expect(eager.text('file_path')).toBe('中')
        expect(eager.stringLength('file_path')).toBe(1)
      }
    })

    it('decodes a surrogate pair of two \\u escapes into one code point counted as two UTF-16 units', () => {
      const view = new PartialArguments()
      view.append(String.raw`{"file_path":"\ud83d`)
      expect(view.text('file_path')).toBe('\ud83d')
      expect(view.stringLength('file_path')).toBe(1)
      view.append(String.raw`\ude00"}`)
      expect(view.text('file_path')).toBe('😀')
      expect(view.stringLength('file_path')).toBe(2)
      expect(PartialArguments.fromText(String.raw`{"content":"\u00e9\ud83d\ude00"}`).stringLength('content')).toBe(3)
    })
  })

  describe('lazy text reads', () => {
    it('decodes the streamed prefix on first read, including complete escapes, then keeps it current', () => {
      const view = new PartialArguments()
      view.append(String.raw`{"file_path":"a\n\u4e2d\"x`)
      expect(view.text('file_path')).toBe('a\n中"x')
      expect(view.stringLength('file_path')).toBe(5)
      view.append('y"}')
      expect(view.text('file_path')).toBe('a\n中"xy')
      expect(view.complete('file_path')).toBe(true)
    })

    it.each<[string, string, string]>([
      // Plain strings: a raw template cannot end in a backslash without escaping its closing backtick.
      ['{"file_path":"a\\', 'n"}', 'a\n'],
      ['{"file_path":"a\\u', '4e2d"}', 'a中'],
      [String.raw`{"file_path":"a\u4e`, '2d"}', 'a中'],
    ])('drops an escape still in flight from the first read of %j and completes it from %j', (head, tail, decoded) => {
      const view = new PartialArguments()
      view.append(head)
      expect(view.text('file_path')).toBe(decoded.slice(0, 1))
      expect(view.stringLength('file_path')).toBe(1)
      view.append(tail)
      expect(view.text('file_path')).toBe(decoded)
      expect(view.stringLength('file_path')).toBe(decoded.length)
      expect(view.complete('file_path')).toBe(true)
    })

    it('decodes a closed string in one step on first read', () => {
      const view = PartialArguments.fromText(String.raw`{"file_path":"a\n\u4e2d\ud83d\ude00"}`)
      expect(view.text('file_path')).toBe('a\n中😀')
      expect(view.text('file_path')).toBe('a\n中😀')
      expect(view.stringLength('file_path')).toBe(5)
    })

    it('returns the prefix before an invalid simple escape, whether the text is first read before, at, or after the failure', () => {
      const text = String.raw`{"file_path":"ab\q"}`
      const lazy = PartialArguments.fromText(text)
      expect(lazy.text('file_path')).toBe('ab')
      expect(lazy.stringLength('file_path')).toBe(2)
      expect(lazy.invalid).toBe(true)
      expect(lazy.complete('file_path')).toBe(false)

      const readBeforeKey = new PartialArguments()
      expect(readBeforeKey.text('file_path')).toBeUndefined()
      expect(appendAndRefresh(readBeforeKey, text)).toBe(true)
      expect(readBeforeKey.text('file_path')).toBe('ab')
      expect(readBeforeKey.stringLength('file_path')).toBe(2)

      const readMidString = new PartialArguments()
      readMidString.append('{"file_path":"a')
      expect(readMidString.text('file_path')).toBe('a')
      expect(appendAndRefresh(readMidString, String.raw`b\q"}`)).toBe(true)
      expect(readMidString.text('file_path')).toBe('ab')
      expect(readMidString.stringLength('file_path')).toBe(2)
      expect(readMidString.invalid).toBe(true)
    })

    it('returns the prefix before an invalid unicode escape, matching a read made before the failure', () => {
      const lazy = PartialArguments.fromText(String.raw`{"file_path":"ab\u12G4"}`)
      expect(lazy.invalid).toBe(false)
      expect(lazy.text('file_path')).toBe('ab')
      expect(lazy.invalid).toBe(true)
      expect(lazy.stringLength('file_path')).toBe(2)
      expect(lazy.complete('file_path')).toBe(false)

      const eager = new PartialArguments()
      expect(eager.text('file_path')).toBeUndefined()
      eager.append(String.raw`{"file_path":"ab\u12G4"}`)
      expect(eager.invalid).toBe(false)
      expect(eager.text('file_path')).toBe('ab')
      expect(eager.invalid).toBe(true)
      expect(eager.stringLength('file_path')).toBe(2)
    })
  })

  describe('keys and whitespace', () => {
    it('matches an escaped key against its decoded name', () => {
      const view = streamed([String.raw`{"file\u005fpath":"x","a\"b":"v"}`])
      expect(view.keys()).toEqual(['file_path', 'a"b'])
      expect(view.text('file_path')).toBe('x')
      expect(view.text('a"b')).toBe('v')
    })

    it('accepts JSON whitespace around every structural token', () => {
      const view = streamed([' \n{\t"file_path"\r:\n"x"\t,\r"content" : "y" ,\n"n" : 1 ,\t"o" : { "k" : [ 1 ] } \n}\r\n'])
      expect(view.keys()).toEqual(['file_path', 'content', 'n', 'o'])
      expect(view.text('file_path')).toBe('x')
      expect(view.text('content')).toBe('y')
      expect(view.value('n')).toBe(1)
      expect(view.value('o')).toStrictEqual({ k: [1] })
      expect(view.invalid).toBe(false)
    })

    it('accepts an empty object and trailing whitespace after the close, but nothing else after it', () => {
      for (const text of ['{}', '{ \n}', '{"a":1} \n\t\r', '']) {
        const view = PartialArguments.fromText(text)
        expect(view.invalid).toBe(false)
        expect(view.has('b')).toBe(false)
      }
      expect(PartialArguments.fromText('{} x').invalid).toBe(true)
      expect(PartialArguments.fromText('{"file_path":"x"}}').invalid).toBe(true)
      expect(PartialArguments.fromText('{"file_path":"x"}}').text('file_path')).toBe('x')
    })

    it('reports a streaming object closed when its outer closing brace arrives', () => {
      const view = new PartialArguments()
      expect(view.closed()).toBe(false)
      view.append('{"a":1,"b":"x')
      expect(view.closed()).toBe(false)
      view.append('"}')
      expect(view.closed()).toBe(true)
      view.append(' \n')
      expect(view.closed()).toBe(true)
      expect(view.invalid).toBe(false)
      expect(streamed(['{}']).closed()).toBe(true)

      const broken = new PartialArguments()
      broken.append('{"a":tru')
      expect(broken.closed()).toBe(false)
      broken.append('}')
      expect(broken.closed()).toBe(true)
      expect(broken.invalid).toBe(false)
      expect(broken.value('a')).toBeUndefined()
      expect(broken.invalid).toBe(true)
    })

    it('lets a repeated key replace the earlier entry without repeating the key', () => {
      const view = new PartialArguments()
      view.append('{"file_path":"a",')
      expect(view.text('file_path')).toBe('a')
      view.append('"file_path":"')
      expect(view.keys()).toEqual(['file_path'])
      expect(view.text('file_path')).toBe('')
      expect(view.complete('file_path')).toBe(false)
      view.append('bc",')
      expect(view.text('file_path')).toBe('bc')

      view.append('"file_path":[1],')
      expect(view.value('file_path')).toStrictEqual([1])
      expect(view.text('file_path')).toBeUndefined()
      expect(view.stringLength('file_path')).toBeUndefined()
      view.append('"file_path":"d"}')
      expect(view.text('file_path')).toBe('d')
      expect(view.value('file_path')).toBeUndefined()
      expect(view.keys()).toEqual(['file_path'])
      expect(view.invalid).toBe(false)
    })
  })

  describe('fragmentation', () => {
    const expectedByText = new Map([...CLOSED_TEXTS, ...INVALID_TEXTS].map(text => [text, snapshotOf(PartialArguments.fromText(text))]))

    it('answers the same whether scanned eagerly per character, per seeded 1-3 character slice, or lazily as a whole', () => {
      for (const [text, expected] of expectedByText) {
        const chunkings = [text.split('')]
        for (let seed = 1; seed <= 8; seed++) chunkings.push(slices(text, seededSizes(seed)))
        for (const chunks of chunkings) {
          const eager = new PartialArguments()
          snapshotOf(eager, expected.keys)
          for (const chunk of chunks) appendAndRefresh(eager, chunk)
          expect(snapshotOf(eager, expected.keys)).toStrictEqual(expected)
          expect(snapshotOf(streamed(chunks))).toStrictEqual(expected)
        }
      }
    })

    it('keeps text and length consistent when the first read lands at any character boundary', () => {
      for (const [text, expected] of expectedByText) {
        for (let cut = 0; cut <= text.length; cut++) {
          const view = new PartialArguments()
          view.append(text.slice(0, cut))
          const midway = snapshotOf(view, expected.keys)
          for (const [, field] of midway.fields) {
            if (field.text !== undefined) {
              expect(field.text.length).toBe(field.length)
              expect(field.prefix).toBe(field.text.slice(0, 4))
              expect(field.exceeds).toBe(field.text.length > 4)
            }
          }
          view.append(text.slice(cut))
          expect(snapshotOf(view, expected.keys)).toStrictEqual(expected)
        }
      }
    })
  })

  describe('change detection', () => {
    it('publishes a completion error discovered by a later content read during sealed refresh', () => {
      const view = streamed(['{"a":"ab"'])
      expect(view.complete('a')).toBe(true)
      expect(view.text('a')).toBe('ab')
      view.append(String.raw`,"a":"ab\q"}`)
      view.settle(String.raw`{"a":"ab","a":"ab\q"}`)
      expect(view.refresh()).toBe(true)
      expect(view.complete('a')).toBe(false)
      expect(view.text('a')).toBe('ab')
      expect(view.refresh()).toBe(false)
    })

    it('reports no change while nothing has been read, then answers fully on the first read', () => {
      const view = new PartialArguments()
      expect(appendAndRefresh(view, '{"file_path":"src/a.ts","n":1,')).toBe(false)
      expect(appendAndRefresh(view, '"todos":[1]}')).toBe(false)
      expect(view.keys()).toEqual(['file_path', 'n', 'todos'])
      expect(view.text('file_path')).toBe('src/a.ts')
      expect(view.value('todos')).toStrictEqual([1])
    })

    it('reports a length read only when its rounded-up step moves', () => {
      const view = new PartialArguments()
      view.append('{"content":"')
      expect(view.stringLength('content', { step: 1024 })).toBe(0)
      expect(appendAndRefresh(view, 'a')).toBe(true)
      expect(appendAndRefresh(view, 'a'.repeat(1022))).toBe(false)
      expect(appendAndRefresh(view, 'a')).toBe(false)
      expect(view.stringLength('content', { step: 1024 })).toBe(1024)
      expect(appendAndRefresh(view, 'a')).toBe(true)
      expect(appendAndRefresh(view, 'a'.repeat(1023))).toBe(false)
      expect(appendAndRefresh(view, 'a')).toBe(true)
      expect(view.stringLength('content', { step: 1024 })).toBe(2049)
      expect(appendAndRefresh(view, '"}')).toBe(false)
    })

    it('treats a missing, zero, or fractional step as its floor of at least one', () => {
      const perCharacter = new PartialArguments()
      perCharacter.append('{"c":"')
      perCharacter.stringLength('c')
      perCharacter.stringLength('c', {})
      perCharacter.stringLength('c', { step: 0 })
      for (const c of 'abc') expect(appendAndRefresh(perCharacter, c)).toBe(true)

      const byTwo = new PartialArguments()
      byTwo.append('{"c":"')
      byTwo.stringLength('c', { step: 2.9 })
      expect(appendAndRefresh(byTwo, 'a')).toBe(true)
      expect(appendAndRefresh(byTwo, 'b')).toBe(false)
      expect(appendAndRefresh(byTwo, 'c')).toBe(true)
      expect(appendAndRefresh(byTwo, 'd')).toBe(false)
    })

    it('reports a text read on every decoded character and nothing else', () => {
      const view = new PartialArguments()
      view.append('{"description":"')
      expect(view.text('description')).toBe('')
      for (const c of 'hello') expect(appendAndRefresh(view, c)).toBe(true)
      expect(appendAndRefresh(view, '\\')).toBe(false)
      expect(appendAndRefresh(view, 'n')).toBe(true)
      expect(appendAndRefresh(view, '"')).toBe(false)
      expect(appendAndRefresh(view, ',"n":1}')).toBe(false)
      expect(view.text('description')).toBe('hello\n')
    })

    it('stops reporting a bounded text prefix after its decoded limit', () => {
      const view = new PartialArguments()
      view.append('{"command":"')
      expect(view.textPrefix('command', 4)).toBe('')
      expect(appendAndRefresh(view, 'ab')).toBe(true)
      expect(appendAndRefresh(view, 'cd')).toBe(true)
      expect(view.textPrefix('command', 4)).toBe('abcd')
      expect(appendAndRefresh(view, 'ef')).toBe(false)
      expect(view.textPrefix('command', 4)).toBe('abcd')
      expect(view.stringExceeds('command', 4)).toBe(true)
      expect(view.text('command')).toBe('abcdef')
    })

    it('evaluates deferred fragments together at the publication point', () => {
      const view = new PartialArguments()
      view.append('{"content":"')
      expect(view.stringLength('content', { step: 4 })).toBe(0)
      view.append('ab')
      view.append('cd')
      expect(view.refresh()).toBe(true)
      expect(view.stringLength('content', { step: 4 })).toBe(4)
      expect(view.refresh()).toBe(false)
      view.append('ef')
      expect(view.refresh()).toBe(true)
      view.append('gh')
      expect(view.refresh()).toBe(false)
      expect(view.stringLength('content', { step: 4 })).toBe(8)
    })

    it('bounds decoded prefixes across JSON escapes and parsed objects', () => {
      expect(PartialArguments.fromText('{"command":"\\u4e2d tail"}').textPrefix('command', 1)).toBe('中')
      expect(PartialArguments.EMPTY.textPrefix('missing', 4)).toBeUndefined()
      expect(PartialArguments.fromText(String.raw`{"command":"a\n\u4e2d😀z"}`).textPrefix('command', 4)).toBe('a\n中\ud83d')
      expect(PartialArguments.fromObject({ command: 'abcdef' }).textPrefix('command', 3)).toBe('abc')
      expect(PartialArguments.fromObject({ command: 'abcdef' }).stringExceeds('command', 3)).toBe(true)
      expect(PartialArguments.fromObject({ command: 'abcdef' }).stringExceeds('command', 6)).toBe(false)
      expect(PartialArguments.fromObject({ command: 1 }).textPrefix('command', 3)).toBeUndefined()
      expect(PartialArguments.fromObject({ command: 1 }).stringExceeds('command', 3)).toBe(false)
    })

    it('tracks bounded reads through split Unicode escapes and repeated fields', () => {
      const view = new PartialArguments()
      const observe = () => ({ prefix: view.textPrefix('command', 1), exceeds: view.stringExceeds('command', 1) })
      expect(observe()).toEqual({ prefix: undefined, exceeds: false })
      for (const [fragment, prefix, exceeds, changed] of [
        [String.raw`{"command":"\ud83`, '', false, true],
        ['d', '\ud83d', false, true],
        [String.raw`\ude`, '\ud83d', false, false],
        ['00', '\ud83d', true, true],
        ['x"', '\ud83d', true, false],
        [',"command":"', '', false, true],
        [String.raw`\u4e`, '', false, false],
        ['2d', '中', false, true],
        ['x"', '中', true, true],
        [',"command":0}', undefined, false, true],
      ] as const) {
        view.append(fragment)
        expect(observe()).toEqual({ prefix, exceeds })
        expect(view.refresh()).toBe(changed)
        expect(view.refresh()).toBe(false)
      }
    })

    it('reports a has read when the field begins: at a string quote or the first character of another value', () => {
      const view = new PartialArguments()
      expect(view.has('x')).toBe(false)
      expect(view.has('y')).toBe(false)
      expect(appendAndRefresh(view, '{"a":1,"x"')).toBe(false)
      expect(appendAndRefresh(view, ':')).toBe(false)
      expect(appendAndRefresh(view, '"')).toBe(true)
      expect(appendAndRefresh(view, 'v","y":')).toBe(false)
      expect(appendAndRefresh(view, '1')).toBe(true)
      expect(appendAndRefresh(view, '}')).toBe(false)
    })

    it('reports a complete read when the string closes or the value lands', () => {
      const view = new PartialArguments()
      view.append('{"file_path":"a')
      expect(view.complete('file_path')).toBe(false)
      expect(view.complete('todos')).toBe(false)
      expect(appendAndRefresh(view, 'b')).toBe(false)
      expect(appendAndRefresh(view, '"')).toBe(true)
      expect(appendAndRefresh(view, ',"todos":[1,')).toBe(false)
      expect(appendAndRefresh(view, '2]')).toBe(true)
      expect(appendAndRefresh(view, '}')).toBe(false)
    })

    it('reports a value read only when the value lands, not while its nested text streams', () => {
      const view = new PartialArguments()
      view.append('{"todos":')
      expect(view.value('todos')).toBeUndefined()
      expect(appendAndRefresh(view, '[{"content":"x"')).toBe(false)
      expect(appendAndRefresh(view, '}')).toBe(false)
      expect(appendAndRefresh(view, ']')).toBe(true)
      expect(view.value('todos')).toStrictEqual([{ content: 'x' }])
      expect(appendAndRefresh(view, '}')).toBe(false)
    })

    it('reports empty keys and new keys, not repeated keys', () => {
      const view = new PartialArguments()
      expect(view.keys()).toEqual([])
      expect(appendAndRefresh(view, '{"":"x"')).toBe(true)
      expect(appendAndRefresh(view, ',"":"y"')).toBe(false)
      expect(appendAndRefresh(view, ',"b"')).toBe(false)
      expect(appendAndRefresh(view, ':1')).toBe(true)
      expect(view.keys()).toEqual(['', 'b'])
    })

    it('reports a closed read when the outer object closes or indexing fails', () => {
      const view = new PartialArguments()
      expect(view.closed()).toBe(false)
      expect(appendAndRefresh(view, '{"a":1,"b":"x"')).toBe(false)
      expect(appendAndRefresh(view, '}')).toBe(true)
      expect(appendAndRefresh(view, ' ')).toBe(false)

      const broken = new PartialArguments()
      expect(broken.closed()).toBe(false)
      expect(appendAndRefresh(broken, '{"a":')).toBe(false)
      expect(appendAndRefresh(broken, ']')).toBe(true)
      expect(broken.closed()).toBe(true)
      expect(broken.invalid).toBe(true)
      expect(appendAndRefresh(broken, '}')).toBe(false)
    })

    it('keeps an observed text change pending until refresh', () => {
      const view = new PartialArguments()
      view.append('{"a":"')
      expect(view.text('a')).toBe('')
      view.append('xy')
      expect(view.text('a')).toBe('xy')
      expect(view.refresh()).toBe(true)
      expect(view.refresh()).toBe(false)
      view.append('z')
      expect(view.text('a')).toBe('xyz')
      expect(view.refresh()).toBe(true)
      expect(view.refresh()).toBe(false)
    })

    it('keeps changes pending while several readers inspect the same field', () => {
      const view = new PartialArguments()
      view.append('{"command":"ab')
      const observe = () => ({
        text: view.text('command'),
        prefix: view.textPrefix('command', 3),
        exceeds: view.stringExceeds('command', 3),
      })
      expect(observe()).toEqual({ text: 'ab', prefix: 'ab', exceeds: false })
      view.append('cd')
      expect(observe()).toEqual({ text: 'abcd', prefix: 'abc', exceeds: true })
      expect(view.stringLength('command', { step: 4 })).toBe(4)
      expect(view.refresh()).toBe(true)
      expect(view.refresh()).toBe(false)
      view.append('e')
      expect(observe()).toEqual({ text: 'abcde', prefix: 'abc', exceeds: true })
      expect(view.stringLength('command', { step: 4 })).toBe(5)
      expect(view.refresh()).toBe(true)
      expect(view.refresh()).toBe(false)
    })

    it('keeps length observations independent by step and offset until refresh', () => {
      const view = new PartialArguments()
      view.append('{"content":"a')
      const observe = () => [
        view.stringLength('content', { step: 4 }),
        view.stringLength('content', { step: 4, offset: 2 }),
        view.stringLength('content', { step: 8 }),
      ]
      expect(observe()).toEqual([1, 1, 1])
      for (const [fragment, length, changed] of [
        ['b', 2, false],
        ['c', 3, true],
        ['d', 4, false],
        ['e', 5, true],
        ['fgh', 8, true],
        ['i', 9, true],
      ] as const) {
        view.append(fragment)
        expect(observe()).toEqual([length, length, length])
        expect(view.refresh()).toBe(changed)
        expect(view.refresh()).toBe(false)
      }
    })

    it('ignores text after structural failure and retains an invalid string prefix', () => {
      const view = new PartialArguments()
      expect(view.has('file_path')).toBe(false)
      expect(appendAndRefresh(view, '{"n":1,"b":}')).toBe(false)
      expect(view.invalid).toBe(true)
      expect(view.value('n')).toBe(1)
      expect(appendAndRefresh(view, ',"file_path":"x"}')).toBe(false)
      expect(view.has('file_path')).toBe(false)
      expect(view.invalid).toBe(true)

      const midString = new PartialArguments()
      midString.append('{"file_path":"ab')
      expect(midString.text('file_path')).toBe('ab')
      expect(appendAndRefresh(midString, String.raw`\q"}`)).toBe(false)
      expect(midString.invalid).toBe(true)
      expect(midString.text('file_path')).toBe('ab')
      expect(midString.stringLength('file_path')).toBe(2)
      expect(midString.complete('file_path')).toBe(false)
    })

    it('tracks a write call streamed in 3-character slices exactly as an independent oracle predicts', () => {
      const content = [
        'import { a } from "./a.ts"',
        '',
        'export const x = `${a}\\n`\t// "quoted" and C:\\path',
        'bell \u0007 中文 😀',
        '',
      ].join('\n')
      const text = JSON.stringify({ file_path: 'src/a.ts', content, overwrite: true })
      // JSON.stringify writes the control character as a \uXXXX escape, so the stream exercises one.
      expect(text).toContain('\\u0007')

      const view = new PartialArguments()
      const observe = () => {
        const length = view.stringLength('content', { step: 64 })
        return {
          path: view.text('file_path'),
          pathDone: view.complete('file_path'),
          length,
          steps: length === undefined ? undefined : Math.ceil(length / 64),
          overwrite: view.value('overwrite'),
        }
      }
      let before = observe()
      expect(before).toStrictEqual({ path: undefined, pathDone: false, length: undefined, steps: undefined, overwrite: undefined })

      const chunks = slices(text, () => 3)
      let reported = 0
      let previousLength = 0
      for (const chunk of chunks) {
        view.append(chunk)
        const changed = view.refresh()
        const after = observe()
        const expectChanged = after.path !== before.path || after.pathDone !== before.pathDone
          || after.steps !== before.steps || after.overwrite !== before.overwrite
        expect(changed).toBe(expectChanged)
        if (changed) reported++
        if (after.length !== undefined) {
          expect(after.pathDone).toBe(true)
          expect(after.length).toBeGreaterThanOrEqual(previousLength)
          previousLength = after.length
        }
        before = after
      }
      expect(reported).toBeGreaterThan(0)
      expect(reported).toBeLessThan(chunks.length / 2)
      expect(before).toStrictEqual({ path: 'src/a.ts', pathDone: true, length: content.length, steps: Math.ceil(content.length / 64), overwrite: true })
      expect(view.complete('content')).toBe(true)
      expect(view.keys()).toEqual(['file_path', 'content', 'overwrite'])
      expect(view.invalid).toBe(false)
    })
  })

  describe('invalid text', () => {
    it.each<[string, string]>([
      ['x', 'a first character other than {'],
      ['{1', 'a key that is not a string'],
      ['{"a":1,}', 'a trailing comma before the closing brace'],
      ['{"a":1, 2', 'a key that is not a string after a comma'],
      [String.raw`{"a\q":1}`, 'a key with an invalid escape'],
      ['{"a" 1', 'a missing colon'],
      ['{"a":}', 'a value starting with }'],
      ['{"a":,', 'a value starting with ,'],
      ['{"a"::', 'a value starting with :'],
      ['{"a":]', 'a value starting with ]'],
      ['{"a":"b" x', 'text other than , or } after a value'],
      ['{"file_path":"x"}}', 'a second closing brace'],
      ['{"a":[}', 'mismatched nested brackets'],
      ['{"a":{"b":[]]', 'mismatched nested object brackets'],
      [String.raw`{"a\u12G4":1}`, 'a non-hex digit in a key escape'],
      ['{"a\nb":1}', 'an unescaped control character in a key'],
    ])('freezes as invalid on %j (%s) and ignores later text', (text) => {
      expect(PartialArguments.fromText(text).invalid).toBe(true)

      const view = new PartialArguments()
      expect(view.has('later')).toBe(false)
      view.append(text)
      expect(view.invalid).toBe(true)
      expect(view.closed()).toBe(true)
      expect(appendAndRefresh(view, ',"later":"x"}')).toBe(false)
      expect(view.has('later')).toBe(false)
    })

    it.each<[string, string, string | undefined]>([
      [String.raw`{"file_path":"ab\q","later":"x"}`, 'file_path', 'ab'],
      [String.raw`{"file_path":"ab\u12G4","later":"x"}`, 'file_path', 'ab'],
      ['{"file_path":"ab\nc","later":"x"}', 'file_path', 'ab'],
      ['{"a":tru,"later":"x"}', 'a', undefined],
      ['{"a":1.,"later":"x"}', 'a', undefined],
      ['{"a":1. ,"later":"x"}', 'a', undefined],
      ['{"a":[tru],"later":"x"}', 'a', undefined],
      [String.raw`{"a":{"b":"\q"},"later":"x"}`, 'a', undefined],
    ])('indexes later keys before validating the malformed value in %j', (text, key, prefix) => {
      const view = PartialArguments.fromText(text)
      expect(view.keys()).toEqual([key, 'later'])
      expect(view.has(key)).toBe(true)
      expect(view.complete(key)).toBe(true)
      expect(view.has('later')).toBe(true)
      expect(view.invalid).toBe(false)
      expect(view.text('later')).toBe('x')
      expect(view.invalid).toBe(false)
      if (prefix === undefined) {
        expect(view.value(key)).toBeUndefined()
      } else {
        expect(view.text(key)).toBe(prefix)
        expect(view.stringLength(key)).toBe(prefix.length)
      }
      expect(view.invalid).toBe(true)
      expect(view.complete(key)).toBe(false)
      expect(view.text('later')).toBe('x')
    })

    it.each<[string, string | undefined]>([
      [String.raw`{"bad":"ab\q",`, 'ab'],
      ['{"bad":[tru],', undefined],
    ])('keeps the outer object open after reading invalid contents in %j', (head, prefix) => {
      const view = streamed([head])
      expect(view.closed()).toBe(false)
      expect(view.has('later')).toBe(false)
      expect(view.invalid).toBe(false)
      if (prefix === undefined) expect(view.value('bad')).toBeUndefined()
      else expect(view.text('bad')).toBe(prefix)
      expect(view.invalid).toBe(true)
      expect(view.closed()).toBe(false)
      expect(view.refresh()).toBe(false)

      view.append('"later":"ok"')
      expect(view.refresh()).toBe(true)
      expect(view.keys()).toEqual(['bad', 'later'])
      expect(view.text('later')).toBe('ok')
      expect(view.invalid).toBe(true)
      expect(view.closed()).toBe(false)
      view.append('}')
      expect(view.refresh()).toBe(true)
      expect(view.closed()).toBe(true)
      expect(view.refresh()).toBe(false)
    })

    it('rejects an incomplete Unicode escape when its closed string is first read', () => {
      const view = PartialArguments.fromText(String.raw`{"a":"\u12"}`)
      expect(view.complete('a')).toBe(true)
      expect(view.invalid).toBe(false)
      expect(view.text('a')).toBe('')
      expect(view.invalid).toBe(true)
      expect(view.complete('a')).toBe(false)
    })

    it('indexes past a nested unescaped newline and reports it when the container is read', () => {
      const view = PartialArguments.fromText('{"a":{"b":"x\ny"},"later":1}')
      expect(view.keys()).toEqual(['a', 'later'])
      expect(view.complete('a')).toBe(true)
      expect(view.invalid).toBe(false)
      expect(view.value('a')).toBeUndefined()
      expect(view.invalid).toBe(true)
      expect(view.complete('a')).toBe(false)
      expect(view.value('later')).toBe(1)
    })

    it('discovers malformed escapes from a length-only read', () => {
      const view = PartialArguments.fromText(String.raw`{"content":"ab\q","later":1}`)
      expect(view.complete('content')).toBe(true)
      expect(view.invalid).toBe(false)
      expect(view.stringLength('content')).toBe(2)
      expect(view.invalid).toBe(true)
      expect(view.complete('content')).toBe(false)
      expect(view.value('later')).toBe(1)
    })

    it('caches a malformed container result without parsing unrelated containers', () => {
      const view = PartialArguments.fromText('{"bad":[tru],"good":[1]}')
      const parse = vi.spyOn(JSON, 'parse')
      try {
        expect(view.keys()).toEqual(['bad', 'good'])
        expect(view.has('bad')).toBe(true)
        expect(view.complete('bad')).toBe(true)
        expect(view.complete('good')).toBe(true)
        expect(view.invalid).toBe(false)
        expect(parse).not.toHaveBeenCalled()
        expect(view.value('bad')).toBeUndefined()
        expect(parse).toHaveBeenCalledExactlyOnceWith('[tru]')
        expect(view.value('bad')).toBeUndefined()
        expect(view.complete('bad')).toBe(false)
        expect(view.invalid).toBe(true)
        expect(parse).toHaveBeenCalledTimes(1)
        const good = view.value('good')
        expect(good).toEqual([1])
        expect(view.value('good')).toBe(good)
        expect(parse).toHaveBeenCalledTimes(2)
      } finally {
        parse.mockRestore()
      }
    })

    it('stops at the first invalid character of a fragment and ignores the rest of it', () => {
      const view = PartialArguments.fromText('{"a" 1,"file_path":"x"}')
      expect(view.invalid).toBe(true)
      expect(view.keys()).toEqual([])
      expect(view.has('file_path')).toBe(false)
    })
  })
})
