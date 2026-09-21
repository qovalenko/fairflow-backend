import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { newEntityId } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';

/** NFR-AUTH-030: contract ceiling for service-API-key validation cache TTL (ms). */
export const SERVICE_API_KEY_CACHE_TTL_MS = 60_000;

const PREFIX = 'ak_';
const KEY_BYTES = 32;

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  keyPrefix(key: string): string {
    return key.slice(0, PREFIX.length + 8);
  }

  generateKey(): string {
    const raw = crypto.randomBytes(KEY_BYTES).toString('base64url');
    return PREFIX + raw;
  }

  async create(params: {
    name: string;
    clientId?: string;
    scopes?: string[];
    expiresAt?: Date;
  }): Promise<{ key: string; id: string }> {
    const key = this.generateKey();
    const keyHash = this.hashKey(key);
    const keyPrefix = this.keyPrefix(key);
    const record = await this.prisma.apiKey.create({
      data: {
        id: newEntityId(),
        keyHash,
        keyPrefix,
        name: params.name,
        clientId: params.clientId,
        scopes: params.scopes ?? [],
        expiresAt: params.expiresAt,
      },
    });
    return { key, id: record.id };
  }

  async validate(plainKey: string): Promise<{
    id: string;
    clientId: string | null;
    scopes: string[];
  } | null> {
    if (!plainKey.startsWith(PREFIX)) return null;
    const keyHash = this.hashKey(plainKey);
    const record = await this.prisma.apiKey.findFirst({
      where: { keyHash, isActive: true },
    });
    if (!record) return null;
    if (record.expiresAt && record.expiresAt < new Date()) return null;
    await this.prisma.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    });
    return {
      id: record.id,
      clientId: record.clientId,
      scopes: record.scopes,
    };
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.apiKey.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /** FR-AUTH-370: platform registry — metadata only, never the secret. */
  async listRegistry(): Promise<
    Array<{
      id: string;
      name: string;
      keyPrefix: string;
      scopes: string[];
      expiresAt: Date | null;
      lastUsedAt: Date | null;
      isActive: boolean;
      createdAt: Date;
    }>
  > {
    const rows = await this.prisma.apiKey.findMany({
      orderBy: [{ isActive: 'desc' }, { expiresAt: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        expiresAt: true,
        lastUsedAt: true,
        isActive: true,
        createdAt: true,
      },
    });
    return rows;
  }

  /** Keys that expire within `withinDays` (active only). */
  async findExpiringWithin(
    withinDays: number,
    now = new Date(),
  ): Promise<
    Array<{
      id: string;
      name: string;
      keyPrefix: string;
      expiresAt: Date;
    }>
  > {
    const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60_000);
    const rows = await this.prisma.apiKey.findMany({
      where: {
        isActive: true,
        expiresAt: { not: null, lte: horizon, gt: now },
      },
      select: { id: true, name: true, keyPrefix: true, expiresAt: true },
      orderBy: { expiresAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      expiresAt: r.expiresAt!,
    }));
  }

  /** Keys already past expiry but still marked active. */
  async findExpiredActive(
    now = new Date(),
  ): Promise<Array<{ id: string; name: string; keyPrefix: string; expiresAt: Date }>> {
    const rows = await this.prisma.apiKey.findMany({
      where: { isActive: true, expiresAt: { not: null, lte: now } },
      select: { id: true, name: true, keyPrefix: true, expiresAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      expiresAt: r.expiresAt!,
    }));
  }
}
