/** Test-owned sidebar role for `sidebar.workspaces`: the slot-level inject and an inert scroller binding. */
import type { SidebarSectionHookContext, SidebarSectionInjected } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Slot-level inject a test-owned sidebar declares on `sidebar.workspaces`, matching the shipped shell. */
export const SECTION_INJECT: SidebarSectionInjected = {
  hooks: { sectionScroller: (_standard, { useSectionScroller }) => useSectionScroller },
}

const INERT_SCROLLER = { bindScrollerRef: () => {} }

/** hookContext a test-owned sidebar passes when rendering `sidebar.workspaces`; binding the scroller has no effect. */
export const SECTION_HOOK_CONTEXT: SidebarSectionHookContext = { useSectionScroller: () => INERT_SCROLLER }
