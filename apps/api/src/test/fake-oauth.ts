import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

export interface FakeIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

interface Grant {
  provider: 'google' | 'github';
  identity: FakeIdentity;
  challenge: string;
  nonce?: string;
  clientId: string;
}

/**
 * In-process stand-in for Google (OIDC) and GitHub. It issues codes from `authorize()`, and its
 * token endpoints check the PKCE verifier against the stored S256 challenge like the real ones.
 */
export class FakeOAuth {
  private server!: Server;
  private key!: CryptoKey;
  private jwk!: Record<string, unknown>;
  private grants = new Map<string, Grant>();
  private tokens = new Map<string, FakeIdentity>();
  base = '';
  readonly issuer = 'https://fake-google.test';

  async start() {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    this.key = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  env(): Record<string, string> {
    return {
      OAUTH_GOOGLE_CLIENT_ID: 'google-client',
      OAUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
      OAUTH_GOOGLE_AUTH_URL: `${this.base}/google/authorize`,
      OAUTH_GOOGLE_TOKEN_URL: `${this.base}/google/token`,
      OAUTH_GOOGLE_JWKS_URL: `${this.base}/google/jwks`,
      OAUTH_GOOGLE_ISSUER: this.issuer,
      OAUTH_GITHUB_CLIENT_ID: 'github-client',
      OAUTH_GITHUB_CLIENT_SECRET: 'github-secret',
      OAUTH_GITHUB_AUTH_URL: `${this.base}/github/authorize`,
      OAUTH_GITHUB_TOKEN_URL: `${this.base}/github/token`,
      OAUTH_GITHUB_API_URL: `${this.base}/github/api`,
    };
  }

  /** What the user's browser would get back from the consent screen for this authorize URL. */
  authorize(authorizeUrl: string, identity: FakeIdentity): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    const provider = u.pathname.startsWith('/google') ? 'google' : 'github';
    if (u.searchParams.get('code_challenge_method') !== 'S256')
      throw new Error('PKCE S256 missing');
    const code = randomBytes(16).toString('hex');
    this.grants.set(code, {
      provider,
      identity,
      challenge: u.searchParams.get('code_challenge')!,
      nonce: u.searchParams.get('nonce') ?? undefined,
      clientId: u.searchParams.get('client_id')!,
    });
    return { code, state: u.searchParams.get('state')! };
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) {
    const url = new URL(req.url!, this.base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/google/jwks') return json(200, { keys: [this.jwk] });

    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const grant = this.grants.get(form.get('code') ?? '');
      this.grants.delete(form.get('code') ?? ''); // codes are single use
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!grant || grant.challenge !== challenge || grant.clientId !== form.get('client_id')) {
        return json(400, { error: 'invalid_grant' });
      }
      if (grant.provider === 'google') {
        const idToken = await new SignJWT({
          email: grant.identity.email,
          email_verified: grant.identity.emailVerified,
          nonce: grant.nonce,
          name: grant.identity.name,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(this.issuer)
          .setAudience(grant.clientId)
          .setSubject(grant.identity.sub)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(this.key);
        return json(200, { id_token: idToken, access_token: 'unused', token_type: 'Bearer' });
      }
      const access = randomBytes(16).toString('hex');
      this.tokens.set(access, grant.identity);
      return json(200, { access_token: access, token_type: 'bearer' });
    }

    const identity = this.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (url.pathname === '/github/api/user') {
      if (!identity) return json(401, {});
      return json(200, {
        id: Number(identity.sub),
        login: identity.name ?? 'octo',
        name: identity.name ?? null,
        avatar_url: null,
      });
    }
    if (url.pathname === '/github/api/user/emails') {
      if (!identity) return json(401, {});
      return json(200, [
        { email: 'secondary@example.com', primary: false, verified: true },
        { email: identity.email, primary: true, verified: identity.emailVerified },
      ]);
    }
    json(404, {});
  }
}
