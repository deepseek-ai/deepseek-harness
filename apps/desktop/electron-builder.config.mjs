/** Ordinary release entry; qualification imports the environment-independent factory. */
import { createElectronBuilderConfig } from './scripts/electron-builder-config.mjs'

export { createElectronBuilderConfig }
export default createElectronBuilderConfig()
