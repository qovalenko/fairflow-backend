/**
 * Single dev seed: auth (users, OAuth client, gateway API key) + control (dev project + owner member).
 * IDs are UUIDv7. Writes services/.fairflow-dev.env for mongo / local tooling.
 *
 * Requires: DATABASE_URL, SEED_GATEWAY_SERVICE_API_KEY
 * Run from repo services/: npm run db:seed:postgres (after migrate deploy + prisma generate on auth & control)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { newEntityId } from '@fairflow/shared';
import { PrismaClient as AuthPrisma } from '../auth/src/generated/prisma';
import { PrismaClient as ControlPrisma } from '../control/src/generated/prisma';
import { loadSeedAuthUsers, seedAuthUsers } from './seed-auth-users';
import { provisionServiceApiKeys, deriveAutomationServiceKey } from './provision-keys';

const servicesRoot = path.resolve(__dirname, '..');

export async function seedPostgres(): Promise<void> {
  loadEnv({ path: path.join(servicesRoot, '.env') });
  loadEnv({ path: path.join(servicesRoot, '.fairflow-dev.env') });

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const gatewayPlainKey = process.env.SEED_GATEWAY_SERVICE_API_KEY?.trim();
  if (!gatewayPlainKey) {
    console.error('SEED_GATEWAY_SERVICE_API_KEY is required (gateway service API key, not committed).');
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString });
  const auth = new AuthPrisma({ adapter });
  const control = new ControlPrisma({ adapter });

  const seedUsers = loadSeedAuthUsers();
  await seedAuthUsers(auth, seedUsers);

  const ownerLogin =
    seedUsers.find((u) => u.devProjectOwner)?.login?.trim() ?? 'admin';
  const admin = await auth.user.findUniqueOrThrow({
    where: { login: ownerLogin },
  });

  // Service API keys + OAuth2 client `fairflow-app` — shared, deterministic,
  // idempotent provisioning (03-ARCHITECTURE.md §2.3). The box provisioner
  // reuses the same `provisionServiceApiKeys`; the SaaS seed only adds demo
  // users/org/project on top.
  const notificationPlainKey = process.env.SEED_NOTIFICATION_SERVICE_API_KEY?.trim();
  const controlPlainKey = process.env.SEED_CONTROL_SERVICE_API_KEY?.trim();
  const automationPlainKey =
    process.env.SEED_AUTOMATION_SERVICE_API_KEY?.trim() ||
    deriveAutomationServiceKey(gatewayPlainKey);
  const keys = await provisionServiceApiKeys(auth, {
    gatewayKey: gatewayPlainKey,
    notificationKey: notificationPlainKey,
    controlKey: controlPlainKey,
    automationKey: automationPlainKey,
    // The dev clientSecret is documented (auth/README.md) — pass it explicitly,
    // the shared provisioner mints a random one when nothing is given.
    oauthAppClientSecret: process.env.SEED_OAUTH_APP_CLIENT_SECRET?.trim() || 'client-secret',
  });
  const gatewayKey = { id: keys.gatewayKeyId };

  // ─── Dev organization + employees (chat DM/group communication scope, B-3) ───
  // resolveCommunicationScope (org-structure.service.ts) gates DM/group creation on
  // the `employee` table: the actor and every peer must be ACTIVE employees of the
  // SAME organization. The org boundary is derived SERVER-SIDE from the project owner
  // (a corporate project's owner IS its org), so the client never asserts the org.
  // We seed one dev org with admin as platform_owner and all other seed users as
  // active employees, and (below) own the Dev Project by this org.
  // DEORG-W1: the Organization entity is gone — box is single-tenant, the instance
  // IS the (implicit) organization = the System. The requisites live in the
  // SystemSettings singleton; child rows carry its id as the system anchor.
  let org = await control.systemSettings.findUnique({
    where: { slug: 'fairflow-dev' },
  });
  if (!org) {
    org = await control.systemSettings.create({
      data: {
        id: newEntityId(),
        name: 'Fairflow Dev',
        slug: 'fairflow-dev',
        isActive: true,
      },
    });
  }
  // admin → platform_owner; the rest of the seed users → active employees.
  const allSeedUsers = await auth.user.findMany({
    where: { login: { in: seedUsers.map((u) => u.login.trim()) } },
    select: { id: true, login: true },
  });
  for (const u of allSeedUsers) {
    const role = u.id === admin.id ? 'platform_owner' : 'employee';
    await control.employee.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: u.id } },
      create: {
        id: newEntityId(),
        organizationId: org.id,
        userId: u.id,
        role,
        isActive: true,
      },
      update: { role, isActive: true },
    });
  }
  console.log(
    'Control dev organization:',
    org.id,
    `(${allSeedUsers.length} active employees)`,
  );

  // Dev Project, OWNED BY the System (ownerId=org.id, the system anchor):
  // resolveCommunicationScope reads the project owner to derive the system boundary
  // for DM/group, so no client-asserted x-organization-id is needed. Every seed user
  // is a projectMember (gateway ProjectAccessGuard requires an explicit member row),
  // so all test users share one project + communication scope.
  let project = await control.project.findFirst({
    where: {
      ownerId: org.id,
      name: 'Dev Project',
      isArchived: false,
    },
  });
  if (!project) {
    project = await control.project.create({
      data: {
        id: newEntityId(),
        ownerId: org.id,
        name: 'Dev Project',
        modules: [
          'contacts',
          'companies',
          'deals',
          'orders',
          'activities',
          'products',
          'reports',
          'documents',
          'automation',
          'chat',
          'notifications',
          'search',
          'statistics',
        ],
      },
    });
  }
  for (const u of allSeedUsers) {
    const role = u.id === admin.id ? 'owner' : 'member';
    await control.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: u.id } },
      create: {
        id: newEntityId(),
        projectId: project.id,
        userId: u.id,
        role,
      },
      update: {},
    });
  }
  console.log('Control dev project:', project.id, '(corporate, org-owned)');

  const envOut = [
    '# Generated by postgres-seed — do not commit',
    `ADMIN_USER_ID=${admin.id}`,
    `DEV_PROJECT_ID=${project.id}`,
    `DEV_ORG_ID=${org.id}`,
    `GATEWAY_API_KEY_ID=${gatewayKey.id}`,
    `GATEWAY_SERVICE_API_KEY=${gatewayPlainKey}`,
    ...(notificationPlainKey ? [`NOTIFICATION_SERVICE_API_KEY=${notificationPlainKey}`] : []),
    ...(controlPlainKey ? [`CONTROL_SERVICE_API_KEY=${controlPlainKey}`] : []),
    ...(automationPlainKey ? [`AUTOMATION_SERVICE_API_KEY=${automationPlainKey}`] : []),
    ...(keys.automationKeyId ? [`AUTOMATION_API_KEY_ID=${keys.automationKeyId}`] : []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(servicesRoot, '.fairflow-dev.env'), envOut, 'utf8');
  console.log('');
  console.log('Wrote services/.fairflow-dev.env (gitignored). For gateway / gRPC clients:');
  console.log('  GATEWAY_SERVICE_API_KEY=' + gatewayPlainKey);
  console.log('  GATEWAY_API_KEY_ID=' + gatewayKey.id);
  console.log('  DEV_ORG_ID=' + org.id + '  (send as x-organization-id for chat DM/group)');

  await auth.$disconnect();
  await control.$disconnect();
}

if (require.main === module) {
  seedPostgres().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
