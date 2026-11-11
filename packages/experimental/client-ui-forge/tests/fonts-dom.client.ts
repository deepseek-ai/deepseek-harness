/** jsdom font-loading events for specs that mount the changes toolbar, which measures again when fonts load. */
import { afterEach, beforeEach } from 'vitest'

const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')
beforeEach(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
})
afterEach(() => {
  if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', fonts)
})
