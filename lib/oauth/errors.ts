export class OAuthRequestError extends Error {
  constructor(
    public readonly oauthError:
      | 'invalid_request'
      | 'invalid_grant'
      | 'unsupported_grant_type'
      | 'access_denied'
      | 'temporarily_unavailable',
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthRequestError';
  }
}

export class InvalidAccessTokenError extends Error {
  constructor(message = 'Invalid MCP access token') {
    super(message);
    this.name = 'InvalidAccessTokenError';
  }
}

export class RateLimitError extends Error {
  constructor() {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
  }
}
