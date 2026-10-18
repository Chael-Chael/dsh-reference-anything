import { z } from 'zod'

export { IMPORT_ONLY_AGENTS as IMPORT_ONLY_FORMATS } from './wire.ts'
export const importStatusSchema = z.enum(['imported', 'partial', 'not-imported', 'archived'])
export const discoverySchema = z.object({
  sessions: z.array(z.object({
    format: z.string().min(1), sessionId: z.string().min(1), sourcePath: z.string().min(1),
    title: z.string().nullish(), cwd: z.string().nullish(), project: z.string().nullish(),
    lastActiveAt: z.number().nullish(), importStatus: importStatusSchema.optional(),
  })),
  warnings: z.array(z.object({ format: z.string(), target: z.string(), error: z.string() })),
})
export function scanFormat(kind: string): string {
  return kind === 'claude-code' ? 'claude' : kind === 'gemini-cli' ? 'gemini' : kind
}
export function agentKind(format: string): string {
  return format === 'claude' ? 'claude-code' : format === 'gemini' ? 'gemini-cli' : format
}
