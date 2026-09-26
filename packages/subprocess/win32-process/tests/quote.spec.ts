import { describe, expect, it } from 'vitest'
import { buildCommandLine, quoteArg } from '../src/process.ts'

const isWin32 = process.platform === 'win32'

const cases: Array<[string, string]> = [
  ['', '""'],
  ['a', 'a'],
  ['a b', '"a b"'],
  ['a"b', '"a\\"b"'],
  ['a\\b', 'a\\b'],
  ['a b\\', '"a b\\\\"'],
  ['a b\\\\', '"a b\\\\\\\\"'],
  ['a\\\\"b', '"a\\\\\\\\\\"b"'],
]

describe('quoteArg', () => {
  it.each(cases)('quotes %j as %j', (input, expected) => {
    expect(quoteArg(input)).toBe(expected)
  })

  it('builds one CreateProcess command line without shell interpretation', () => {
    expect(buildCommandLine('C:\\Program Files\\tool.exe', ['a b', 'c'])).toBe(
      '"C:\\Program Files\\tool.exe" "a b" c',
    )
  })
})

describe.skipIf(!isWin32)('CommandLineToArgvW round-trip', () => {
  it('parses the shared command line back to the original argv', async () => {
    const { default: koffi } = await import('koffi')
    const PVOID = koffi.pointer('void')
    const shell32 = koffi.load('shell32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    const commandLineToArgvW = shell32.func(
      '__stdcall',
      'CommandLineToArgvW',
      PVOID,
      ['str16', koffi.pointer('int')],
    )
    const lstrcpynW = kernel32.func('__stdcall', 'lstrcpynW', PVOID, [PVOID, PVOID, 'int'])
    const lstrlenW = kernel32.func('__stdcall', 'lstrlenW', 'int', [PVOID])
    const localFree = kernel32.func('__stdcall', 'LocalFree', PVOID, [PVOID])
    const parse = (commandLine: string): string[] => {
      const countSlot: unknown = koffi.alloc('int', 1)
      const argvBlock: unknown = commandLineToArgvW(commandLine, countSlot)
      try {
        if (argvBlock === null) throw new Error('CommandLineToArgvW returned NULL')
        const count = koffi.decode(countSlot, 0, 'int') as number
        const table = Buffer.from(koffi.view(argvBlock, count * 8))
        return Array.from({ length: count }, (_, index) => {
          const stringAddress = table.readBigUInt64LE(index * 8)
          const copied = Buffer.alloc(2048)
          lstrcpynW(copied, stringAddress, copied.length / 2)
          const length = lstrlenW(copied) as number
          return copied.subarray(0, length * 2).toString('utf16le')
        })
      } finally {
        localFree(argvBlock)
      }
    }
    const argv = ['', 'a', 'a b', 'a"b', 'a\\b', 'a b\\', 'a b\\\\', 'a\\\\"b']
    expect(parse(buildCommandLine('prog.exe', argv))).toEqual(['prog.exe', ...argv])
  })
})
