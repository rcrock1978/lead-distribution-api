import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: number;
  email: string;
}

export class JwtService {
  constructor(private readonly secret: string) {}

  sign(payload: JwtPayload, expiresIn: NonNullable<jwt.SignOptions['expiresIn']> = '24h'): string {
    return jwt.sign(payload, this.secret, { algorithm: 'HS256', expiresIn });
  }

  /** Signature + expiry only — NO database lookup on the hot path (D5/D14). */
  verify(token: string): JwtPayload | null {
    try {
      const decoded = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') return null;
      if (typeof decoded.sub !== 'number' && typeof decoded.sub !== 'string') return null;
      if (typeof decoded.email !== 'string') return null;
      return { sub: Number(decoded.sub), email: decoded.email };
    } catch {
      return null;
    }
  }
}

export const SESSION_COOKIE_NAME = 'session';

/** Session lifetime (data-model: 24h). */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;
