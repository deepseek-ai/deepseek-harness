/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** macOS operation levels, permissions, selectors, and native measurement units. */
export const PLATFORM_GUIDANCE = 'macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. getApp also accepts bundle IDs and .app paths, and findApps searches /Applications, /System/Applications, and ~/Applications. Accessibility and Screen Recording permissions belong to the responsible launching application; use the Computer Use permission page to request access, open System Settings, and check again. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. show does not switch Spaces, and Stage Manager can present reduced window geometry; explain any required foreground step before activate or raise.'

/** Complete model instructions for this provider. */
export const GUIDANCE = `${PLATFORM_GUIDANCE}

${COMMON_GUIDANCE}`
