import { ErrorCode, type ProblemDetails } from '@codearena/contracts';

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  'token-reused': 401,
  forbidden: 403,
  'forbidden-topic': 403,
  'not-found': 404,
  'handle-taken': 409,
  'already-registered': 409,
  'payload-too-large': 413,
  'unsupported-language': 422,
  'contest-not-started': 422,
  'contest-ended': 422,
  'problem-hidden': 422,
  'hints-disabled-in-contest': 422,
  'hint-level-locked': 422,
  'invalid-package': 422,
  'room-closed': 410,
  'rate-limited': 429,
  'ai-busy': 503,
  internal: 500,
};

const TITLE: Record<ErrorCode, string> = {
  validation: 'Validation failed',
  unauthorized: 'Unauthorized',
  'token-reused': 'Refresh token reused',
  forbidden: 'Forbidden',
  'forbidden-topic': 'Topic not allowed',
  'not-found': 'Not found',
  'handle-taken': 'Handle already taken',
  'already-registered': 'Already registered',
  'payload-too-large': 'Payload too large',
  'unsupported-language': 'Unsupported language',
  'contest-not-started': 'Contest has not started',
  'contest-ended': 'Contest has ended',
  'problem-hidden': 'Problem is hidden',
  'hints-disabled-in-contest': 'Hints are disabled in contests',
  'hint-level-locked': 'Hint level locked',
  'invalid-package': 'Invalid problem package',
  'room-closed': 'Room is closed',
  'rate-limited': 'Too many requests',
  'ai-busy': 'AI is busy',
  internal: 'Internal error',
};

/** Throw this from services/controllers; the filter turns it into RFC 7807 (SRS §3.1.2). */
export class ProblemError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly extra: Pick<ProblemDetails, 'errors'> & { headers?: Record<string, string> } = {},
  ) {
    super(detail ?? TITLE[code]);
    this.status = STATUS[code];
  }

  toBody(instance: string): ProblemDetails {
    return {
      type: `https://codearena.dev/errors/${this.code}`,
      title: TITLE[this.code],
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      instance,
      code: this.code,
      ...(this.extra.errors ? { errors: this.extra.errors } : {}),
    };
  }
}

export const errorStatus = (code: ErrorCode) => STATUS[code];
