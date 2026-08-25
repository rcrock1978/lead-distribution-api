import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  loginAdmin,
  startTestApp,
  type TestApp,
} from '../integration/helpers/test-app';

/**
 * §19.4 concurrency case: two PARALLEL form creations — the singleton
 * unique index must let exactly one succeed and 409 the other.
 */
describe('form creation race (2 parallel)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exactly one of two parallel POSTs succeeds; DB holds one row', async () => {
    const session = await loginAdmin(app.baseUrl);
    const body = { name: `Race Form ${Date.now()}` };
    const opts = { body, cookie: session.cookie };
    const [a, b] = await Promise.all([
      api(app.baseUrl, 'POST', '/api/form', opts),
      api(app.baseUrl, 'POST', '/api/form', opts),
    ]);

    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect((loser.body as { error: { code: string } }).error.code).toBe(
      'FORM_ALREADY_EXISTS',
    );

    const rows = await app.prisma.form.findMany({
      where: { name: body.name },
    });
    expect(rows.length).toBe(1);
  });
});
