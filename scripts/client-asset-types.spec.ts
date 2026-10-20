/**
 * The type roots declare one wildcard image module per supported package
 * asset extension, each with a string default export.
 */
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ASSET_MEDIA_TYPES } from '../packages/client/modules/src/assets.ts'

const DECLARATIONS = join(import.meta.dirname, 'types/client-assets/index.d.ts')

describe('client asset type declarations', () => {
  it('declare a string default export for exactly the supported extensions', () => {
    const program = ts.createProgram({
      rootNames: [DECLARATIONS],
      options: { noEmit: true, noLib: true, types: [] },
    })
    const checker = program.getTypeChecker()
    const declarations = program.getSourceFile(DECLARATIONS)
    if (declarations === undefined) throw new Error(`${DECLARATIONS} is not in the program`)
    const modules = checker.getAmbientModules()
      .filter(module => module.declarations?.some(declaration => declaration.getSourceFile() === declarations))

    expect(modules.map(module => JSON.parse(module.getName()) as string).sort())
      .toEqual([...PACKAGE_ASSET_MEDIA_TYPES.keys()].map(extension => `*${extension}`).sort())
    for (const module of modules) {
      const defaultExport = checker.getExportsOfModule(module).find(symbol => symbol.getName() === 'default')
      if (defaultExport === undefined) throw new Error(`${module.getName()} declares no default export`)
      expect(checker.typeToString(checker.getTypeOfSymbol(defaultExport)), module.getName()).toBe('string')
    }
  })
})
