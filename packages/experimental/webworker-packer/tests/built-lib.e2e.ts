/** Installed packer/runtime interoperability without either package's source tree. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { pnpmInvocation } from '../../../../scripts/pnpm-invocation.ts'

const experimentalDirectory = fileURLToPath(new URL('../..', import.meta.url))
const packages = ['webworker-runtime', 'webworker-packer']
const packageNames = new Set(packages.map(name => `@deepseek-ai/dsh-experimental-${name}`))

it('loads both tarballs through plain Node and mounts their base image and overlay', { retry: 0 }, async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-webworker-packed-'))
  const links: string[] = []
  let pending: Promise<string> = Promise.resolve('')
  test.onTestFinished(async () => {
    try {
      await pending
    } finally {
      for (const path of links.reverse()) await unlink(path)
      await rm(root, { recursive: true, force: true })
    }
  })
  const run = (command: string, args: string[], cwd: string): Promise<string> => {
    pending = execa(command, args, {
      cwd,
      env: { NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: undefined },
      stdin: 'ignore',
      timeout: test.task.timeout,
      cancelSignal: test.signal,
      killSignal: 'SIGKILL',
      reject: false,
    }).then((result) => {
      expect(result.timedOut, `stderr:\n${result.stderr}`).toBe(false)
      expect(result.isCanceled, `stderr:\n${result.stderr}`).toBe(false)
      expect(result.signal, `stderr:\n${result.stderr}`).toBeUndefined()
      expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
      return result.stdout
    })
    return pending
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  for (const name of packages) {
    const source = join(experimentalDirectory, name)
    const directory = join(root, 'node_modules/@deepseek-ai', `dsh-experimental-${name}`)
    const packRoot = join(root, name)
    await mkdir(packRoot, { recursive: true })
    await mkdir(directory, { recursive: true })
    const invocation = pnpmInvocation(['pack', '--pack-destination', packRoot])
    await run(invocation.command, invocation.args, source)
    const archives = (await readdir(packRoot)).filter(file => file.endsWith('.tgz'))
    expect(archives).toHaveLength(1)
    await run('tar', ['-xzf', join(packRoot, archives[0]!), '-C', directory, '--strip-components=1'], root)
    expect(existsSync(join(directory, 'src'))).toBe(false)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    // Only the two subjects resolve from tarballs; their declared external dependencies use the built checkout.
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (packageNames.has(dependency)) continue
      const target = join(root, 'node_modules', dependency)
      if (existsSync(target)) continue
      await mkdir(dirname(target), { recursive: true })
      await symlink(await realpath(join(source, 'node_modules', dependency)), target, process.platform === 'win32' ? 'junction' : 'dir')
      links.push(target)
    }
  }
  const script = `
    import assert from 'node:assert/strict'
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
    import { fileURLToPath } from 'node:url'
    import * as packer from '@deepseek-ai/dsh-experimental-webworker-packer'
    import * as runtime from '@deepseek-ai/dsh-experimental-webworker-runtime'
    import * as client from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
    for (const name of ['webworker-packer', 'webworker-runtime']) {
      assert.equal(import.meta.resolve('@deepseek-ai/dsh-experimental-' + name),
        new URL('./node_modules/@deepseek-ai/dsh-experimental-' + name + '/lib/index.js', import.meta.url).href)
    }
    assert.equal(typeof client.connectWorkerHost, 'function')
    const worker = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-experimental-webworker-runtime/worker'))
    assert.ok(existsSync(worker))
    assert.equal(readFileSync(worker, 'utf8').match(/^import[ \\t]/m), null)
    const base = packer.packVfsImage({ config: '[]\\n', profile: 'packed-consumer', workspaces: new Map(), resolveFrom: process.cwd(), entries: [] })
    assert.deepEqual(base.missing, [])
    const vfs = runtime.loadVfsImage(await runtime.inflateImage(base.image, 'packed base'))
    assert.ok(vfs.existsSync('/dsh/' + packer.MANIFEST_PATH))
    mkdirSync('overlay')
    writeFileSync('overlay/hello.txt', 'packed worker pair\\n')
    const overlay = packer.packVfsOverlay([{ mount: 'workspace', directory: fileURLToPath(new URL('./overlay', import.meta.url)) }])
    runtime.loadVfsOverlay(await runtime.inflateImage(overlay.image, 'packed overlay'), '/dsh', vfs)
    assert.equal(vfs.readFileSync('/dsh/workspace/hello.txt', 'utf8'), 'packed worker pair\\n')
    console.log('packed image and overlay mounted')
  `
  await writeFile(join(root, 'consumer.mjs'), script)
  expect((await run(process.execPath, ['consumer.mjs'], root)).trim()).toBe('packed image and overlay mounted')
})
