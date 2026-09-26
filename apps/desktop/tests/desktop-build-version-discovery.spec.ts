import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopBuildDateSegment,
  suggestDesktopBuildVersion,
} from '../scripts/desktop-build-version-discovery.ts'

const PRERELEASE = '0.1.6-alpha.2'
const STABLE = '0.1.6'
const DATE = '20260921'
const directories: string[] = []

async function artifactsWith(names: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-'))
  directories.push(directory)
  for (const name of names) await writeFile(join(directory, name), '')
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('desktop build version discovery', () => {
  it('formats the date segment in the build host time zone', () => {
    expect(desktopBuildDateSegment(new Date(2026, 8, 21))).toBe('20260921')
    expect(desktopBuildDateSegment(new Date(2026, 0, 5))).toBe('20260105')
  })

  it('starts at one when nothing is taken', async () => {
    const artifactsRoot = await artifactsWith([])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.1`)
  })

  it('numbers a stable product version under the documented test prerelease', async () => {
    const artifactsRoot = await artifactsWith([`deepseek-harness-${STABLE}-test.${DATE}.4-win-x64.exe`])
    await expect(suggestDesktopBuildVersion({ productVersion: STABLE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${STABLE}-test.${DATE}.5`)
  })

  it('numbers after the highest local artifact for the same date', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.${DATE}.1-win-x64.exe`,
      `deepseek-harness-${PRERELEASE}.${DATE}.2-win-x64.exe`,
      `deepseek-harness-${PRERELEASE}.${DATE}.10-win-x64.exe`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.11`)
  })

  it('ignores artifacts from another date or product version', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.20260920.7-win-x64.exe`,
      `deepseek-harness-0.1.5-alpha.1.${DATE}.9-win-x64.exe`,
      `deepseek-harness-${PRERELEASE}-win-x64.exe`,
      'unrelated.exe',
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.1`)
  })

  it('reads macOS artifact names too', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.${DATE}.3-mac-arm64.dmg`,
      `deepseek-harness-${PRERELEASE}.${DATE}.3-mac-arm64.zip`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'mac-arm64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.4`)
  })

  it('counts unsigned Windows artifacts written under their own suffix', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.${DATE}.2-win-x64-unsigned.exe`,
      `deepseek-harness-${PRERELEASE}.${DATE}.5-win-x64-unsigned.exe.blockmap`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.3`)
  })
})
