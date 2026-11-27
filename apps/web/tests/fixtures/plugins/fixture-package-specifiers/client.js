/**
 * Hand-written stand-in for a Client plugin compiled outside this repository, never built by the repository's preset:
 * it requires three Client packages by package root and by `/client` subpath and publishes what it received for the
 * browser test to read.
 */
window.__ModuleLoader__.load({
  id: '@fixture/package-specifiers',
  factory(require) {
    const packages = [
      ['@deepseek-ai/dsh-client-ui-slots', 'resolveSlotLabel'],
      ['@deepseek-ai/dsh-client-ui-primitives', 'Button'],
      ['@deepseek-ai/dsh-client-ui-dockkit', 'DockController'],
    ]
    const results = packages.map(([name, exported]) => {
      const root = require(name)
      const client = require(name + '/client')
      return {
        name,
        sameExports: root === client,
        exported,
        rootExportType: typeof root[exported],
        clientExportType: typeof client[exported],
      }
    })
    return {
      apply(ctx) {
        ctx.effect(() => {
          window.__fixturePackageSpecifiers = results
          return () => { delete window.__fixturePackageSpecifiers }
        })
      },
    }
  },
})
