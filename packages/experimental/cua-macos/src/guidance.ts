/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** macOS operation levels, permissions, selectors, and native measurement units. */
export const PLATFORM_GUIDANCE = 'macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. For pointer input on a sheet, select its window ID with app.getWindow(id). For menu items outside a window, use app.invoke(id). findApps searches /Applications, /System/Applications, and ~/Applications. Use the Computer Use permission page to grant the helper application Accessibility and Screen Recording permissions in System Settings. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. show does not switch Spaces, and Stage Manager can present reduced window geometry; explain any required foreground step before calling app.activate() or performing an advertised AXRaise action.'

const methodDetails = new Map<string, string>([
  ['getAccessibilityTree', 'If the tree reports maxElements or maxDepth truncation, select a narrower window or ask the user to raise the named macOS provider setting and read again. In persistent PTC, capture a large tree with const tree = await win.getAccessibilityTree({ emit: false }). Filter its lines in memory, or save it with await tools.write({ file_path: path, content: tree }) to a new workspace file. Search its contents with tools.grep({ path, pattern }) and use tools.read around a matching line. Print only the matches you need. Use element ids from the file only while that observation is current.'],
  ['mouseMove', 'Default hover requires both AXShowAlternateUI and AXShowDefaultUI on an enabled element or ancestor. Without an AX route it returns HOVER_UNAVAILABLE before sending input. Prefer click on a visible control or performAction with an advertised action. For web content without an AX hover action, use browser tools. Only systemPointerHover: true permits moving the visible cursor. If this returns FOREGROUND_REQUIRED, activate the app and check that the point is unobscured.'],
  ['click', 'click is a Window method: select a window with const win = await app.getWindow(windowId), then call win.click(target). For a background control’s default action, use app.invoke(id). For a mouse click on a background app, call app.activate() first and re-read the target. Both target forms send mouse-down and mouse-up events. click(id) uses the center of the full element bounds. If that center is outside the window, take a fresh win.getScreenshot() and use click([x, y]) on a visible part of the control in screenshot pixels. A background app can ignore the events even when dispatched is true. Verify the expected effect, such as a changed selection, before typing or retrying.'],
])

/** Complete model instructions for this provider. */
export const GUIDANCE = `${PLATFORM_GUIDANCE}

${COMMON_GUIDANCE.replace(/^- ([\w.]+)\(.*$/gm, (entry, method: string) => {
  const detail = methodDetails.get(method)
  return detail ? `${entry} ${detail}` : entry
})}`
