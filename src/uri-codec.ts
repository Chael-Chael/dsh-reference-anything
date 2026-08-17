/** Browser- and Host-safe codec for canonical opaque conversation references. */
import type { ReferenceRef } from './types.ts'

export const REFERENCE_SCHEME = 'dsh-ref:'
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/u

export function encodeReferenceUri(ref: ReferenceRef): string {
  const payload = encodeBase64Url(JSON.stringify({ source: ref.source, id: ref.id }))
  return `${REFERENCE_SCHEME}${payload}`
}

export function decodeReferenceUriUnchecked(uri: string): ReferenceRef {
  if (!uri.startsWith(REFERENCE_SCHEME)) throw new TypeError('wrong reference scheme')
  const payload = uri.slice(REFERENCE_SCHEME.length)
  if (!PAYLOAD_PATTERN.test(payload)) throw new TypeError('invalid base64url payload')
  const parsed: unknown = JSON.parse(decodeBase64Url(payload))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('decoded reference is not an object')
  }
  const { source, id } = parsed as Partial<ReferenceRef>
  if (typeof source !== 'string' || typeof id !== 'string') {
    throw new TypeError('decoded reference lacks string source and id')
  }
  const ref = { source, id }
  if (encodeReferenceUri(ref) !== uri) throw new TypeError('URI is not canonical')
  return ref
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)))
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
