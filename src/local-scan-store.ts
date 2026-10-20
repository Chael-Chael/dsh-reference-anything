import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { discoverySchema } from './chat-import-discovery.ts'

const snapshot = z.object({ snapshot: discoverySchema, scannedAt: z.number() })
const summary = z.object({ conversations: z.number(), scannedAt: z.number(), error: z.string().optional() })

/** Profile-owned metadata only. Keep this cache separate from conversation bodies and user settings. */
export const scanDomainSpec = defineDomain({
  name: 'reference_local_scans',
  version: 1,
  tables: {
    snapshots: domainTable<string, z.infer<typeof snapshot>>(snapshot),
    summaries: domainTable<string, z.infer<typeof summary>>(summary),
  },
})
