/** A same-site path to come back to after signing in; anything else becomes `fallback` (open-redirect guard). */
export function safeReturnTo(value: string | null | undefined, fallback = '/practice'): string {
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\r\n\t]/.test(value)) return fallback;
  return value;
}
