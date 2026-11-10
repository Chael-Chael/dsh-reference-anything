/** The one Remote method the browser group calls, shared by both halves. */
import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** Typert accepts one contribution per package name; use your own. */
export const PACKAGE = 'dsh-reference-notes'
export const SERVICE = 'referenceNotes'
/** The `source` half of every reference this plugin owns. */
export const SOURCE_ID = 'notes'

export const noteSchema = z.object({ id: z.string(), label: z.string(), updatedAt: z.number() }).strict().readonly()
export type Note = z.infer<typeof noteSchema>
const searchInputSchema = z.object({ query: z.string(), limit: z.number().int().min(1).max(100) }).strict().readonly()

function strict(type: string, schema: z.ZodType) {
  return { mode: 'strict' as const, typeSymbol: `${PACKAGE}#${type}`, schema, create: () => schema }
}

export const INVOCATIONS: readonly InvocationDescriptor[] = [{
  id: `${PACKAGE}#${SERVICE}/search`, service: SERVICE, namespace: SERVICE, method: 'search',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', codec: strict('SearchInput', searchInputSchema) }],
  cancellation: { parameter: 'signal' },
  result: strict('Note[]', z.array(noteSchema)),
}]
