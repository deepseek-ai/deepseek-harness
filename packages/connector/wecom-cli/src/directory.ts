import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export const PROGRAM = 'wecom-cli'

function platformDirectory(): string {
  const platformPackage = `@wecom/cli-${process.platform}-${process.arch}`
  try {
    const require = createRequire(import.meta.resolve('@wecom/cli/package.json'))
    return join(dirname(require.resolve(`${platformPackage}/package.json`)), 'bin')
  } catch (error) {
    throw new Error(`wecom: ${platformPackage} is not installed; @wecom/cli has no binary for this platform, or set binDir`, { cause: error })
  }
}

export function resolveCliDirectory(binDir: string | undefined): string {
  const directory = binDir ?? platformDirectory()
  const program = join(directory, PROGRAM)
  try {
    accessSync(program, constants.X_OK)
  } catch (error) {
    throw new Error(`wecom: ${program} is not executable; reinstall the plugin or set binDir`, { cause: error })
  }
  return directory
}
