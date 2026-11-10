/** User settings owned by the local-agent source. Shared by Host and client. */
import { z } from 'zod'
import { ALL_LOCAL_AGENTS, localAgentSchema, type LocalAgent } from '../../wire.ts'

export const LOCAL_AGENT_SETTINGS_ID = 'local-agent'

export const localAgentSettingsSchema = z.object({
  /** Agents whose conversations may be listed and read; also the read gate. */
  enabledAgents: z.array(localAgentSchema).default([...ALL_LOCAL_AGENTS]),
  /** One optional additional transcript root per agent. */
  agentDirectories: z.partialRecord(localAgentSchema, z.string().max(4096)).default({}),
  showImport: z.boolean().default(true),
  showSummary: z.boolean().default(false),
  skipConfirmation: z.boolean().default(false),
})
export type LocalAgentSettings = z.infer<typeof localAgentSettingsSchema>

export function defaultLocalAgentSettings(): LocalAgentSettings {
  return { enabledAgents: [...ALL_LOCAL_AGENTS], agentDirectories: {}, showImport: true, showSummary: false, skipConfirmation: false }
}

/**
 * Map the pre-split settings object. Its menu switch for agents also blocked
 * reads, so turning it off migrates to "no agent enabled" rather than to a
 * hidden menu group that still lets the model read.
 */
export function localAgentSettingsFromLegacy(legacy: Readonly<Record<string, unknown>>): LocalAgentSettings | undefined {
  const picker = (legacy.picker ?? {}) as { agents?: { enabled?: boolean; showImport?: boolean; showSummary?: boolean; skipConfirmation?: boolean } }
  const agents = picker.agents ?? {}
  const enabled = Array.isArray(legacy.enabledAgents)
    ? (legacy.enabledAgents as unknown[]).filter((kind): kind is LocalAgent => localAgentSchema.safeParse(kind).success)
    : [...ALL_LOCAL_AGENTS]
  return localAgentSettingsSchema.parse({
    enabledAgents: agents.enabled === false ? [] : enabled,
    agentDirectories: legacy.agentDirectories ?? {},
    ...(typeof agents.showImport === 'boolean' ? { showImport: agents.showImport } : {}),
    ...(typeof agents.showSummary === 'boolean' ? { showSummary: agents.showSummary } : {}),
    ...(typeof agents.skipConfirmation === 'boolean' ? { skipConfirmation: agents.skipConfirmation } : {}),
  })
}
