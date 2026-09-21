import { join } from 'node:path';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, type ClientsModuleAsyncOptions, Transport } from '@nestjs/microservices';
import { listGatewayGrpcClients } from '@fairflow/shared';
import { ConfigModule } from '../config/config.module';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { SystemOrgResolverService } from './system-org-resolver.service';
import { SessionDenyListService } from '../auth/session-deny-list.service';

const proto = (...parts: string[]) =>
  join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);

/** No automatic retries on mutating RPCs; callers handle UNAVAILABLE explicitly if needed. */
const grpcChannelOptions = {
  'grpc.keepalive_time_ms': 30_000,
  'grpc.keepalive_timeout_ms': 10_000,
  'grpc.keepalive_permit_without_calls': 1,
};

const grpcLoaderOptions = {
  keepCase: true,
  // Пустой proto `repeated` иначе опускается из ответа → `r.list` === undefined и `.map` падает
  // (напр. ListDeals при нуле сделок). `arrays: true` гарантирует `[]` для пустых repeated.
  arrays: true,
  // Четвёртая ипостась грабли «loader без полных опций молча теряет данные»:
  // без `longs: Number` proto-loader декодирует КАЖДОЕ int64-поле в объект
  // Long {low, high, unsigned}, тогда как TypeScript видит объявленный `number`
  // и молчит. Итог — `new Date(Long)` = Invalid Date, `dayjs.unix(Long)` =
  // Invalid Date, `Number(Long)` = NaN: даты и счётчики доезжают до фронта
  // мусором. `longs: Number` отдаёт обычное число (int64 в наших полях — это
  // метки времени/счётчики, далеко внутри Number.MAX_SAFE_INTEGER).
  longs: Number,
};

const logger = new Logger('GrpcBffModule');

/**
 * gRPC client registry — GENERATED from module manifests + infra descriptors
 * (E1-03 / FR-MOD-23). The hardcoded per-domain blocks are gone: each 1st-party
 * module manifest that declares `backend.grpcClient` and each `INFRA_GRPC_CLIENTS`
 * entry contributes exactly one `ClientsModule.registerAsync` entry here. Adding a
 * new domain module = dropping its manifest, no edit to this file
 * (criterion FR-MOD-23). fail-soft per descriptor is handled in shared (FR-MOD-33).
 *
 * The DI tokens, packages and proto paths are byte-for-byte the same as the prior
 * hardcode, so every existing `@Inject('<DOMAIN>_GRPC')` in the BFF controllers
 * keeps resolving unchanged (backward compatible).
 */
const grpcClientRegistrations: ClientsModuleAsyncOptions = listGatewayGrpcClients((msg) =>
  logger.warn(msg),
).map((descriptor) => ({
  name: descriptor.token,
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    transport: Transport.GRPC as const,
    options: {
      package: descriptor.package,
      protoPath: proto(...descriptor.protoPath),
      url: config.get<string>(descriptor.urlConfigKey, descriptor.defaultUrl),
      channelOptions: grpcChannelOptions,
      loader: grpcLoaderOptions,
    },
  }),
  inject: [ConfigService],
}));

@Global()
@Module({
  imports: [ClientsModule.registerAsync(grpcClientRegistrations)],
  providers: [GatewayOutboundMetadataService, SystemOrgResolverService, SessionDenyListService],
  exports: [
    ClientsModule,
    GatewayOutboundMetadataService,
    SystemOrgResolverService,
    SessionDenyListService,
  ],
})
export class GrpcBffModule {}
