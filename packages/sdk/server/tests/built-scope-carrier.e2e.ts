/**
 * Built-artifact guard for the scope carrier shared by `dsh-subagent` and
 * `dsh-sdk-jsonrpc-server`. The carrier registry is module-local, so both bundles must
 * externalize `dsh-scope`; source-mode tests cannot expose an accidentally
 * inlined second registry. This test runs the real `lib/index.js` bundles in a
 * plain Node subprocess, disposes the child before settlement, and requires the
 * SDK completion notification to retain the delegating parent.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const jsonrpcBundle = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const execFileAsync = promisify(execFile)

const builtRuntimeProbe = String.raw`
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const load = (path) => import(pathToFileURL(resolve(path)).href);
const [
  { Context },
  { default: AgentLoop },
  { mountAgentLoopTestDependencies },
  { default: SubagentRuntime },
  { default: JsonlSessionPersistence },
  { HarnessSdkJsonRpcServer },
  { SessionId },
] = await Promise.all([
  load("vendor/cordis/lib/index.js"),
  load("packages/core/agent-loop/lib/index.js"),
  load("packages/test-support/agent-loop-testkit/lib/index.js"),
  load("packages/subagent/subagent/lib/index.js"),
  load("packages/session/session-persistence-jsonl/lib/index.js"),
  load("packages/sdk/server/lib/index.js"),
  load("packages/core/session/lib/index.js"),
]);

const storageRoot = await mkdtemp(join(tmpdir(), "jsonrpc-built-scope-"));
const ctx = new Context();
try {
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(SubagentRuntime);
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot });
  await new Promise((ready) => setTimeout(ready, 50));

  const notifications = [];
  const server = new HarnessSdkJsonRpcServer(ctx, {
    request() { return Promise.reject(new Error("unexpected host request")); },
    notify(method, params) { notifications.push({ method, params }); },
  });
  const parent = await ctx.agents.create({
    sessionId: SessionId("built-parent"),
    meta: { cwd: storageRoot },
    agentOptions: { model: "test" },
  });
  const child = await parent.agent.ctx.agents.create({
    sessionId: SessionId("built-child"),
    meta: { cwd: storageRoot, parentSession: SessionId("built-parent") },
    agentOptions: { model: "test" },
  });
  const result = Promise.withResolvers();
  const unregister = ctx.subagents.registerProvider({
    name: "built-local",
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start() {
      return Promise.resolve({
        id: child.agent.id,
        localAgent: child.agent,
        result: result.promise,
        dispose() { return Promise.resolve(); },
      });
    },
  });
  const run = await ctx.subagents.start("built-local", {
    parent: parent.agent,
    prompt: [],
    signal: new AbortController().signal,
  });
  await child.dispose();
  result.resolve({ output: [], stopReason: "completed" });
  await run.result;
  await Promise.resolve();

  console.log(JSON.stringify(notifications.filter(({ method }) => method === "subagent.finished")));
  await run.dispose();
  unregister();
  await parent.dispose();
  await server.shutdown();
} finally {
  await ctx.fiber.dispose();
  await rm(storageRoot, { recursive: true, force: true });
}
`

describe.skipIf(!existsSync(jsonrpcBundle))('dsh-sdk-jsonrpc-server BUILT scope carrier', () => {
  it('preserves parent-scoped completion after child disposal', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', builtRuntimeProbe], {
      cwd: repoRoot,
      timeout: 15_000,
    })

    expect(stderr).not.toContain('listener threw')
    // A result without output omits lastAssistantMessage from the wire; it
    // never sends `[]`.
    expect(JSON.parse(stdout) as unknown).toEqual([{
      method: 'subagent.finished',
      params: {
        provider: 'built-local',
        agentId: 'built-child',
        parentSessionId: 'built-parent',
        childSessionId: 'built-child',
        status: 'ok',
        stopReason: 'completed',
      },
    }])
  })
})
