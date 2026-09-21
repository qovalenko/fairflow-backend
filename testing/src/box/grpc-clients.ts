import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Metadata } from '@grpc/grpc-js';
import { serializeVisibilityScope } from '@fairflow/shared';
import { buildGatewayMetadata, type GatewayMetadataContext } from '../metadata';
import {
  BOX_GATEWAY_SERVICE_API_KEY,
  BOX_PEER_GRPC,
  LOCAL_AUTOMATION_GRPC_URL,
} from './conn';

const ALL_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

type UnaryClient = Record<string, (...args: unknown[]) => unknown>;

function servicesRoot(): string {
  const candidates = [
    join(process.cwd(), '..'),
    join(process.cwd(), '../..'),
    join(__dirname, '..', '..', '..'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'proto', 'fairflow'))) return p;
  }
  return join(__dirname, '..', '..', '..');
}

function resolveProtoPath(...segments: string[]): string {
  return join(servicesRoot(), 'proto', 'fairflow', ...segments);
}

function loadGrpcClient(protoRel: string[], servicePath: string[], url: string): UnaryClient {
  const protoPath = resolveProtoPath(...protoRel);
  const includeDir = join(servicesRoot(), 'proto');
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [includeDir],
  });
  const pkg = grpc.loadPackageDefinition(def) as Record<string, unknown>;
  let cur: unknown = pkg;
  for (const seg of servicePath.slice(0, -1)) {
    cur = (cur as Record<string, unknown>)[seg];
  }
  const Service = (cur as Record<string, grpc.ServiceClientConstructor>)[
    servicePath[servicePath.length - 1]
  ];
  return new Service(url, grpc.credentials.createInsecure()) as unknown as UnaryClient;
}

function promisifyUnary<TReq, TRes>(
  client: UnaryClient,
  method: string,
): (req: TReq, md?: Metadata) => Promise<TRes> {
  const fn = client[method];
  if (typeof fn !== 'function') throw new Error(`gRPC method ${method} not found`);
  const bound = fn.bind(client) as (
    req: TReq,
    md: Metadata,
    cb: (err: grpc.ServiceError | null, res: TRes) => void,
  ) => void;
  return (req, metadata = new Metadata()) =>
    new Promise<TRes>((resolve, reject) => {
      bound(req, metadata, (err, res) => (err ? reject(err) : resolve(res)));
    });
}

function mdFor(ctx: GatewayMetadataContext): Metadata {
  return buildGatewayMetadata({
    serviceApiKey: BOX_GATEWAY_SERVICE_API_KEY,
    roles: ['owner'],
    permissions: [
      'automation:read',
      'automation:write',
      'automation:manage',
      'deals:read',
      'deals:write',
      'contacts:read',
      'contacts:write',
      'documents:read',
      'documents:write',
      'orders:read',
      'orders:write',
      'activities:read',
      'activities:write',
      'notifications:read',
      'notifications:write',
    ],
    enabledModules: [
      'deals',
      'contacts',
      'orders',
      'documents',
      'automation',
      'notifications',
      'activities',
    ],
    visibilityScope: ALL_SCOPE,
    ...ctx,
  });
}

export interface ControlGrpcClients {
  project: {
    createProject: (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;
    archiveProject: (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;
    listMembers: (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;
    addMember: (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;
    updateMemberRole: (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;
    removeMember: (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;
  };
}

export interface ModuleLifecycleGrpcClient {
  enableModule: (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;
}

export interface AuthGrpcClient {
  provisionUser: (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;
  close(): void;
}

export function createAuthGrpcClient(url = BOX_PEER_GRPC.auth): AuthGrpcClient {
  const raw = loadGrpcClient(['auth', 'v1', 'auth.proto'], ['fairflow', 'auth', 'v1', 'AuthGrpc'], url);
  return {
    provisionUser: promisifyUnary(raw, 'ProvisionUser'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export function createModuleLifecycleGrpcClient(url = BOX_PEER_GRPC.control): ModuleLifecycleGrpcClient {
  const raw = loadGrpcClient(
    ['control', 'v1', 'control.proto'],
    ['fairflow', 'control', 'v1', 'ModuleLifecycleControlGrpc'],
    url,
  );
  return {
    enableModule: promisifyUnary(raw, 'EnableModule'),
  };
}

export function createControlGrpcClient(url: string): ControlGrpcClients {
  const raw = loadGrpcClient(
    ['control', 'v1', 'control.proto'],
    ['fairflow', 'control', 'v1', 'ProjectGrpc'],
    url,
  );
  return {
    project: {
      createProject: promisifyUnary(raw, 'CreateProject'),
      archiveProject: promisifyUnary(raw, 'ArchiveProject'),
      listMembers: promisifyUnary(raw, 'ListMembers'),
      addMember: promisifyUnary(raw, 'AddMember'),
      updateMemberRole: promisifyUnary(raw, 'UpdateMemberRole'),
      removeMember: promisifyUnary(raw, 'RemoveMember'),
    },
  };
}

export interface ContactGrpcClient {
  createContact(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  getContact(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  findDuplicates(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  close(): void;
}

export function createContactGrpcClient(url = BOX_PEER_GRPC.contact): ContactGrpcClient {
  const raw = loadGrpcClient(
    ['contact', 'v1', 'contact.proto'],
    ['fairflow', 'contact', 'v1', 'ContactGrpc'],
    url,
  );
  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    createContact: call('CreateContact'),
    getContact: call('GetContact'),
    findDuplicates: call('FindDuplicates'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export interface CompanyGrpcClient {
  createCompany(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  close(): void;
}

export function createCompanyGrpcClient(url = BOX_PEER_GRPC.company): CompanyGrpcClient {
  const raw = loadGrpcClient(
    ['company', 'v1', 'company.proto'],
    ['fairflow', 'company', 'v1', 'CompanyGrpc'],
    url,
  );
  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    createCompany: call('CreateCompany'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export interface AutomationGrpcClient {
  createRule(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  executeRule(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  hookEvent(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  close(): void;
}

export function createAutomationGrpcClient(url = LOCAL_AUTOMATION_GRPC_URL): AutomationGrpcClient {
  const raw = loadGrpcClient(
    ['automation', 'v1', 'automation.proto'],
    ['fairflow', 'automation', 'v1', 'AutomationGrpc'],
    url,
  );
  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    createRule: call('CreateRule'),
    executeRule: call('ExecuteRule'),
    hookEvent: call('HookEvent'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export interface PipeGrpcClient {
  listPipelines(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  createDeal(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  getDeal(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  updateDeal(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  moveDealToStage(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  closeDeal(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  close(): void;
}

export function createPipeGrpcClient(url = BOX_PEER_GRPC.pipe): PipeGrpcClient {
  const raw = loadGrpcClient(['pipe', 'v1', 'pipe.proto'], ['fairflow', 'pipe', 'v1', 'PipeGrpc'], url);
  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    listPipelines: call('ListPipelines'),
    createDeal: call('CreateDeal'),
    getDeal: call('GetDeal'),
    updateDeal: call('UpdateDeal'),
    moveDealToStage: call('MoveDealToStage'),
    closeDeal: call('CloseDeal'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export interface ActivityGrpcClient {
  createActivity(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  getActivity(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  close(): void;
}

export function createActivityGrpcClient(url = BOX_PEER_GRPC.activity): ActivityGrpcClient {
  const raw = loadGrpcClient(
    ['activity', 'v1', 'activity.proto'],
    ['fairflow', 'activity', 'v1', 'ActivityGrpc'],
    url,
  );
  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    createActivity: call('CreateActivity'),
    getActivity: call('GetActivity'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export interface OrdersGrpcClient {
  listOrderTypes(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  createOrderType(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  updateOrderType(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  createOrder(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  getOrder(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  moveOrderToStage(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  close(): void;
}

export function createOrdersGrpcClient(url = BOX_PEER_GRPC.orders): OrdersGrpcClient {
  const raw = loadGrpcClient(
    ['orders', 'v1', 'orders.proto'],
    ['fairflow', 'orders', 'v1', 'OrdersGrpc'],
    url,
  );
  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    listOrderTypes: call('ListOrderTypes'),
    createOrderType: call('CreateOrderType'),
    updateOrderType: call('UpdateOrderType'),
    createOrder: call('CreateOrder'),
    getOrder: call('GetOrder'),
    moveOrderToStage: call('MoveOrderToStage'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export interface NotificationGrpcClient {
  send(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  updatePreferences(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  close(): void;
}

export function createNotificationGrpcClient(url = BOX_PEER_GRPC.notification): NotificationGrpcClient {
  const raw = loadGrpcClient(
    ['notification', 'v1', 'notification.proto'],
    ['fairflow', 'notification', 'v1', 'NotificationGrpc'],
    url,
  );
  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    send: call('Send'),
    updatePreferences: call('UpdatePreferences'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export interface DocumentsGrpcClient {
  createTemplate(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  getDownloadUrl(req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>>;
  close(): void;
}

export function createDocumentsGrpcClient(url: string): DocumentsGrpcClient {
  const raw = loadGrpcClient(
    ['documents', 'v1', 'documents.proto'],
    ['fairflow', 'documents', 'v1', 'DocumentsGrpc'],
    url,
  );
  const call =
    (method: string) =>
    (req: Record<string, unknown>, ctx: GatewayMetadataContext): Promise<Record<string, unknown>> =>
      promisifyUnary<Record<string, unknown>, Record<string, unknown>>(raw, method)(req, mdFor(ctx));

  return {
    createTemplate: call('CreateTemplate'),
    getDownloadUrl: call('GetDownloadUrl'),
    close: () => {
      const closer = raw.close as (() => void) | undefined;
      closer?.call(raw);
    },
  };
}

export async function waitForGrpcPort(url: string, timeoutMs = 90_000): Promise<void> {
  const hostPort = url.includes('://') ? url.split('://')[1] : url;
  const [host, portStr] = hostPort.split(':');
  const port = Number(portStr);
  const deadline = Date.now() + timeoutMs;
  const net = await import('node:net');
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ host, port }, () => {
          s.end();
          resolve();
        });
        s.on('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`gRPC not reachable at ${url} within ${timeoutMs}ms`);
}

export async function waitForHttpOk(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`HTTP not reachable at ${url} within ${timeoutMs}ms`);
}

type PipelineStage = { id: string; kind?: string; name?: string };

export async function listPipelineStages(
  pipe: PipeGrpcClient,
  ctx: GatewayMetadataContext,
): Promise<{ pipelineId: string; stages: PipelineStage[] }> {
  const r = await pipe.listPipelines({ project_id: ctx.projectId }, ctx);
  const list = (r.list ?? r.pipelines ?? []) as Array<{ id: string; stages?: PipelineStage[] }>;
  const pipeline = list[0];
  const stages = pipeline?.stages ?? [];
  if (!pipeline?.id || !stages.length) throw new Error('no pipeline/stage in project');
  return { pipelineId: pipeline.id, stages };
}

export async function getDefaultPipelineStage(
  pipe: PipeGrpcClient,
  ctx: GatewayMetadataContext,
): Promise<{ pipelineId: string; stageId: string }> {
  const { pipelineId, stages } = await listPipelineStages(pipe, ctx);
  const stageId = stages[0]?.id;
  if (!stageId) throw new Error('no pipeline/stage in project');
  return { pipelineId, stageId };
}

export function findStageByKind(stages: PipelineStage[], kind: string): string | undefined {
  return stages.find((s) => String(s.kind ?? '').toLowerCase() === kind)?.id;
}

export async function createBoxDeal(
  pipe: PipeGrpcClient,
  ctx: GatewayMetadataContext,
  data: Record<string, unknown>,
): Promise<string> {
  const defaults = await getDefaultPipelineStage(pipe, ctx);
  const created = await pipe.createDeal(
    {
      project_id: ctx.projectId,
      amount: 0,
      pipeline_id: defaults.pipelineId,
      stage_id: defaults.stageId,
      ...data,
    },
    ctx,
  );
  return String(created.id ?? created.deal_id ?? '');
}
