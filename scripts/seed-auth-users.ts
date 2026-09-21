/**
 * Сид пользователей auth (login + email в БД, пароли bcrypt).
 * Данные: scripts/data/auth-users.seed.json
 *
 * Из services/:
 *   npm run db:seed:auth-users
 * (нужны DATABASE_URL, миграции auth применены)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as bcrypt from 'bcryptjs';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { newEntityId } from '@fairflow/shared';
import { PrismaClient as AuthPrisma } from '../auth/src/generated/prisma';

export type SeedAuthUserRow = {
  login: string;
  email: string;
  name: string;
  password: string;
  devProjectOwner?: boolean;
};

const servicesRoot = path.resolve(__dirname, '..');

export function loadSeedAuthUsers(): SeedAuthUserRow[] {
  const jsonPath = path.join(__dirname, 'data', 'auth-users.seed.json');
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const list = JSON.parse(raw) as SeedAuthUserRow[];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('auth-users.seed.json must be a non-empty array');
  }
  for (const u of list) {
    if (!u.login?.trim() || !u.email?.trim() || !u.password) {
      throw new Error(`Invalid seed user row: ${JSON.stringify(u)}`);
    }
  }
  return list;
}

export async function seedAuthUsers(auth: AuthPrisma, users: SeedAuthUserRow[]): Promise<void> {
  for (const u of users) {
    const emailNorm = u.email.trim().toLowerCase();
    const hash = await bcrypt.hash(u.password, 10);
    const row = await auth.user.upsert({
      where: { login: u.login.trim() },
      create: {
        id: newEntityId(),
        login: u.login.trim(),
        email: emailNorm,
        name: u.name?.trim() || u.login.trim(),
        passwordHash: hash,
        isActive: true,
        emailVerified: true,
      },
      update: {
        // NB: НЕ сбрасываем passwordHash на update. Сид идемпотентен и перезапускается на
        // КАЖДОМ деплое (PreSync migrate-хук); затирание хэша здесь возвращало бы
        // ротированные/прод-пароли к дефолту сида на каждом релизе (admin/admin, 123Qwe).
        // Пароль выставляется только при create (новый юзер). Существующим — не трогаем.
        email: emailNorm,
        name: u.name?.trim() || u.login.trim(),
        isActive: true,
        emailVerified: true,
      },
    });
    console.log('User:', row.login, row.email, 'id:', row.id);
  }
}

async function main(): Promise<void> {
  loadEnv({ path: path.join(servicesRoot, '.env') });
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const adapter = new PrismaPg({ connectionString });
  const auth = new AuthPrisma({ adapter });
  const users = loadSeedAuthUsers();
  await seedAuthUsers(auth, users);
  await auth.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
