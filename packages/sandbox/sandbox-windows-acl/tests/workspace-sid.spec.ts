/** Stable, distinct write identities for canonical directories and private temp paths. */

import { describe, expect, it } from 'vitest'

import { directoryWriteSid, tempWriteSid } from '../src/index.ts'

describe('directoryWriteSid', () => {
  it('derives a stable capability-shaped SID per directory path', () => {
    const first = directoryWriteSid('C:\\Users\\agent\\repo')
    const second = directoryWriteSid('C:\\Users\\agent\\repo')
    expect(first).toBe(second)
    expect(first).toMatch(/^S-1-4-\d+-\d+$/u)
  })

  it('derives distinct identities for distinct directories', () => {
    expect(directoryWriteSid('C:\\Users\\agent\\repo-a')).not.toBe(directoryWriteSid('C:\\Users\\agent\\repo-b'))
  })

  it('is byte-sensitive: the canonical path is the caller\'s contract (an alias spelling derives a second identity)', () => {
    expect(directoryWriteSid('C:\\Repo')).not.toBe(directoryWriteSid('c:\\repo'))
    expect(directoryWriteSid('C:\\Repo\\')).not.toBe(directoryWriteSid('C:\\Repo'))
  })
})

describe('tempWriteSid', () => {
  it('derives a stable domain-separated SID per private temp path', () => {
    const temp = tempWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123')
    expect(temp).toBe(tempWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123'))
    expect(temp).toMatch(/^S-1-4-\d+-\d+-1$/u)
    expect(temp).not.toBe(directoryWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123'))
  })

  it('derives distinct capabilities for distinct private temp paths', () => {
    expect(tempWriteSid('C:\\Temp\\dsh-a')).not.toBe(tempWriteSid('C:\\Temp\\dsh-b'))
  })
})
