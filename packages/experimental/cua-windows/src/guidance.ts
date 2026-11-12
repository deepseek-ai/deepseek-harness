/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** Windows operation levels, application selectors, and input availability. */
export const PLATFORM_GUIDANCE = 'Windows: accessibility tree operations are available only at window level. Simulated mouse and keyboard input are available at window level. Supported modifiers: ctrl, alt, shift, win. control is an alias for ctrl.'

const methodDetails = new Map<string, string>([
  ['cua.getApp', 'Windows accepts an exact AUMID returned by listApps or an existing absolute .exe path, including an executable absent from listApps. Display names and PIDs are not alternative selectors. Selection uses the existing application consent flow and starts the application only when it is not running.'],
  ['cua.findApps', 'Not implemented on Windows. Use listApps to discover applications, or pass a known absolute .exe path to getApp.'],
  ['getAccessibilityTree', 'Set the node count or depth for one read. Windows accepts maxElements from 1 to 10000 and maxDepth from 1 to 100. Omitted limits use the provider settings; maxDepth=1 includes only the window root. If the tree is truncated, select a narrower window or increase the relevant limit. includeMenus expands menu contents. Element IDs are UI Automation RuntimeIds formatted as slash-separated integer strings, such as "12/345/6". Pass the complete string unchanged as elementId. Each element lists all its supported patterns, not action names. Disabled is an observed state, not a prohibition on attempting an operation.'],
  ['listActions', 'Actions use case-sensitive Pattern.Action names, such as "Invoke.Invoke", "Toggle.Toggle", and "ExpandCollapse.Expand". Each pattern has a known set of native UI Automation operations. One pattern can expose multiple actions. Use a known operation of an advertised pattern directly; call listActions when you need to confirm the exposed operations. Query methods are not exposed through performAction.'],
  ['invoke', 'The provider chooses default action for well-known patterns. A failed operation is not retried through another pattern or simulated input.'],
  ['performAction', 'Use the exact Pattern.Action name. Omit argument or pass null for a parameter-free operation. Pass a single parameter as its direct JSON value; pass multiple parameters as an object using their native names. Enum values use their exact names as strings. Examples: await win.performAction(id, "Value.SetValue", "hello"); await win.performAction(id, "Window.SetWindowVisualState", "Normal"); await win.performAction(id, "Transform.Resize", { width: 800, height: 600 }).'],
])

/** Native operation instructions; the shared Host adds guidance for declared capabilities. */
export const GUIDANCE = `${PLATFORM_GUIDANCE}

${COMMON_GUIDANCE.replace(/^- ([\w.]+)\(.*$/gm, (entry, method: string) => {
  const detail = methodDetails.get(method)
  if (!detail) return entry
  if (method === 'getAccessibilityTree') return `${entry.replace(/ — .*$/, '')} — ${detail}`
  return `${entry} ${detail}`
})}`
