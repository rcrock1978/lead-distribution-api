/**
 * Email value object — normalized (trim + lowercase), RFC-shaped, ≤255 chars.
 * Zero external imports per Constitution II.
 */

/** Loose but practical RFC-5322 subset: local@domain.tld+ (domain must contain at least one dot) */
const RFC_EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export class Email {
  private constructor(private readonly _value: string) {}

  static create(raw: unknown): { ok: true; value: Email } | { ok: false; error: string } {
    if (typeof raw !== 'string') {
      return { ok: false, error: 'Email must be a non-empty string.' };
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) {
      return { ok: false, error: 'Email must be a non-empty string.' };
    }
    if (normalized.length > 255) {
      return { ok: false, error: `Email must be at most 255 characters; received ${normalized.length}.` };
    }
    if (!RFC_EMAIL_RE.test(normalized)) {
      return { ok: false, error: 'Email must be a valid RFC-shaped address (e.g. user@example.com).' };
    }
    return { ok: true, value: new Email(normalized) };
  }

  equals(other: Email): boolean {
    return this._value === other._value;
  }

  toString(): string {
    return this._value;
  }
}
