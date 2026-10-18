/** Readable local locator shared by the composer and host. No Node imports. */
export interface LocalLocator { source: string; path: string; sessionId: string }
export const LOCAL_REFERENCE_SCHEME = 'dsh-local:'
export const LOCAL_REFERENCE_OPEN = '<local-agent-reference>'
export const LOCAL_REFERENCE_CLOSE = '</local-agent-reference>'

export function validateLocalLocator(value: unknown): LocalLocator {
  if (!value || typeof value !== 'object') throw new Error('Local reference must contain source, path and sessionId')
  const { source, path, sessionId } = value as Partial<LocalLocator>
  if (![source, path, sessionId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 16384 && !v.includes('\0'))) throw new Error('Local reference must contain source, path and sessionId')
  return { source: source!, path: path!, sessionId: sessionId! }
}

export function localLocatorFromId(id: string): LocalLocator {
  const encoded = id.split(':chat-import:')[1]
  if (!encoded) throw new Error('Reselect this local conversation; the old reference protocol is no longer supported')
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)))) as { format: string; path: string; sessionId: string }
  return validateLocalLocator({ source: parsed.format, path: parsed.path, sessionId: parsed.sessionId })
}

export function encodeLocalLocator(locator: LocalLocator): string {
  return LOCAL_REFERENCE_SCHEME + '?' + new URLSearchParams({ ...validateLocalLocator(locator) }).toString().replaceAll('(', '%28').replaceAll(')', '%29')
}

export function decodeLocalLocator(uri: string): LocalLocator {
  if (!uri.startsWith(LOCAL_REFERENCE_SCHEME + '?')) throw new Error('Invalid local conversation locator')
  const fields = new URLSearchParams(uri.slice(LOCAL_REFERENCE_SCHEME.length + 1))
  return validateLocalLocator({ source: fields.get('source'), path: fields.get('path'), sessionId: fields.get('sessionId') })
}

export function localLocatorId(locator: LocalLocator): string {
  const kind = locator.source === 'claude' ? 'claude-code' : locator.source === 'gemini' ? 'gemini-cli' : locator.source
  const bytes = new TextEncoder().encode(JSON.stringify({ format: locator.source, path: locator.path, sessionId: locator.sessionId }))
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${kind}:chat-import:${encoded}`
}
