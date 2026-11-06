/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** macOS operation levels, permissions, selectors, and native measurement units. */
export const PLATFORM_GUIDANCE = 'macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. For pointer input on a sheet, select its window ID with app.getWindow(id). For menu items outside a window, use app.invoke(id). Use the Computer Use permission page to grant the helper application Accessibility and Screen Recording permissions in System Settings. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. Stage Manager can present reduced window geometry; explain any required foreground step before calling app.activate() or performing an advertised AXRaise action.'

const methodDetails = new Map<string, string>([
  ['cua.getApp', 'Accepts a name, bundle ID, .app path, or running PID string. A stopped app launches in the background.'],
  ['cua.findApps', 'Searches /Applications, /System/Applications, and ~/Applications.'],
  ['app.show', 'Unhides the app and restores its focused, main, or sole window without activating it.'],
  ['window.show', 'Unhides the app and restores this window without activating it.'],
  ['mouseMove', 'Default hover requires both AXShowAlternateUI and AXShowDefaultUI on an enabled element or ancestor. Without an AX route it returns HOVER_UNAVAILABLE before sending input. Prefer click on a visible control or performAction with an advertised action. For web content without an AX hover action, use browser tools. Only systemPointerHover: true permits moving the visible cursor. If this returns FOREGROUND_REQUIRED, activate the app and check that the point is unobscured.'],
  ['click', 'Both target forms send mouse-down and mouse-up events: an ID targets the element center and coordinates target the given point. Prefer invoke(id) for a background control’s default action. For a mouse click, call app.activate() first and observe the target again. A background app can ignore a dispatched click.'],
  ['typeText', 'Line endings send Return and tabs send Tab.'],
  ['paste', 'Uses the app’s Paste command and restores the clipboard unless another writer changes it. For PASTE_NOT_CONSUMED, inspect the target before retrying.'],
])

/** Complete model instructions for this provider. */
export const GUIDANCE = `${PLATFORM_GUIDANCE}

${COMMON_GUIDANCE.replace(/^- ([\w.]+)\(.*$/gm, (entry, method: string) => {
  const detail = methodDetails.get(method)
  return detail ? `${entry} ${detail}` : entry
})}`
