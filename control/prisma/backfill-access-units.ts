/**
 * E2-06 — idempotent backfill: Department → AccessUnit (RFC-ACCESS-GROUPS §4).
 *
 * Run AFTER applying the access_unit migration. Safe to re-run (ON CONFLICT DO
 * NOTHING via @@unique / id). NOT part of DDL (CLAUDE.md: data backfill stays out
 * of migrations).
 *
 *  - Department          → AccessUnit{ id = Department.id, scopeType='ORGANIZATION',
 *                          scopeId=organizationId, kind='department', parentId, leaderUserId }
 *                          (SAME id ⇒ RecordShare.granteeId + parentId refs migrate as-is).
 *  - Employee.departmentId != null
 *                        → AccessUnitMember{ unitId=departmentId, memberType='user', memberId=userId }.
 *
 * Usage: cd control && DATABASE_URL=... npx tsx prisma/backfill-access-units.ts
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma';

async function backfillAccessUnits(prisma = new PrismaClient()): Promise<void> {
  const departments = await prisma.department.findMany({
    select: {
      id: true,
      organizationId: true,
      name: true,
      parentId: true,
      leaderUserId: true,
    },
  });

  let units = 0;
  for (const d of departments) {
    // Two-phase parent linking is unnecessary: parentId points at another
    // Department id, which we reuse verbatim as the AccessUnit id. We upsert
    // children before parents? Order is irrelevant — the FK is deferred only at
    // commit, so create units WITHOUT parent first, then patch parentId.
    await prisma.accessUnit.upsert({
      where: { id: d.id },
      create: {
        id: d.id,
        scopeType: 'ORGANIZATION',
        scopeId: d.organizationId,
        name: d.name,
        kind: 'department',
        leaderUserId: d.leaderUserId ?? null,
        // parentId set in the second pass to avoid FK ordering issues.
      },
      update: {
        scopeType: 'ORGANIZATION',
        scopeId: d.organizationId,
        name: d.name,
        kind: 'department',
        leaderUserId: d.leaderUserId ?? null,
      },
    });
    units += 1;
  }

  // Second pass: now every unit exists, set parentId.
  for (const d of departments) {
    if (!d.parentId) continue;
    await prisma.accessUnit.update({
      where: { id: d.id },
      data: { parentId: d.parentId },
    });
  }

  const employees = await prisma.employee.findMany({
    where: { departmentId: { not: null } },
    select: { userId: true, departmentId: true },
  });

  let members = 0;
  for (const e of employees) {
    if (!e.departmentId) continue;
    // Idempotent: @@unique(unitId, memberType, memberId) — skip duplicates.
    const existing = await prisma.accessUnitMember.findFirst({
      where: { unitId: e.departmentId, memberType: 'user', memberId: e.userId },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.accessUnitMember.create({
      data: {
        id: randomUUID(),
        unitId: e.departmentId,
        memberType: 'user',
        memberId: e.userId,
      },
    });
    members += 1;
  }

  await prisma.$executeRaw`
    UPDATE control.system_settings SET access_units_backfilled = true WHERE id = 'system'
  `;

  console.log(`[backfill-access-units] units upserted=${units}, members created=${members}, flag set`);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  backfillAccessUnits(prisma)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}

export { backfillAccessUnits };
