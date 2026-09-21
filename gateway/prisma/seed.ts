import { PrismaClient } from '../src/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';
import { newEntityId } from '@fairflow/shared';

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const adminRole = await prisma.role.upsert({
    where: { code: 'admin' },
    create: {
      id: newEntityId(),
      code: 'admin',
      name: 'Administrator',
      description: 'Full access',
    },
    update: {},
  });

  const readPermission = await prisma.permission.upsert({
    where: { code: 'read' },
    create: {
      id: newEntityId(),
      code: 'read',
      name: 'Read',
      description: 'Read access',
    },
    update: {},
  });

  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: adminRole.id, permissionId: readPermission.id } },
    create: { roleId: adminRole.id, permissionId: readPermission.id },
    update: {},
  });

  const hashedPassword = await bcrypt.hash('admin', 10);
  await prisma.user.upsert({
    where: { login: 'admin' },
    create: {
      id: newEntityId(),
      email: 'admin@example.com',
      login: 'admin',
      password: hashedPassword,
      name: 'Admin',
      isActive: true,
      roles: { create: [{ roleId: adminRole.id }] },
    },
    update: {},
  });

  console.log('Gateway seed completed');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
