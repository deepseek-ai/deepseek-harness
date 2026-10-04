/** External PowerShell must execute skill resources carried inside the Desktop archive. */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { WriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions } = builderRequire('@electron/asar') as {
  createPackageWithOptions: (source: string, destination: string, options: object) => Promise<WriteStream>
}
const packageDirectory = fileURLToPath(new URL('../../../packages/sandbox/sandbox-windows-acl/', import.meta.url))

it.skipIf(process.platform !== 'win32' || process.env.DSH_EXAMPLE_MODE !== 'lib')('executes the archived ACL skill through external PowerShell and disposes its copy', { retry: 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acl-asar-'))
  try {
    const source = join(root, 'package')
    // Electron reads the archived package here; full installer layout and SEA execution have separate coverage needs.
    await mkdir(source)
    for (const path of ['lib', 'assets', 'package.json']) await cp(join(packageDirectory, path), join(source, path), { recursive: true })
    const archive = join(root, 'app.asar')
    await finished(await createPackageWithOptions(source, archive, {}))
    const entry = join(root, 'probe.mjs')
    await writeFile(entry, `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageDirectory, archive, root] = process.argv.slice(2);
const require = createRequire(join(packageDirectory, 'package.json'));
// Only the package under test is archived; resolve its real dependencies from the built workspace.
const archiveUrl = pathToFileURL(archive).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(archiveUrl) && !specifier.startsWith('.') && !specifier.startsWith('node:')) {
    return next(pathToFileURL(require.resolve(specifier)).href, context);
  }
  return next(specifier, context);
} });
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { default: SkillRegistry } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-skill')));
const { registerAclDiagnosisSkill, ACL_DIAGNOSIS_SKILL } = await import(pathToFileURL(join(archive, 'lib/index.js')));
const ctx = new Context();
try {
  await ctx.plugin(SkillRegistry);
  const fiber = await ctx.plugin({ name: 'acl-skill-archive-probe', inject: ['skills'], apply: registerAclDiagnosisSkill });
  const skill = await ctx.skills.get(ACL_DIAGNOSIS_SKILL);
  assert.equal(skill.resourceBase.kind, 'directory');
  const directory = skill.resourceBase.path;
  assert.ok(!directory.includes('.asar'));
  const output = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
    join(directory, 'scripts/diagnose-windows-sandbox-acl.ps1'), '-Path', root, '-AllowRoot', root, '-Out', join(root, 'out')],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ok(output.includes('READABLE=True'));
  await fiber.dispose();
  assert.ok(!existsSync(directory));
  assert.deepEqual(await ctx.skills.list(), []);
  process.stdout.write('ACL_SKILL_ASAR_OK');
} finally { await ctx.fiber.dispose(); }
`)
    const electron = require('electron') as string
    const result = spawnSync(electron, [entry, packageDirectory, archive, root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TEMP: root, TMP: root }, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('ACL_SKILL_ASAR_OK')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
