// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { unviewableBinaryPath } from '../src/client/document/unviewable.ts'

describe('unviewableBinaryPath', () => {
  it('matches one sample from every listed category', () => {
    for (const path of [
      'clip.mp4', 'song.mp3', 'bundle.zip', 'report.docx', 'tool.exe',
      'face.woff2', 'image.dmg', 'design.psd',
    ]) expect(unviewableBinaryPath(path), path).toBe(true)
  })

  it('matches regardless of case, directories, and path separators', () => {
    expect(unviewableBinaryPath('MOVIE.MP4')).toBe(true)
    expect(unviewableBinaryPath('work/deep/archive.tar.gz')).toBe(true)
    expect(unviewableBinaryPath('work\\deep\\notes.docx')).toBe(true)
  })

  it('leaves renderer-claimed, text, and unknown suffixes to their existing paths', () => {
    for (const path of [
      'main.ts', 'README.md', 'photo.png', 'page.html', 'paper.pdf', 'logo.svg',
      'server.log', 'config.env', 'notes.unknown', 'Makefile', 'mp4', 'private.key',
    ]) expect(unviewableBinaryPath(path), path).toBe(false)
  })
})
