import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { REFERENCE_ANYTHING_INVOCATIONS } from './contract.ts'

export const TYPERT_MANIFEST: TypertContribution = {
  package: 'dsh-reference-anything', face: 'host', schemas: [],
  model: { services: [{
    key: 'referenceAnything', exportName: 'ReferenceAnythingRemote',
    description: 'Local conversation mirror, synchronization, and settings for @Conversation.', tags: [],
    members: [
      { kind: 'method', name: 'search', signature: 'search(input: SearchInput): SearchResult[]' },
      { kind: 'method', name: 'health', signature: 'health(signal: AbortSignal): Promise<Health>' },
      { kind: 'method', name: 'profiles', signature: 'profiles(signal: AbortSignal): Promise<BrowserProfile[]>' },
      { kind: 'method', name: 'installAdapter', signature: 'installAdapter(signal: AbortSignal): Promise<boolean>' },
      { kind: 'method', name: 'stats', signature: 'stats(): ProviderStats[]' },
      { kind: 'method', name: 'syncStart', signature: 'syncStart(input: SyncStart): string' },
      { kind: 'method', name: 'syncStatus', signature: 'syncStatus(input: JobInput): SyncStatus | undefined' },
      { kind: 'method', name: 'syncCancel', signature: 'syncCancel(input: JobInput): boolean' },
      { kind: 'method', name: 'settingsGet', signature: 'settingsGet(): Settings' },
      { kind: 'method', name: 'settingsUpdate', signature: 'settingsUpdate(settings: Settings): Promise<Settings>' },
    ], types: [],
  }], events: [], objects: [] },
  invocations: REFERENCE_ANYTHING_INVOCATIONS,
}
