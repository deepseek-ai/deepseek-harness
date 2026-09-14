/** External Chromium process fixture; the DSH launcher still owns profile cleanup. */

import { EventEmitter } from 'node:events'
import { FixtureBrowser, fixture } from './stagehand.ts'

export const Browser = { CHROME: 'chrome' }
export const ChromeReleaseChannel = { STABLE: 'stable' }
export const CDP_WEBSOCKET_ENDPOINT_REGEX = /^DevTools listening on (ws:\/\/.*)$/
export const computeSystemExecutablePath = () => '/fixture/chromium'

export function launch(options: { executablePath: string; args: string[] }) {
  const browser = new FixtureBrowser('launched', {
    executablePath: options.executablePath, headless: options.args.includes('--headless=new'),
  })
  fixture.browsers.push(browser)
  const endpoint = `http://fixture/${fixture.browsers.length}`
  fixture.connections.set(endpoint, browser)
  const nodeProcess = new EventEmitter()
  return {
    nodeProcess,
    waitForLineOutput: () => Promise.resolve(endpoint),
    kill() { void browser.close().then(() => { nodeProcess.emit('close', 0) }) },
  }
}
