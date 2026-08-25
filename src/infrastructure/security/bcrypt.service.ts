import bcrypt from 'bcryptjs';

const BCRYPT_COST = 12;

/**
 * Password hashing (T024). Cost 12 per data-model; used by the seed script and
 * the login controller. Never called on middleware hot paths.
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
