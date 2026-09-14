import { it } from 'vitest'
import { verifyMcpBrowser } from '../../browser-use-runtime/tests/mcp-upstream.ts'
import * as Provider from '../src/index.ts'

it.skipIf(process.env.DSH_BROWSER_EXECUTABLE === undefined).each(['launch', 'attach'] as const)(
  'uses the pinned Chrome DevTools MCP server to %s Chromium and visit a loopback page',
  async mode => verifyMcpBrowser(Provider, 'chrome-devtools-mcp', { name: 'new_page', arguments: url => ({ url }) }, mode),
)
