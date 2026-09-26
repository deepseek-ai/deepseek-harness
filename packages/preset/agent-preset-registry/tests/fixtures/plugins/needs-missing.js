// Waits forever for a service the composition never supplies: the row stays
// pending rather than failing, which only the mount audit can catch.
export const name = 'needs-missing'
export const inject = ['serviceThatDoesNotExist']
export function apply() {}
