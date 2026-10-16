import { describe, expect, it, vi } from 'vitest'
import { LinuxScopeSelector } from '../src/linux-scope-selector.ts'
import type { LinuxScopeDecision } from '../src/linux-scope-selector.ts'

/** Host state the selector observes; scenarios change it between launches. */
interface World {
  /** What a deep probe returns now: literal-argv options, or undefined when no scope can start. */
  probe: readonly string[] | undefined
  /** Socket inode of the process listening on the user manager's private socket, or undefined. */
  listener: string | undefined
  /** Whether confirming the user manager succeeds now. */
  confirm: boolean
  /** Identity of the resolved systemd-run binary, or undefined when none resolves. */
  launcher: string | undefined
}

type Step =
  /** One eligible launch selects containment. */
  | 'launch'
  /** The host changes before the next launch. */
  | { readonly set: Partial<World> }
  /** The host changes while the next probe runs, after the selector read its listener and launcher. */
  | { readonly duringProbe: Partial<World> }
  /** A scope launched under this generation exited before its bootstrap started the target. */
  | { readonly notStarted: number }

interface Scenario {
  readonly name: string
  readonly world: World
  readonly steps: readonly Step[]
  /** Summary of each launch's decision, in order. */
  readonly decisions: readonly string[]
  readonly probes: number
}

const OPTION = '--expand-environment=no'
const healthy: World = { probe: [OPTION], listener: 'manager-1', confirm: true, launcher: 'systemd-run-255' }
const absent: World = { probe: undefined, listener: undefined, confirm: false, launcher: 'systemd-run-245' }

function summary(decision: LinuxScopeDecision): string {
  const probe = decision.probe === undefined ? '' : ` after ${decision.probe}`
  return decision.kind === 'scope'
    ? `scope[${decision.literalArgv.join(' ')}]#${String(decision.generation)} ${decision.reason}${probe}`
    : `fallback ${decision.reason}${probe}`
}

function run(initial: World, steps: readonly Step[]): { decisions: string[]; probes: number } {
  const world = { ...initial }
  let duringProbe: Partial<World> | undefined
  let probes = 0
  const selector = new LinuxScopeSelector({
    probe: () => {
      probes += 1
      const result = world.probe
      Object.assign(world, duringProbe)
      duringProbe = undefined
      return result
    },
    managerListener: () => world.listener,
    confirmManager: () => world.confirm,
    launcherIdentity: () => world.launcher,
  })
  const decisions: string[] = []
  for (const step of steps) {
    if (step === 'launch') decisions.push(summary(selector.select()))
    else if ('set' in step) Object.assign(world, step.set)
    else if ('duringProbe' in step) duringProbe = step.duringProbe
    else selector.scopeNotStarted(step.notStarted)
  }
  return { decisions, probes }
}

const scenarios: readonly Scenario[] = [
  {
    name: 'no user manager: probe once, then fall back without probing',
    world: absent,
    steps: ['launch', 'launch', 'launch'],
    decisions: ['fallback probe-unavailable after first', 'fallback no-listener', 'fallback no-listener'],
    probes: 1,
  },
  {
    name: 'systemd 254 and later: probe once, then confirm the manager per launch',
    world: healthy,
    steps: ['launch', 'launch', 'launch'],
    decisions: [
      `scope[${OPTION}]#1 probe-available after first`,
      `scope[${OPTION}]#1 manager-confirmed`,
      `scope[${OPTION}]#1 manager-confirmed`,
    ],
    probes: 1,
  },
  {
    name: 'systemd 236 to 253: scope launches carry no expansion option',
    world: { ...healthy, probe: [], launcher: 'systemd-run-249' },
    steps: ['launch', 'launch'],
    decisions: ['scope[]#1 probe-available after first', 'scope[]#1 manager-confirmed'],
    probes: 1,
  },
  {
    name: 'a manager that stops and returns under a positive verdict falls back only while it is gone',
    world: healthy,
    steps: [
      'launch',
      { set: { listener: undefined, confirm: false } },
      'launch',
      'launch',
      { set: { listener: 'manager-2', confirm: true } },
      'launch',
    ],
    decisions: [
      `scope[${OPTION}]#1 probe-available after first`,
      'fallback manager-unconfirmed',
      'fallback manager-unconfirmed',
      `scope[${OPTION}]#1 manager-confirmed`,
    ],
    probes: 1,
  },
  {
    name: 'a manager hung at the first probe is not probed again until a new manager listens',
    world: { ...absent, listener: 'hung-manager' },
    steps: ['launch', 'launch', 'launch', { set: { ...healthy, listener: 'manager-2' } }, 'launch', 'launch'],
    decisions: [
      'fallback probe-unavailable after first',
      'fallback same-listener',
      'fallback same-listener',
      `scope[${OPTION}]#2 probe-available after new-listener`,
      `scope[${OPTION}]#2 manager-confirmed`,
    ],
    probes: 2,
  },
  {
    name: 'a manager that hangs under a positive verdict costs one probe after its scope never starts',
    world: { ...healthy, listener: 'hung-manager' },
    steps: [
      'launch',
      'launch',
      // The hung manager still listens, so confirmation passes but its scopes never start.
      { set: { probe: undefined } },
      'launch',
      { notStarted: 1 },
      'launch',
      // A second launch from generation 1 fails late; the newer verdict stands.
      { notStarted: 1 },
      'launch',
      { set: { listener: 'manager-2', probe: [OPTION] } },
      'launch',
    ],
    decisions: [
      `scope[${OPTION}]#1 probe-available after first`,
      `scope[${OPTION}]#1 manager-confirmed`,
      `scope[${OPTION}]#1 manager-confirmed`,
      'fallback probe-unavailable after scope-not-started',
      'fallback same-listener',
      `scope[${OPTION}]#3 probe-available after new-listener`,
    ],
    probes: 3,
  },
  {
    name: 'a scope that never starts under a healthy manager probes again and keeps the scope',
    world: healthy,
    steps: ['launch', { notStarted: 1 }, 'launch', 'launch'],
    decisions: [
      `scope[${OPTION}]#1 probe-available after first`,
      `scope[${OPTION}]#2 probe-available after scope-not-started`,
      `scope[${OPTION}]#2 manager-confirmed`,
    ],
    probes: 2,
  },
  {
    name: 'a manager that starts after a failed first probe is used without a restart',
    world: absent,
    steps: ['launch', 'launch', { set: { ...healthy, listener: 'manager-1' } }, 'launch', 'launch'],
    decisions: [
      'fallback probe-unavailable after first',
      'fallback no-listener',
      `scope[${OPTION}]#2 probe-available after new-listener`,
      `scope[${OPTION}]#2 manager-confirmed`,
    ],
    probes: 2,
  },
  {
    name: 'a manager that starts during a failed probe counts as a new listener',
    world: absent,
    steps: [{ duringProbe: { ...healthy, listener: 'manager-1' } }, 'launch', 'launch'],
    decisions: ['fallback probe-unavailable after first', `scope[${OPTION}]#2 probe-available after new-listener`],
    probes: 2,
  },
  {
    name: 'a systemd-run upgrade across v254 probes the literal-argv options again',
    world: { ...healthy, probe: [], launcher: 'systemd-run-253' },
    steps: ['launch', 'launch', { set: { probe: [OPTION], launcher: 'systemd-run-258' } }, 'launch', 'launch'],
    decisions: [
      'scope[]#1 probe-available after first',
      'scope[]#1 manager-confirmed',
      `scope[${OPTION}]#2 probe-available after launcher-changed`,
      `scope[${OPTION}]#2 manager-confirmed`,
    ],
    probes: 2,
  },
  {
    name: 'a removed systemd-run turns a positive verdict negative',
    world: healthy,
    steps: ['launch', { set: { probe: undefined, launcher: undefined } }, 'launch', 'launch'],
    decisions: [
      `scope[${OPTION}]#1 probe-available after first`,
      'fallback probe-unavailable after launcher-changed',
      'fallback same-listener',
    ],
    probes: 2,
  },
]

describe('Linux scope selection', () => {
  it.each(scenarios)('$name', ({ world, steps, decisions, probes }) => {
    expect(run(world, steps)).toEqual({ decisions, probes })
  })

  it('consults only the observations each verdict needs', () => {
    const observe = {
      probe: vi.fn((): readonly string[] | undefined => undefined),
      managerListener: vi.fn((): string | undefined => undefined),
      confirmManager: vi.fn(() => true),
      launcherIdentity: vi.fn((): string | undefined => 'systemd-run'),
    }
    const selector = new LinuxScopeSelector(observe)
    selector.select()
    selector.select()
    expect(observe.probe).toHaveBeenCalledOnce()
    expect(observe.managerListener).toHaveBeenCalledTimes(2)
    expect(observe.launcherIdentity).toHaveBeenCalledOnce()
    expect(observe.confirmManager).not.toHaveBeenCalled()

    observe.probe.mockReturnValue([])
    observe.managerListener.mockReturnValue('manager-1')
    selector.select()
    observe.managerListener.mockClear()
    selector.select()
    expect(observe.managerListener).not.toHaveBeenCalled()
    expect(observe.confirmManager).toHaveBeenCalledOnce()
  })
})
