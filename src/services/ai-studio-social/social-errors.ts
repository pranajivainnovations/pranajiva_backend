/**
 * Shared error type for the like/comment/report services — carries an HTTP
 * status and a machine-readable code so route handlers can map it directly
 * to a response without re-deriving what went wrong.
 */
export class SocialActionError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}
