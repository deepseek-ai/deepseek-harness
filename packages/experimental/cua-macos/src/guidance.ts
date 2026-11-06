/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** macOS operation levels, permissions, selectors, and native measurement units. */
export const PLATFORM_GUIDANCE = 'macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. Use window coordinates for click and mouseMove on macOS. The helper rejects element-targeted pointer requests carrying the window ID supplied by these object methods. For an element’s default action, use invoke with its latest ID. getApp also accepts bundle IDs and .app paths, and findApps searches /Applications, /System/Applications, and ~/Applications. Use the Computer Use permission page to grant the helper application Accessibility and Screen Recording permissions in System Settings. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. show does not switch Spaces, and Stage Manager can present reduced window geometry; explain any required foreground step before calling app.activate() or performing an advertised AXRaise action.'

/** Complete model instructions for this provider. */
export const GUIDANCE = `${PLATFORM_GUIDANCE}

${COMMON_GUIDANCE}`
