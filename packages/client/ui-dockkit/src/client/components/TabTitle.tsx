/** Title content shared by strip chips and floating-panel headers. */
import type { ReactNode } from 'react'
import css from './dockkit.module.css'

/** The chip stylesheet fades the trailing edge without measuring the title. */
export function TabTitle({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className={css.tabTitle} data-dockkit-tab-title>{children}</span>
}
