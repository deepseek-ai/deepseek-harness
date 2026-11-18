import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gatewayWorkerCommand } from '../src/host/share-host.ts'

const packageDir = fileURLToPath(new URL('..', import.meta.url))

describe('Liveshare gateway worker command', () => {
  it('loads the source worker through tsx when the host runs from src/host', () => {
    // The module's own location, so the sibling worker path is expressed in this platform's
    // separators: a POSIX literal turns into a drive-less URL path that Windows refuses to convert.
    const command = gatewayWorkerCommand(pathToFileURL(join(packageDir, 'src/host/share-host.ts')).href)

    expect(command.executable).toBe(process.execPath)
    expect(command.args).toEqual(['--import', 'tsx/esm', join(packageDir, 'src/owner-gateway/cli.ts')])
  })

  it('loads the shipped worker beside the bundled lib entry', () => {
    const command = gatewayWorkerCommand(pathToFileURL(join(packageDir, 'lib/index.js')).href)

    expect(command.executable).toBe(process.execPath)
    expect(command.args).toEqual([join(packageDir, 'lib/owner-gateway/cli.js')])
  })
})
