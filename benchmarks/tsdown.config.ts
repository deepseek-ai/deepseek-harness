import { defineConfig } from 'tsdown'

const shared = {
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//],
    onlyBundle: false as const,
  },
}

/** Compile measured benchmark workers while keeping workspace packages on their built `lib` entries. */
export default defineConfig([
  {
    ...shared,
    entry: { 'reconnect.worker': 'active-stream-reconnect/reconnect.worker.client.ts' },
    outDir: '.dsh-build/active-stream-reconnect',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
  {
    ...shared,
    entry: {
      'agent-continuation.worker': 'agent-continuation/agent-continuation.worker.ts',
      'child-catalog.worker': 'agent-continuation/child-catalog.worker.ts',
      'profile-continuation.worker': 'agent-continuation/profile-continuation.worker.ts',
      'profile-adapter': 'agent-continuation/profile-adapter.ts',
    },
    outDir: '.dsh-build/agent-continuation',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: { 'session-open.worker': 'session-open/session-open.worker.ts' },
    outDir: '.dsh-build/session-open',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: {
      'conversation-fold.worker': 'conversation-fold/conversation-fold.worker.client.ts',
    },
    outDir: '.dsh-build/conversation-fold',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
])
