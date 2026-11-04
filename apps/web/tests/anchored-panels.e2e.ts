/** Production styles keep oversized floating panels aligned with their triggers. */
import { readFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'

const PANELS = [
  { file: 'client/ui-primitives/src/Menu.module.css', classes: 'list portal scrollable', align: 'start' },
  { file: 'client/ui-primitives/src/Menu.module.css', classes: 'list portal scrollable', align: 'end' },
  { file: 'client/ui-schedule/src/client/TaskMenu.module.css', classes: 'list portal scrollable', align: 'start' },
  { file: 'client/ui-schedule/src/client/TaskMenu.module.css', classes: 'list portal scrollable alignEnd', align: 'end' },
  { file: 'client/ui-schedule/src/client/PickerPopover.module.css', classes: 'panel', align: 'start' },
  { file: 'client/ui-schedule/src/client/ScheduleCatalogAction.module.css', classes: 'menu', align: 'start' },
  { file: 'client/ui-subagent/src/client/SubagentHeaderLineage.module.css', classes: 'menu', align: 'start' },
  { file: 'client/ui-approval/src/client/ApprovalPanel.module.css', classes: 'warningPopover', align: 'end' },
  { file: 'client/ui-jobs/src/client/JobListAction.module.css', classes: 'menu', align: 'start' },
  { file: 'client/ui-conversation/src/client/skeleton/ContextMeter.module.css', classes: 'panel', align: 'start' },
  { file: 'client/ui-chat/src/client/chat/stat-dialog.module.css', classes: 'panel', align: 'start' },
  { file: 'client/ui-sidebar-documentpreview/src/client/office/FontNotice.module.css', classes: 'panel', align: 'start' },
  { file: 'client/ui-plugin-manager/src/client/PluginManagerPage.module.css', classes: 'registry', align: 'end' },
  { file: 'experimental/session-inspector/src/client/views/inspector.module.css', classes: 'typeFilterPanel', align: 'start' },
] as const

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
  'retains horizontal anchors when tall panels exhaust both sides ($name)', async ({ engine }) => {
    const browser = await engine.launch()
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 600 } })
    for (const panel of PANELS) {
      const css = await readFile(new URL(`../../../packages/${panel.file}`, import.meta.url), 'utf8')
      // Only content volume is synthetic; placement and viewport limits come from each owner.
      await page.setContent(`<style>${css}
      #panel { display: flex; flex-direction: column; }
      #scroller { overflow: auto; min-height: 0; }
      #content { height: 2000px; width: 180px; flex: none; }
      #trigger { position: absolute; left: 700px; top: 286px; width: 100px; height: 28px; anchor-name: --probe; }
      </style><button id="trigger">Trigger</button>
      <div id="panel" class="${panel.classes}" data-anchor-align="${panel.align}" style="position-anchor: --probe">
        <div id="scroller"><div id="content">Long list</div></div>
      </div>`)
      const card = page.locator('#panel')
      const horizontalError = () => card.evaluate((node, align) => {
        const bounds = node.getBoundingClientRect()
        const trigger = document.querySelector('#trigger')!.getBoundingClientRect()
        return Math.abs(align === 'end' ? bounds.right - trigger.right : bounds.left - trigger.left)
      }, panel.align)
      await expect.poll(horizontalError, { message: `${engine.name()}: ${panel.file} (${panel.align})` }).toBeLessThan(1)
      const bounds = await card.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.y).toBeGreaterThanOrEqual(12)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(588)
      expect(await page.locator('#scroller').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)

      // Each opening mounts a new portal, without a previous native fallback choice.
      await page.locator('#content').evaluate((node) => { node.style.height = '60px' })
      await card.evaluate((node) => { node.replaceWith(node.cloneNode(true)) })
      await expect.poll(() => card.evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(120)
      await expect.poll(horizontalError).toBeLessThan(1)
      const short = await card.boundingBox()
      expect(short!.y + short!.height <= 286 || short!.y >= 314).toBe(true)

      const opensAbove = /(?:ApprovalPanel|ContextMeter|stat-dialog)/.test(panel.file)
      await page.locator('#trigger').evaluate((node, top) => { node.style.top = `${top}px` }, opensAbove ? 24 : 548)
      await card.evaluate((node) => { node.replaceWith(node.cloneNode(true)) })
      await expect.poll(() => card.evaluate((node, above) => {
        const rect = node.getBoundingClientRect()
        return above ? rect.top >= 52 : rect.bottom <= 548
      }, opensAbove), { message: `${engine.name()}: flipped ${panel.file}` }).toBe(true)

      await page.setViewportSize({ width: 390, height: 600 })
      await page.locator('#trigger').evaluate((node) => { node.style.left = '145px'; node.style.top = '286px' })
      await page.locator('#content').evaluate((node) => { node.style.height = '2000px' })
      await expect.poll(() => card.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return rect.left >= 12 && rect.right <= 378 && rect.top >= 12 && rect.bottom <= 588
      }), { message: `${engine.name()}: constrained ${panel.file}` }).toBe(true)
      await page.setViewportSize({ width: 1400, height: 600 })
    }
  })
