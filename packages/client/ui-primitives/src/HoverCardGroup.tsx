import { createContext, useState, type ReactNode } from 'react'

interface GroupState {
  isWarm: () => boolean
  enter: (overCard: boolean) => void
  leave: () => void
  containsCard: (target: EventTarget | null) => boolean
  shown: (owner: symbol, dismiss: () => void, element: HTMLElement) => void
  release: (owner: symbol) => void
}

/** Private coordination shared only by opted-in HoverCards inside one mounted group. */
export const HoverCardGroupContext = createContext<GroupState | null>(null)

/**
 * Share first-display dwell across a list and its active portal, including the card's existing pointer grace.
 * @param props.children - list contents, including opted-in HoverCards.
 * @param props.className - classes for the physical list container.
 * @returns the list container and its private hover coordinator.
 */
export function HoverCardGroup({ children, className }: { children: ReactNode; className?: string }) {
  const [group] = useState<GroupState>(() => {
    let pointer: 'outside' | 'list' | 'card' = 'outside'
    let warm = false
    let active: { owner: symbol; dismiss: () => void; element: HTMLElement } | null = null
    return {
      isWarm: () => warm,
      enter: (overCard) => {
        pointer = overCard ? 'card' : 'list'
        if (overCard) warm = true
      },
      leave: () => {
        pointer = 'outside'
        // A displayed card owns the grace across the gap; its release ends an outside visit.
        if (active === null) warm = false
      },
      containsCard: target => target instanceof Node && active !== null && active.element.contains(target),
      shown: (owner, dismiss, element) => {
        // Keyboard focus can replace the portal under the pointer without a pointer-out event.
        if (pointer === 'card') { pointer = 'outside'; warm = false }
        if (pointer === 'list') warm = true
        const previous = active
        active = { owner, dismiss, element }
        if (previous !== null && previous.owner !== owner) previous.dismiss()
      },
      release: (owner) => {
        if (active?.owner !== owner) return
        active = null
        if (pointer !== 'list') { pointer = 'outside'; warm = false }
      },
    }
  })
  return (
    <HoverCardGroupContext.Provider value={group}>
      <div
        className={className}
        onPointerOverCapture={(event) => {
          const overCard = group.containsCard(event.target)
          if (event.currentTarget.contains(event.target as Node) || overCard) group.enter(overCard)
        }}
        onPointerOutCapture={(event) => {
          const fromGroup = event.currentTarget.contains(event.target as Node) || group.containsCard(event.target)
          const intoGroup = (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
            || group.containsCard(event.relatedTarget)
          if (fromGroup && !intoGroup) group.leave()
        }}
      >
        {children}
      </div>
    </HoverCardGroupContext.Provider>
  )
}
