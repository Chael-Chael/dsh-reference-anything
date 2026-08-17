import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { providerSchema, settingsRecordSchema } from './wire.ts'

export const searchInputSchema = z.object({
  query: z.string(), provider: providerSchema.optional(), limit: z.number().int().min(1).max(100),
}).readonly()
export const searchResultSchema = z.object({
  uriId: z.string(), provider: providerSchema, title: z.string(), url: z.string(), updatedAt: z.string(),
  turnCount: z.number().int().nonnegative(), partial: z.boolean(), syncedAt: z.string(),
}).readonly()
export const healthSchema = z.object({ version: z.string(), daemon: z.string(), pluginInstalled: z.boolean() }).readonly()
export const syncStartSchema = z.object({ providers: z.array(providerSchema).min(1), mode: z.enum(['incremental', 'full']) }).readonly()
export const syncStatusSchema = z.object({
  jobId: z.string(), status: z.enum(['running', 'complete', 'cancelled', 'failed']),
  providers: z.array(providerSchema), provider: providerSchema.optional(), completed: z.number(), total: z.number(), error: z.string().optional(),
}).readonly()
export const jobInputSchema = z.object({ jobId: z.string().min(1) }).readonly()

export const REFERENCE_ANYTHING_INVOCATIONS: readonly InvocationDescriptor[] = [
  descriptor('search', [{ name: 'input', wire: 'input', source: 'json', codec: strict('SearchInput', searchInputSchema) }], strict('SearchResult[]', z.array(searchResultSchema)), true),
  descriptor('health', [], strict('Health', healthSchema), true),
  descriptor('syncStart', [{ name: 'input', wire: 'input', source: 'json', codec: strict('SyncStart', syncStartSchema) }], strict('JobId', z.string())),
  descriptor('syncStatus', [{ name: 'input', wire: 'input', source: 'json', codec: strict('JobInput', jobInputSchema) }], strict('SyncStatus?', syncStatusSchema.optional())),
  descriptor('syncCancel', [{ name: 'input', wire: 'input', source: 'json', codec: strict('JobInput', jobInputSchema) }], strict('Boolean', z.boolean())),
  descriptor('settingsGet', [], strict('Settings', settingsRecordSchema)),
  descriptor('settingsUpdate', [{ name: 'settings', wire: 'settings', source: 'json', codec: strict('Settings', settingsRecordSchema) }], strict('Settings', settingsRecordSchema)),
]

function strict(type: string, schema: z.ZodType): { mode: 'strict'; typeSymbol: string; schema: z.ZodType } {
  return { mode: 'strict', typeSymbol: `dsh-reference-anything#${type}`, schema }
}

function descriptor(
  method: string,
  parameters: InvocationDescriptor['parameters'],
  result: NonNullable<InvocationDescriptor['result']>,
  cancelled = false,
): InvocationDescriptor {
  return {
    id: `dsh-reference-anything#referenceAnything/${method}`,
    service: 'referenceAnything', namespace: 'referenceAnything', method,
    invocation: { kind: 'direct' }, parameters,
    ...(cancelled ? { cancellation: { parameter: 'signal' } } : {}), result,
  }
}
