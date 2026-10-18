export function defaultRoots(): Record<string, string | string[] | null>
export function readConversation(fs: unknown, input: {
  format: string; path: string; sessionId: string; limit: number;
  before?: number; revision?: string; detail: 'summary' | 'full';
  probe?: boolean; structured?: boolean;
}, signal?: AbortSignal): Promise<unknown>
