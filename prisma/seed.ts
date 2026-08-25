import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Seeds the single administrator from env (never hardcoded credentials) and
 * guarantees the ConfigVersion row exists. Idempotent.
 */
async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set.');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.upsert({
      where: { email },
      create: { email, passwordHash },
      update: { passwordHash },
    });

    await prisma.configVersion.upsert({
      where: { id: 1 },
      create: { id: 1, version: 1 },
      update: {},
    });

    process.stdout.write(`${JSON.stringify({ event: 'seed.completed', adminEmail: email })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
