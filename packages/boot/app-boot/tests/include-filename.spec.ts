/** Include `path` resolution shared by the schema collector and compatibility preflight. */
import { describe, expect, it } from 'vitest'
import { includeFilename } from '../src/include-filename.ts'

describe('includeFilename', () => {
  it('reads a drive-letter path as a Windows file path on Windows', () => {
    expect(includeFilename('C:/config/extra.yml', 'file:///D:/app/', 'win32')).toBe('C:\\config\\extra.yml')
    expect(includeFilename('c:\\config\\extra.yml', 'file:///D:/app/', 'win32')).toBe('c:\\config\\extra.yml')
  })

  it('resolves other paths against the tree base URL', () => {
    expect(includeFilename('./extra.yml', 'file:///app/cordis.yml', 'linux')).toBe('/app/extra.yml')
    expect(includeFilename('file:///etc/extra.yml', 'file:///app/', 'linux')).toBe('/etc/extra.yml')
    // Off Windows, Include reads `C:` as a URL scheme too.
    expect(() => includeFilename('C:/config/extra.yml', 'file:///app/', 'linux')).toThrow()
    expect(includeFilename('./extra.yml', 'file:///D:/app/cordis.yml', 'win32')).toBe('D:\\app\\extra.yml')
  })
})
