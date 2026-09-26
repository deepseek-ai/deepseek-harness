/** Replace only update delivery/installation and inspector allocation for the compiled main-entry scenario. */
import { DesktopUpdateCoordinator as Coordinator } from '../../lib/types/update-coordinator.js'
import { DesktopHostProcess as Host } from '../../lib/types/host-process.js'
export { DesktopHostUncleanExitError } from '../../lib/types/host-process.js'
export { DesktopUpdatePreparationError } from '../../lib/types/update-error.js'

export const fixture = { updater: undefined, coordinator: undefined, host: undefined, ready: Promise.withResolvers(), readyHosts: new WeakSet(), states: [], installations: [], taskQueries: [] }
export class DesktopUpdateCoordinator extends Coordinator {
  constructor(publish, beforeRestart) {
    super(state => { fixture.states.push(state); return publish(state) }, beforeRestart, fixture.updater, () => true, () => '0.1.5-rc.1')
    fixture.coordinator = this
  }
}
export class DesktopHostProcess extends Host {
  async updateTasks(action) {
    const result = await super.updateTasks(action)
    fixture.taskQueries.push({ at: Date.now(), action, active: result })
    return result
  }
  constructor(node, runtime, project, _inspectPort, environment, onFailure, primaryRuntime, packageManager) {
    // Port zero lets the OS allocate the development inspector; no fixed listener is acquired.
    super(node, runtime, project, 0, environment, onFailure, primaryRuntime, packageManager)
    fixture.host = this
  }
  async start() {
    try {
      const result = await super.start()
      fixture.readyHosts.add(this)
      fixture.ready.resolve(result.url)
      return result
    } catch (error) { fixture.ready.reject(error); throw error }
  }
}
