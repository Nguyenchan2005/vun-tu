export class CloudUnavailableError extends Error {
  override name = 'CloudUnavailableError'
}

/**
 * A deterministic sync failure that cannot recover through background retries.
 * The affected mutations stay in the outbox and may still be retried manually.
 */
export class NonRetryableCloudError extends Error {
  override name = 'NonRetryableCloudError'
  readonly retryable = false
  readonly affectedMutationIds?: readonly string[]

  constructor(
    message: string,
    options: {
      cause?: unknown
      affectedMutationIds?: readonly string[]
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.affectedMutationIds = options.affectedMutationIds
  }
}

export function isNonRetryableCloudError(
  error: unknown,
): error is NonRetryableCloudError {
  return (
    error instanceof NonRetryableCloudError ||
    (typeof error === 'object' &&
      error !== null &&
      'retryable' in error &&
      error.retryable === false)
  )
}

export function cloudErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return 'Cloud sync failed for an unknown reason.'
}
