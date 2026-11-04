/** Direct component fixture for the tree's framework seats; integration specs use the real renderer. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { FactoryComponentPropsOf, FactoryLocalComponent } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTree } from '../src/client/FileTree.tsx'
import type { FileTreeInput, TreeEntry } from '../src/client/FileTree.tsx'
import { en } from '../src/client/locales.ts'

export type Accessory = FactoryLocalComponent<'sidebar.files.tree', 'accessory'>

function unused(): never {
  throw new Error('Unexpected tree framework seat')
}

const seats = {
  t: makeTranslate(en),
  renderFactorySlot: unused,
  useSessions: unused,
  useSessionStatus: unused,
  useSessionRetainInfo: unused,
  useSessionAccess: unused,
  useWorkspaces: unused,
  useWorkspaceAccess: unused,
  useRemoteAccess: unused,
  usePanelInfo: unused,
  useResource: unused,
  useContextMenu: unused,
}

/** Supply selected local Components through the same local-props-only binding as the renderer. */
export function TreeFixture(
  { accessory, t = seats.t, ...input }: FileTreeInput & { accessory?: Accessory | undefined; t?: typeof seats.t },
): ReactNode {
  const useFactorySlot = ((_name: 'accessory', fallback: Accessory) => {
    const Selected = accessory ?? fallback
    return useMemo(() => function Bound({ entry }: { entry: TreeEntry }) {
      return <Selected {...seats} t={t} entry={entry} />
    }, [Selected, t])
  }) as FactoryComponentPropsOf<'sidebar.files.tree'>['useFactorySlot']
  return <FileTree {...seats} t={t} {...input} useFactorySlot={useFactorySlot} />
}
