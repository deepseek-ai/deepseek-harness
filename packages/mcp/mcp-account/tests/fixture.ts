/** A connector's copy and an MCP manager stand-in shared by the account specs. */
import type { ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import type { McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import { vi } from 'vitest'
import type { McpAccountCopy } from '../src/types.ts'

export const ATTEMPT = 'attempt-1' as McpOAuthAttemptId
export const OPERATION = 'attempt-1' as ConnectorOperationId

export const COPY: McpAccountCopy = {
  title: 'Acme account', connect: 'Connect Acme',
  activation: { title: 'Connect Acme?', body: 'The connector is on.' },
  detail: {
    disconnected: 'Connect to use Acme.', waitingBrowser: 'Confirm in the Acme page.', authorizing: 'Saving the Acme grant.',
    connecting: 'Connecting to Acme.', connected: 'Ask the agent to use Acme.', rejected: 'Acme rejected the grant.', scope: 'Acme needs a permission.',
  },
  signOut: { title: 'Sign out of Acme?', body: 'The saved grant is removed.' },
  notice: { connected: 'Acme connected', signedOut: 'Signed out of Acme' },
}

/** A manager stand-in that lists servers and records the page's operations. */
export function fakeManager(servers: McpManagedServerView[] = []) {
  const fake = {
    servers,
    list: () => fake.servers,
    startAuthorization: vi.fn(async (_name: string): Promise<McpOAuthAttemptView> => ({ id: ATTEMPT, phase: 'starting' })),
    cancelAuthorization: vi.fn(async (_name: string, _id: McpOAuthAttemptId) => {}),
    signOut: vi.fn(async (_name: string) => {}),
    restart: vi.fn(async (_name: string) => {}),
  }
  return fake
}
