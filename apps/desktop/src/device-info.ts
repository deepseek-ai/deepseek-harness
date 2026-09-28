/** Local machine description sent with the Desktop feedback questionnaire. */
import { cpus, totalmem } from 'node:os'

/**
 * Read the local machine description attached to a Desktop feedback submission.
 * Fields are `name=value` pairs separated by `; `, in platform, os, app_arch, cpu and
 * memory_gib order; memory is total physical memory in GiB with one decimal.
 * @returns the machine description, with unavailable fields omitted.
 */
export function readDeviceInfo(): string {
  const fields = [`platform=${process.platform}`]
  collect(fields, 'os', () => process.getSystemVersion())
  fields.push(`app_arch=${process.arch}`)
  collect(fields, 'cpu', () => cpus()[0]?.model)
  collect(fields, 'memory_gib', () => (totalmem() / 1024 ** 3).toFixed(1))
  return fields.join('; ')
}

/**
 * Append one optional field, omitting the field when its source is empty or fails.
 * @param fields - collected fields, appended in call order.
 * @param name - field name written before `=`.
 * @param read - source of the field value.
 */
function collect(fields: string[], name: string, read: () => string | undefined): void {
  let value: string | undefined
  try {
    value = read()
  } catch (_error) {
    // A refused or unsupported source omits only its own field.
    return
  }
  if (value !== undefined && value !== '') fields.push(`${name}=${value}`)
}
