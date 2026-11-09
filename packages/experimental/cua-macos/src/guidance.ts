/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** macOS operation levels, permissions, selectors, and native measurement units. */
export const PLATFORM_GUIDANCE = 'macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. For pointer input on a sheet, select its window ID with app.getWindow(id). For menu items outside a window, use app.invoke(id). findApps searches /Applications, /System/Applications, and ~/Applications. Use the Computer Use permission page to grant the helper application Accessibility and Screen Recording permissions in System Settings. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. show does not switch Spaces, and Stage Manager can present reduced window geometry; explain any required foreground step before calling app.activate() or performing an advertised AXRaise action.'

const methodDetails = new Map<string, string>([
  ['getAccessibilityTree', 'macOS accepts maxElements up to 100000 and maxDepth up to 512. If the tree is truncated, select a narrower window or raise the reported limit on the next read. In persistent PTC, capture a large tree with const tree = await win.getAccessibilityTree({ emit: false }). Filter its lines in memory, or save it with await tools.write({ file_path: path, content: tree }) to a new workspace file. Search its contents with tools.grep({ path, pattern }) and use tools.read around a matching line. Print only the matches you need. Use element ids from the file only while that observation is current.'],
  ['mouseMove', 'Default hover requires both AXShowAlternateUI and AXShowDefaultUI on an enabled element or ancestor. Without that route, HOVER_UNAVAILABLE is returned before sending input. Physical movement requires an unobscured foreground target. Explain any necessary activation and observe the target again.'],
  ['click', 'click is a Window method: select a window with const win = await app.getWindow(windowId), then call win.click(target). For a background control’s default action, use app.invoke(id). For a mouse click on a background app, call app.activate() first and re-read the target. Both target forms send mouse-down and mouse-up events. click(id) uses the center of the full element bounds. If that center is outside the window, take a fresh win.getScreenshot() and use click([x, y]) on a visible part of the control in screenshot pixels. A background app can ignore the events even when dispatched is true. Verify the expected effect, such as a changed selection, before typing or retrying.'],
])

/** Native operation instructions; the shared Host adds guidance for declared capabilities. */
export const GUIDANCE = `${PLATFORM_GUIDANCE}

${COMMON_GUIDANCE.replace(/^- ([\w.]+)\(.*$/gm, (entry, method: string) => {
  if (method === 'pressKey') return `${entry}
- sendKeyEvent(key: string, direction: 'down' | 'up') -> ActionResult — send 'down' to hold a key across tool calls in one run_code, for example W down, D down, D up, W up. Holding a key on a physical keyboard can produce repeated key-down events after a delay. To send one such repeat for a non-modifier key this run already holds, send 'down' again. Each call posts one event. A control can filter repeats. Use the app's response to decide whether and when to repeat or release the key. When this run_code returns, throws, or the user pauses it, macOS releases only its remaining keys at their original recipients.`
  const detail = methodDetails.get(method)
  return detail ? `${entry} ${detail}` : entry
})}`
