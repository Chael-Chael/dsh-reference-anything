/** Error mapping for Web conversation attachments fetched through OpenCLI. */
import { ReferenceAnythingError } from '../../errors.ts'
import { OpenCliError } from '../../opencli.ts'

/** Turn an OpenCLI attachment failure into the coded error the model sees. */
export function webAttachmentFailure(error: unknown, signal: AbortSignal | undefined, provider: string): unknown {
  if (error instanceof ReferenceAnythingError || signal?.aborted) return error
  if (!(error instanceof OpenCliError)) {
    return new ReferenceAnythingError(`could not materialize the attachment from ${provider}`, 'REFERENCE_READ_FAILED', { cause: error })
  }
  if (error.code === 'PROVIDER_ACCOUNT_MISMATCH') {
    return new ReferenceAnythingError(
      `attachment belongs to a different logged-in ${provider} account; ask the user to sync ${provider} and reselect the conversation from the refreshed @ list, then retry`,
      'REFERENCE_ACCOUNT_MISMATCH',
      { cause: error },
    )
  }
  if (error.code === 'ATTACHMENT_TOO_LARGE' || error.code === 'OPENCLI_OUTPUT_TOO_LARGE') {
    return new ReferenceAnythingError('attachment exceeds the 50 MiB download limit', 'ATTACHMENT_TOO_LARGE', { cause: error })
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
