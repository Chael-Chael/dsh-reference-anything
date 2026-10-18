import { LOCAL_REFERENCE_SCHEME, decodeLocalLocator, encodeLocalLocator, localLocatorFromId, localLocatorId } from './local-locator.ts'
/** Browser- and Host-safe codec for canonical opaque conversation references. */
import type { ReferenceRef } from './types.ts'
import { deflateSync, inflateSync } from 'fflate'

export const REFERENCE_SCHEME = 'dsh-ref:'
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/u
const COMPRESSED_PREFIX = 'z1_'
const MAX_COMPRESSED_REFERENCE_BYTES = 64 * 1024

export function encodeReferenceUri(ref: ReferenceRef): string {
  if (ref.source === 'local-agent') return encodeLocalLocator(localLocatorFromId(ref.id))
  const legacy = encodeLegacyReferenceUri(ref)
  const bytes = new TextEncoder().encode(JSON.stringify(compactReference(ref)))
  if (bytes.length > MAX_COMPRESSED_REFERENCE_BYTES) return legacy
  const compressed = deflateSync(bytes, { level: 9 })
  const payload = new Uint8Array(4 + compressed.length)
  new DataView(payload.buffer).setUint32(0, bytes.length)
  payload.set(compressed, 4)
  const uri = `${REFERENCE_SCHEME}${COMPRESSED_PREFIX}${encodeBytes(payload)}`
  return uri.length < legacy.length ? uri : legacy
}

export function encodeLegacyReferenceUri(ref: ReferenceRef): string {
  const payload = encodeBase64Url(JSON.stringify({ source: ref.source, id: ref.id }))
  return `${REFERENCE_SCHEME}${payload}`
}

export function decodeReferenceUriUnchecked(uri: string): ReferenceRef {
  if (uri.startsWith(LOCAL_REFERENCE_SCHEME)) return { source: 'local-agent', id: localLocatorId(decodeLocalLocator(uri)) }
  if (!uri.startsWith(REFERENCE_SCHEME)) throw new TypeError('wrong reference scheme')
  const payload = uri.slice(REFERENCE_SCHEME.length)
  if (!PAYLOAD_PATTERN.test(payload)) throw new TypeError('invalid base64url payload')
  const compressed = payload.startsWith(COMPRESSED_PREFIX)
  let text: string
  if (compressed) {
    if (payload.length > MAX_COMPRESSED_REFERENCE_BYTES * 2) throw new TypeError('reference payload too large')
    const bytes = decodeBytes(payload.slice(COMPRESSED_PREFIX.length))
    if (bytes.length <= 4) throw new TypeError('truncated compressed reference')
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    if (!length || length > MAX_COMPRESSED_REFERENCE_BYTES) throw new TypeError('reference output too large')
    text = new TextDecoder('utf-8', { fatal: true }).decode(inflateSync(bytes.subarray(4), { out: new Uint8Array(length) }))
  } else text = decodeBase64Url(payload)
  let parsed: unknown = JSON.parse(text)
  if (compressed && Array.isArray(parsed) && (parsed.length === 2 || parsed.length === 3) && parsed.every(item => typeof item === 'string')) {
    parsed = { source: parsed[0], id: parsed.length === 3 ? parsed[1]! + encodeBase64Url(parsed[2]!) : parsed[1] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('decoded reference is not an object')
  }
  const { source, id } = parsed as Partial<ReferenceRef>
  if (typeof source !== 'string' || typeof id !== 'string') {
    throw new TypeError('decoded reference lacks string source and id')
  }
  if (source === 'local-agent') throw new TypeError('Old local reference protocol is no longer supported; reselect the conversation')
  const ref = { source, id }
  if ((compressed ? encodeReferenceUri(ref) : encodeLegacyReferenceUri(ref)) !== uri) throw new TypeError('URI is not canonical')
  return ref
}

function compactReference(ref: ReferenceRef): string[] {
  const separator = ref.source === 'web-chat' ? -1 : ref.id.lastIndexOf(':')
  if (ref.source === 'web-chat' || ref.source === 'cloud-drive' || (ref.source === 'local-agent' && ref.id.includes(':chat-import:'))) {
    const prefix = ref.id.slice(0, separator + 1)
    const payload = ref.id.slice(separator + 1)
    try {
      const decoded = decodeBase64Url(payload)
      JSON.parse(decoded)
      if (encodeBase64Url(decoded) === payload) return [ref.source, prefix, decoded]
    } catch { /* Nonstandard ids remain opaque and lossless. */ }
  }
  return [ref.source, ref.id]
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  return encodeBytes(bytes)
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)))
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(decodeBytes(value))
}

function decodeBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return bytes
}
