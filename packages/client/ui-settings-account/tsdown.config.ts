import { clientBundle } from '../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-settings-account', ['lib/types/index.js'])

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'account-onboarding-assets',
    resolveId(source: string) {
      if (!/^\.\/assets\/[^/]+\.(?:svg|png)(\?raw)?$/.test(source)) return null
      const url = new URL(`./src/client/assets/${basename(source)}`, import.meta.url)
      return fileURLToPath(url) + url.search
    },
    async load(id: string) {
      if (!/\/ui-settings-account\/src\/client\/assets\/[^/]+\.(?:svg|png)(\?raw)?$/.test(id.replaceAll('\\', '/'))) return null
      const path = id.replace(/\?raw$/, '')
      this.addWatchFile(path)
      const data = await readFile(path)
      if (id.endsWith('?raw')) return `export default ${JSON.stringify(data.toString('utf8'))}`
      return `export default ${JSON.stringify(`data:${path.endsWith('.png') ? 'image/png' : 'image/svg+xml'};base64,${data.toString('base64')}`)}`
    },
  }],
}))) satisfies typeof bundle
