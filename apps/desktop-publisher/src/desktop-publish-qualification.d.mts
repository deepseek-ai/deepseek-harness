/** Explain why retained debugging packages cannot enter either publication environment. */
/**
 * Return rebuilding instructions for debugging packages.
 * @param qualification Recorded package qualification.
 * @returns Diagnostic, or undefined for a non-debugging qualification.
 */
export function desktopPublishQualificationError(qualification: string): string | undefined
