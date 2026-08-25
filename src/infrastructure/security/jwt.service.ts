import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: number;
  email: string;
}

export function expiresToSeconds(expiresIn: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(expiresIn);
  if (!m) return 60 * 60 * 24;
  const n = Number(m[1]);
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const unit = m[2] as string;
  return n * (units[unit] ?? 86400);
}

export class JwtService {
  constructor(
    private readonly secret: string,
    private readonly expiresIn: string = '24h',
  ) {}

  sign(payload: JwtPayload): string {
    return jwt.sign(payload, this.secret, {
      algorithm: 'HS256',
      expiresIn: this.expiresIn as NonNullable<jwt.SignOptions['expiresIn']>,
    });
  }

  /** Cookie lifetime mirrors the token lifetime (§17.3). */
  get maxAgeSeconds(): number {
    return expiresToSeconds(this.expiresIn);
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
