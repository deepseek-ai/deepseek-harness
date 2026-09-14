/** Own Chromium before CDP or Stagehand initialization can wait or fail. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser, ChromeReleaseChannel, CDP_WEBSOCKET_ENDPOINT_REGEX, computeSystemExecutablePath, launch } from '@puppeteer/browsers'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { NativeBrowserConfig } from './native.ts'

/** Chromium process and profile owned independently of the Stagehand Worker. */
export interface OwnedChromium {
  /** CDP endpoint reported by this exact process. */
  endpoint: string
  /** Kill the owned process tree, await child close, and remove its profile. */
  close(): Promise<void>
}

/**
 * Launch Chromium with scrubbed environment and OS-allocated debugging port.
 * @param config - executable, window visibility, and startup deadline.
 * @param signal - cancellation before the caller receives browser ownership.
 * @returns the owned browser after its debugging endpoint is ready.
 */
export async function launchChromium(config: NativeBrowserConfig, signal: AbortSignal): Promise<OwnedChromium> {
  signal.throwIfAborted()
  const executablePath = config.executablePath
    ?? computeSystemExecutablePath({ browser: Browser.CHROME, channel: ChromeReleaseChannel.STABLE })
  const profile = await mkdtemp(join(tmpdir(), 'dsh-stagehand-chrome-'))
  let browser: ReturnType<typeof launch> | undefined
  let closed: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    browser?.kill()
    await closed
    await rm(profile, { recursive: true, force: true })
  })()
  const abort = () => { void close().catch(() => {}) }
  try {
    signal.throwIfAborted()
    browser = launch({
      executablePath,
      args: [
        '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--remote-allow-origins=*',
        '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
        ...config.headless ? ['--headless=new'] : [],
        'about:blank',
      ],
      env: scrubbedParentEnv(), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    })
    // Failed spawn emits error + close without exit; Process.hasClosed waits only for exit.
    const child = browser.nodeProcess
    closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
    signal.addEventListener('abort', abort, { once: true })
    const endpoint = await browser.waitForLineOutput(CDP_WEBSOCKET_ENDPOINT_REGEX, config.operationTimeoutMs)
    signal.throwIfAborted()
    return { endpoint, close }
  } catch (error) {
    await close()
    signal.throwIfAborted()
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
