/** Attachments of mirrored Web conversations, fetched through OpenCLI. */
import { ReferenceAnythingError } from '../../errors.ts'
import { DEFAULT_OPENCLI_MAX_STDOUT_BYTES, OpenCliError, OpenCliRunner } from '../../opencli.ts'
import type { ReferenceAttachmentCapability } from '../../types.ts'
import type WebChatHistoryService from './index.ts'

type History = Pick<WebChatHistoryService, 'store' | 'liveAttachment'>

/**
 * @param history - the Web chat service, or a stand-in with its store.
 * @param timeoutMs - how long one OpenCLI download may run.
 */
export function webChatAttachments(history: History, timeoutMs: number): ReferenceAttachmentCapability {
  return {
    directoryPrefix: 'dsh-reference-attachment-',
    async fetch(ref, attachmentId) {
      const conversation = history.store.conversations.get(ref.id)
      const revision = conversation?.currentRevision
      if (!conversation) throw new ReferenceAnythingError('conversation is not in the local title index', 'REFERENCE_NOT_FOUND')
      if (!/^[a-f0-9]{64}$/.test(conversation.accountScope)) {
        throw new ReferenceAnythingError(
          `conversation has no verified ${conversation.provider} account scope; ask the user to sync ${conversation.provider} and reselect the conversation from the refreshed @ list, then retry`,
          'REFERENCE_ACCOUNT_MISMATCH',
        )
      }
      const attachment = history.store.settings.historyMode === 'metadata-only'
        ? history.liveAttachment(ref.id, attachmentId)
        : revision ? history.store.attachment(ref.id, revision, attachmentId) : undefined
      if (!attachment?.locator || attachment.status !== 'available') {
        throw new ReferenceAnythingError('provider supplied no stable attachment locator', 'ATTACHMENT_UNAVAILABLE')
      }
      const locator = attachment.locator
      return {
        name: attachment.name,
        mimeType: attachment.mimeType,
        async writeTo(localPath, maxBytes, signal) {
          const settings = history.store.settings
          const runner = new OpenCliRunner({
            executable: settings.opencliPath, profile: settings.profile, timeoutMs,
            maxStdoutBytes: DEFAULT_OPENCLI_MAX_STDOUT_BYTES,
          })
          try {
            await runner.attachment(conversation.provider, locator, localPath, maxBytes, signal, conversation.accountScope)
          } catch (error) {
            throw openCliFailure(error, signal, conversation.provider)
          }
        },
      }
    },
  }
}

function openCliFailure(error: unknown, signal: AbortSignal | undefined, provider: string): unknown {
  if (error instanceof ReferenceAnythingError || signal?.aborted || !(error instanceof OpenCliError)) {
    if (error instanceof ReferenceAnythingError || signal?.aborted) return error
    return new ReferenceAnythingError(`could not materialize the attachment from ${provider}`, 'REFERENCE_READ_FAILED', { cause: error })
  }
  if (error.code === 'PROVIDER_ACCOUNT_MISMATCH') {
    return new ReferenceAnythingError(
      `attachment belongs to a different logged-in ${provider} account; ask the user to sync ${provider} and reselect the conversation from the refreshed @ list, then retry`,
      'REFERENCE_ACCOUNT_MISMATCH',
      { cause: error },
    )
  }
  if (error.code === 'ATTACHMENT_TOO_LARGE') {
    return new ReferenceAnythingError('attachment exceeds 25 MiB', 'ATTACHMENT_TOO_LARGE', { cause: error })
  }
  if (error.code === 'PROVIDER_RATE_LIMIT') {
    return new ReferenceAnythingError(
      `${provider} rate-limited account verification; wait before retrying the attachment`,
      'PROVIDER_RATE_LIMIT',
      { cause: error },
    )
  }
  return new ReferenceAnythingError(`could not materialize the attachment from ${provider}`, 'REFERENCE_READ_FAILED', { cause: error })
}
