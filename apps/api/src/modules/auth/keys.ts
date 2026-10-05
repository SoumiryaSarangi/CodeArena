import { createHash } from 'node:crypto';
import type { Role } from '@codearena/contracts';
import {
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
} from 'jose';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ProblemError } from '../../common/problem';
import type { Config } from '../../config/config';

export const ACCESS_TTL_SECONDS = 15 * 60; // FR-AUTH-04
const AUDIENCE = 'codearena-api';
const ALG = 'ES256';

const Claims = z.object({
  sub: z.string().uuid(),
  role: z.enum(['user', 'setter', 'admin']),
  sid: z.string().uuid(),
});

export interface AccessClaims {
  sub: string;
  role: Role;
  /** Refresh-token family the session belongs to. */
  sid: string;
}

export const ACCESS_TOKENS = Symbol('ACCESS_TOKENS');

/** Signs and verifies ES256 access tokens. Verification accepts ES256 only (no `none`, no HMAC). */
export class AccessTokens {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
    private readonly kid: string,
    private readonly issuer: string,
  ) {}

  static async create(config: Config, log: Logger): Promise<AccessTokens> {
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    if (config.JWT_PRIVATE_KEY && config.JWT_PUBLIC_KEY) {
      privateKey = await importPKCS8(config.JWT_PRIVATE_KEY, ALG);
      publicKey = await importSPKI(config.JWT_PUBLIC_KEY, ALG, { extractable: true });
    } else {
      // loadConfig already refuses production without keys; this branch is dev/test only.
      if (config.NODE_ENV === 'production') throw new Error('JWT keys are required in production');
      log.warn('JWT keys not configured: using an ephemeral key pair (sessions end on restart)');
      ({ privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true }));
    }
    const kid = createHash('sha256')
      .update(await exportSPKI(publicKey))
      .digest('hex')
      .slice(0, 16);
    return new AccessTokens(privateKey, publicKey, kid, config.JWT_ISSUER);
  }

  async sign(
    claims: AccessClaims,
    now = Date.now(),
  ): Promise<{ token: string; expiresAt: number }> {
    const iat = Math.floor(now / 1000);
    const exp = iat + ACCESS_TTL_SECONDS;
    const token = await new SignJWT({ role: claims.role, sid: claims.sid })
      .setProtectedHeader({ alg: ALG, kid: this.kid, typ: 'at+jwt' })
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.privateKey);
    return { token, expiresAt: exp * 1000 };
  }

  /** Throws `unauthorized` for anything that is not a valid, unexpired token from us. */
  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG],
        issuer: this.issuer,
        audience: AUDIENCE,
        typ: 'at+jwt',
        clockTolerance: 5,
      });
      return Claims.parse(payload);
    } catch {
      throw new ProblemError('unauthorized', 'Access token is missing, invalid or expired');
    }
  }
}
