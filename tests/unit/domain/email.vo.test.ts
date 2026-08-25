import { describe, expect, it } from 'vitest';

import { Email } from '../../../src/domain/value-objects/email.vo';

describe('Email value object', () => {
  it('normalizes to lowercase and trims whitespace', () => {
    const result = Email.create('  Alice@Example.COM  ');
    expect(result.ok).toBe(true);
    const canonical = Email.create('alice@example.com');
    expect(result.ok && canonical.ok && result.value.equals(canonical.value)).toBe(true);
  });

  it('rejects empty string', () => {
    const result = Email.create('');
    expect(result.ok).toBe(false);
    expect(result.ok ? result.value : result.error).toBe('Email must be a non-empty string.');
  });

  it('rejects non-string input', () => {
    const result = Email.create(123 as unknown as string);
    expect(result.ok).toBe(false);
  });

  it('rejects string exceeding 255 characters', () => {
    const long = `${'a'.repeat(250)}@example.com`;
    expect(long.length).toBeGreaterThan(255);
    const result = Email.create(long);
    expect(result.ok).toBe(false);
    expect(result.ok ? result.value : result.error).toContain('255');
  });

  it('accepts 255 characters exactly', () => {
    // 243 + 12 = 255: local(243) + @example.com(12)
    const local = 'a'.repeat(243);
    const addr = `${local}@example.com`;
    expect(addr.length).toBe(255);
    const result = Email.create(addr);
    expect(result.ok).toBe(true);
  });

  it('rejects missing @ sign', () => {
    const result = Email.create('userexample.com');
    expect(result.ok).toBe(false);
    expect(result.ok ? result.value : result.error).toContain('RFC');
  });

  it('rejects empty local part', () => {
    const result = Email.create('@example.com');
    expect(result.ok).toBe(false);
    expect(result.ok ? result.value : result.error).toContain('RFC');
  });

  it('rejects empty domain', () => {
    const result = Email.create('user@');
    expect(result.ok).toBe(false);
    expect(result.ok ? result.value : result.error).toContain('RFC');
  });

  it('rejects domain without dot', () => {
    const result = Email.create('user@localhost');
    expect(result.ok).toBe(false);
    expect(result.ok ? result.value : result.error).toContain('RFC');
  });

  it('rejects domain with leading/trailing dots', () => {
    const result1 = Email.create('user@.example.com');
    expect(result1.ok).toBe(false);
    const result2 = Email.create('user@example.com.');
    expect(result2.ok).toBe(false);
  });

  it('rejects spaces in local part', () => {
    const result = Email.create('us er@example.com');
    expect(result.ok).toBe(false);
    expect(result.ok ? result.value : result.error).toContain('RFC');
  });

  it('equals is true for identical normalized values', () => {
    const a = Email.create('Bob@Test.com');
    const b = Email.create('bob@test.com');
    expect(a.ok && b.ok && a.value.equals(b.value)).toBe(true);
  });

  it('equals is false for different addresses', () => {
    const a = Email.create('alice@example.com');
    const b = Email.create('bob@example.com');
    expect(a.ok && b.ok && a.value.equals(b.value)).toBe(false);
  });

  it('preserves the original trimmed/lowercased string via toString', () => {
    const email = Email.create('  Test@Domain.COM  ');
    expect(email.ok).toBe(true);
    expect(email.ok && email.value.toString()).toBe('test@domain.com');
  });
});
