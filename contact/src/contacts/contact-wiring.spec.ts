/**
 * Каркас домена контактов:
 *  - TODO-072 ModuleGuard действительно зарегистрирован (иначе @RequireModule инертен);
 *  - TODO-074 service-only RPC GetContactFields удалён отовсюду;
 *  - TODO-172 TTL-индекс по purgeAt создаётся (иначе корзина копится вечно).
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { REQUIRED_MODULE_KEY } from '@fairflow/shared';
import { AppModule } from '../app.module';
import { FeatureToggleModule } from '../feature-toggle/feature-toggle.module';
import { ContactDedupIndexError, MongoService } from '../mongo/mongo.service';
import { ContactsService } from './contacts.service';
import { ContactGrpcController } from '../grpc/contact.grpc.controller';
import { ReassignTargetValidator } from './reassign-target.validator';

const PROTO_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'proto',
  'fairflow',
  'contact',
  'v1',
  'contact.proto',
);

describe('TODO-072 ModuleGuard включён в домене contact', () => {
  it('AppModule импортирует FeatureToggleModule', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(FeatureToggleModule);
  });

  it('FeatureToggleModule регистрирует глобальный guard с явным Reflector', () => {
    const providers = Reflect.getMetadata('providers', FeatureToggleModule) as {
      provide: string;
      useFactory?: unknown;
      inject?: unknown[];
    }[];
    expect(providers).toHaveLength(1);
    expect(providers[0].provide).toBe('APP_GUARD');
    // useFactory + inject: shared может быть собран без emitDecoratorMetadata,
    // и тогда useClass оставил бы Reflector внутри guard'а undefined.
    expect(typeof providers[0].useFactory).toBe('function');
    expect(providers[0].inject).toHaveLength(1);
  });

  it('gRPC-контроллер по-прежнему помечен @RequireModule("contacts")', () => {
    const required = Reflect.getMetadata(REQUIRED_MODULE_KEY, ContactGrpcController);
    expect(required).toBe('contacts');
  });

  it('DI-граф сервиса собирается целиком (guard + control-клиент реально резолвятся)', async () => {
    // Метаданные модуля можно проверить и статически, но именно compile() ловит
    // случай «провайдер объявлен, а зависимость не доехала» — а он тут новый
    // (ReassignTargetValidator тянет CONTROL_VISIBILITY_GRPC из AuthValidationModule).
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(mod.get(ContactsService)).toBeInstanceOf(ContactsService);
    // Гейт нового владельца должен доехать И до контроллера (create), а не только
    // до сервиса (reassign): у параметра есть значение по умолчанию, и подмена его
    // «пустым» валидатором без control-клиента превратила бы любое назначение
    // чужого ответственного при создании в отказ «сервис недоступен».
    const ctl = mod.get(ContactGrpcController) as unknown as {
      reassignTargets: ReassignTargetValidator;
    };
    expect(ctl.reassignTargets).toBe(mod.get(ReassignTargetValidator));
    await mod.close();
  }, 30_000);
});

describe('TODO-074 GetContactFields удалён', () => {
  it('в proto нет ни RPC, ни сообщений', () => {
    const proto = readFileSync(PROTO_PATH, 'utf8');
    expect(proto).not.toMatch(/rpc GetContactFields/);
    expect(proto).not.toMatch(/message GetContactFieldsRequest/);
    expect(proto).not.toMatch(/message GetContactFieldsResponse/);
  });

  it('в контроллере и сервисе нет соответствующих методов', () => {
    expect(
      (ContactGrpcController.prototype as unknown as Record<string, unknown>).getContactFields,
    ).toBeUndefined();
    expect(
      (ContactsService.prototype as unknown as Record<string, unknown>).getContactFields,
    ).toBeUndefined();
  });
});

describe('TODO-172 TTL-индекс по purgeAt', () => {
  it('ensureContactIndexes создаёт ttl_purge_at с expireAfterSeconds:0', async () => {
    const createIndex = jest.fn(
      async (_key: Record<string, number>, _opts: Record<string, unknown>) => 'ok',
    );
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    (svc as unknown as { db: unknown }).db = { collection: () => ({ createIndex }) };
    await (svc as unknown as { ensureContactIndexes: () => Promise<void> }).ensureContactIndexes();
    const ttl = createIndex.mock.calls.find(
      (c) => (c[1] as { name?: string } | undefined)?.name === 'ttl_purge_at',
    );
    expect(ttl).toBeDefined();
    expect(ttl![0]).toEqual({ purgeAt: 1 });
    expect(ttl![1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  it('партиал-уникальные индексы по нормализованным ключам не потеряны', async () => {
    const createIndex = jest.fn(
      async (_key: Record<string, number>, _opts: Record<string, unknown>) => 'ok',
    );
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    (svc as unknown as { db: unknown }).db = { collection: () => ({ createIndex }) };
    await (svc as unknown as { ensureContactIndexes: () => Promise<void> }).ensureContactIndexes();
    const names = createIndex.mock.calls.map((c) => (c[1] as { name?: string })?.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'project_deleted_updated',
        'uniq_project_email_normalized',
        'uniq_project_phone_normalized',
        'ttl_purge_at',
      ]),
    );
  });

  it('NFR-CONTACTS-070: сбой уникального индекса дедупа — видимый отказ старта', async () => {
    const createIndex = jest.fn(
      async (_key: Record<string, number>, opts: Record<string, unknown>) => {
        if (opts.name === 'uniq_project_email_normalized') {
          throw new Error('duplicate key');
        }
        return 'ok';
      },
    );
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    (svc as unknown as { db: unknown }).db = { collection: () => ({ createIndex }) };
    await expect(
      (svc as unknown as { ensureContactIndexes: () => Promise<void> }).ensureContactIndexes(),
    ).rejects.toBeInstanceOf(ContactDedupIndexError);
  });
});
