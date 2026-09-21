import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { createEphemeralDatabase, describeIntegration, id } from '@fairflow/testing';
import { PrismaClient } from '../generated/prisma';

/**
 * Reference Postgres integration spec (QA-CI T-030 exemplar).
 *
 * Self-skips via `describeIntegration` unless TEST_DATABASE_URL is set, so the
 * plain unit/component jest run stays green without a database. In CI the
 * `test:integration` job provides a real Postgres `service:` + TEST_DATABASE_URL,
 * and this suite spins up its own throwaway `qa_infra_*` database, applies the
 * control migrations to it, and exercises real reads/writes — proving both the
 * @fairflow/testing harness and the CI wiring end-to-end. It is the pattern the
 * T-036 coverage waves follow for further integration suites.
 */
describeIntegration('control Prisma integration (real Postgres)', () => {
  let prisma: PrismaClient;
  let dropDb: () => Promise<void>;

  beforeAll(async () => {
    const eph = await createEphemeralDatabase('control');
    dropDb = eph.drop;
    // Apply the control migrations to the throwaway database. prisma.config.ts
    // reads DATABASE_URL from env, so point it at the ephemeral db for this call.
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, DATABASE_URL: eph.url, DIRECT_URL: eph.url },
      stdio: 'inherit',
    });
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: eph.url }),
    });
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (dropDb) await dropDb();
  }, 60_000);

  it('persists and reads back SystemSettings', async () => {
    const sysId = id('system');
    await prisma.systemSettings.create({
      data: { id: sysId, name: 'Acme', slug: `acme-${sysId}` },
    });
    const found = await prisma.systemSettings.findUnique({ where: { id: sysId } });
    expect(found?.name).toBe('Acme');
  });

  it('isolates projects by owner (real query filtering)', async () => {
    const ownerA = id('user');
    const ownerB = id('user');
    await prisma.project.createMany({
      data: [
        { id: id('proj'), ownerId: ownerA, name: 'A-1' },
        { id: id('proj'), ownerId: ownerA, name: 'A-2' },
        { id: id('proj'), ownerId: ownerB, name: 'B-1' },
      ],
    });
    const aProjects = await prisma.project.findMany({
      where: { ownerId: ownerA },
    });
    expect(aProjects).toHaveLength(2);
    expect(aProjects.every((p) => p.ownerId === ownerA)).toBe(true);
  });
});
