import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  loginAdmin,
  startTestApp,
  type TestApp,
} from './helpers/test-app';

describe('auth endpoints (integration)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs in with valid credentials, sets the session cookie, and serves /me', async () => {
    const res = await api(app.baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: 'test-admin-password-123' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: { user: { email: 'admin@example.com' } },
    });
    expect(res.body).not.toHaveProperty('data.user.passwordHash');

    const session = res.cookies.find((c) => c.startsWith('session='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toContain('Path=/');

    const cookie = session?.split(';')[0] ?? '';
    const me = await api(app.baseUrl, 'GET', '/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      data: { id: expect.any(Number), email: 'admin@example.com' },
    });
  });

  it('rejects a wrong password with a generic 401 (no user enumeration)', async () => {
    const res = await api(app.baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: 'definitely-wrong' },
    });

    expect(res.status).toBe(401);
    const body = res.body as { error?: { code?: string }; data?: unknown };
    expect(body.error?.code).toBe('UNAUTHORIZED');
    // Generic message — must not reveal whether the email exists.
    expect((res.text as string)).not.toContain('password');
    expect(body.data).toBeUndefined();
  });

  it('401s /me without a session cookie', async () => {
    const res = await api(app.baseUrl, 'GET', '/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('logout clears the session and /me then 401s', async () => {
    const login = await loginAdmin(app.baseUrl);

    const logout = await api(app.baseUrl, 'POST', '/api/auth/logout', {
      cookie: login.cookie,
    });
    expect(logout.status).toBe(200);

    const clearing = logout.cookies.find((c) => c.startsWith('session='));
    expect(clearing).toBeDefined();
    expect(clearing?.toLowerCase()).toContain('expires=thu, 01 jan 1970');

    // JWT is stateless (documented trade-off): the BROWSER drops the cookie,
    // but the signed token itself remains valid until expiry. A cookieless
    // call must 401.
    const meNoCookie = await api(app.baseUrl, 'GET', '/api/auth/me');
    expect(meNoCookie.status).toBe(401);
  });

  it('422s malformed login bodies through the shared validation envelope', async () => {
    const res = await api(app.baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'not-an-email', password: '' },
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
