/** Host package commands cannot install dependencies in the browser preview. */
import { notImplementedFail } from '../notImplementedFail.ts'

/** Refuse external package commands in the worker host. */
export const execa = notImplementedFail('execa', 'execa')
