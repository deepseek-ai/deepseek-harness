/** Error raised when a durable Session artifact cannot be restored or migrated losslessly. */
export class SessionFormatError extends Error {
  override readonly name: string = 'SessionFormatError'
}

/** A readable artifact whose released source policy has no supported migration. */
export class SessionFormatUnsupportedMigrationError extends SessionFormatError {
  override readonly name = 'SessionFormatUnsupportedMigrationError'
}
