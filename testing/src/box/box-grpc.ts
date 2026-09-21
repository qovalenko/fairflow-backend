import { join } from 'node:path';
import { loadSync } from '@grpc/proto-loader';
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  type Client,
  type ServiceClientConstructor,
} from '@grpc/grpc-js';
import { serializeVisibilityScope } from '@fairflow/shared';
import { buildGatewayMetadata, type GatewayMetadataContext } from '../metadata';
import { BOX_GATEWAY_SERVICE_API_KEY, BOX_PEER_GRPC } from './conn';

const LOADER = { keepCase: true, longs: Number, defaults: true, oneofs: true } as const;

const ALL_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

const ALL_PERMISSIONS = [
  'contacts:read',
  'contacts:write',
  'contacts:delete',
  'contacts:merge',
  'companies:read',
  'companies:write',
  'companies:delete',
  'companies:manage',
  'deals:read',
  'deals:write',
  'deals:delete',
  'orders:read',
  'orders:write',
  'orders:move',
  'orders:manage',
  'orders:cancel',
  'products:read',
  'products:write',
  'products:delete',
  'automation:read',
  'automation:write',
  'automation:execute',
  'automation:manage',
  'activities:read',
  'activities:write',
  'project:manage',
];

type UnaryClient = Client & Record<string, (...args: unknown[]) => unknown>;

function servicesRoot(): string {
  return join(__dirname, '..', '..', '..');
}

function protoPath(...parts: string[]): string {
  return join(servicesRoot(), 'proto', 'fairflow', ...parts);
}

function loadService<T extends Client>(
  protoRel: string[],
  servicePath: string[],
  address: string,
): T {
  const def = loadSync(protoPath(...protoRel), {
    ...LOADER,
    includeDirs: [join(servicesRoot(), 'proto')],
  });
  const pkg = loadPackageDefinition(def) as Record<string, unknown>;
  let cur: unknown = pkg;
  for (const seg of servicePath.slice(0, -1)) {
    cur = (cur as Record<string, unknown>)[seg];
  }
  const Service = (cur as Record<string, ServiceClientConstructor>)[
    servicePath[servicePath.length - 1]
  ];
  return new Service(address, credentials.createInsecure()) as unknown as T;
}

export function promisifyUnary<TReq, TRes>(
  client: UnaryClient,
  method: string,
): (req: TReq, metadata?: Metadata) => Promise<TRes> {
  const fn = client[method];
  if (typeof fn !== 'function') {
    throw new Error(`gRPC method ${method} not found on client`);
  }
  const bound = fn.bind(client) as (
    req: TReq,
    md: Metadata,
    cb: (err: Error | null, res: TRes) => void,
  ) => void;
  return (req, metadata = new Metadata()) =>
    new Promise<TRes>((resolve, reject) => {
      bound(req, metadata, (err, res) => (err ? reject(err) : resolve(res)));
    });
}

export function boxServiceMetadata(
  projectId: string,
  userId: string,
  modules: string[] = [
    'contacts',
    'companies',
    'deals',
    'products',
    'orders',
    'search',
    'automation',
    'activities',
  ],
): Metadata {
  return buildGatewayMetadata({
    serviceApiKey: BOX_GATEWAY_SERVICE_API_KEY,
    userId,
    projectId,
    roles: ['owner'],
    permissions: ALL_PERMISSIONS,
    enabledModules: modules,
    visibilityScope: ALL_SCOPE,
  } satisfies GatewayMetadataContext);
}

type GrpcFn = (req: Record<string, unknown>, md?: Metadata) => Promise<Record<string, unknown>>;

export interface BoxPeerGrpcClients {
  control: {
    createProject: GrpcFn;
    archiveProject: GrpcFn;
  };
  contact: {
    createContact: GrpcFn;
    updateContact: GrpcFn;
    mergeContacts: GrpcFn;
  };
  company: {
    createCompany: GrpcFn;
    updateCompany: GrpcFn;
    deleteCompany: GrpcFn;
    mergeCompanies: GrpcFn;
  };
  pipe: {
    listPipelines: GrpcFn;
    createDeal: GrpcFn;
    updateDeal: GrpcFn;
    closeDeal: GrpcFn;
    linkContact: GrpcFn;
    linkCompany: GrpcFn;
  };
  product: {
    createProduct: GrpcFn;
    deleteProduct: GrpcFn;
  };
  automation: {
    createRule: GrpcFn;
    executeRule: GrpcFn;
    manualRun: GrpcFn;
    hookEvent: GrpcFn;
  };
  activity: {
    createActivity: GrpcFn;
  };
  orders: {
    createOrderType: GrpcFn;
    createOrder: GrpcFn;
  };
}

export function createBoxPeerGrpcClients(): BoxPeerGrpcClients {
  const controlRaw = loadService<UnaryClient>(
    ['control', 'v1', 'control.proto'],
    ['fairflow', 'control', 'v1', 'ProjectGrpc'],
    BOX_PEER_GRPC.control,
  );
  const contactRaw = loadService<UnaryClient>(
    ['contact', 'v1', 'contact.proto'],
    ['fairflow', 'contact', 'v1', 'ContactGrpc'],
    BOX_PEER_GRPC.contact,
  );
  const companyRaw = loadService<UnaryClient>(
    ['company', 'v1', 'company.proto'],
    ['fairflow', 'company', 'v1', 'CompanyGrpc'],
    BOX_PEER_GRPC.company,
  );
  const pipeRaw = loadService<UnaryClient>(
    ['pipe', 'v1', 'pipe.proto'],
    ['fairflow', 'pipe', 'v1', 'PipeGrpc'],
    BOX_PEER_GRPC.pipe,
  );
  const productRaw = loadService<UnaryClient>(
    ['product', 'v1', 'product.proto'],
    ['fairflow', 'product', 'v1', 'ProductGrpc'],
    BOX_PEER_GRPC.product,
  );
  const automationRaw = loadService<UnaryClient>(
    ['automation', 'v1', 'automation.proto'],
    ['fairflow', 'automation', 'v1', 'AutomationGrpc'],
    BOX_PEER_GRPC.automation,
  );
  const activityRaw = loadService<UnaryClient>(
    ['activity', 'v1', 'activity.proto'],
    ['fairflow', 'activity', 'v1', 'ActivityGrpc'],
    BOX_PEER_GRPC.activity,
  );
  const ordersRaw = loadService<UnaryClient>(
    ['orders', 'v1', 'orders.proto'],
    ['fairflow', 'orders', 'v1', 'OrdersGrpc'],
    BOX_PEER_GRPC.orders,
  );

  return {
    control: {
      createProject: promisifyUnary(controlRaw, 'CreateProject'),
      archiveProject: promisifyUnary(controlRaw, 'ArchiveProject'),
    },
    contact: {
      createContact: promisifyUnary(contactRaw, 'CreateContact'),
      updateContact: promisifyUnary(contactRaw, 'UpdateContact'),
      mergeContacts: promisifyUnary(contactRaw, 'MergeContacts'),
    },
    company: {
      createCompany: promisifyUnary(companyRaw, 'CreateCompany'),
      updateCompany: promisifyUnary(companyRaw, 'UpdateCompany'),
      deleteCompany: promisifyUnary(companyRaw, 'DeleteCompany'),
      mergeCompanies: promisifyUnary(companyRaw, 'MergeCompanies'),
    },
    pipe: {
      listPipelines: promisifyUnary(pipeRaw, 'ListPipelines'),
      createDeal: promisifyUnary(pipeRaw, 'CreateDeal'),
      updateDeal: promisifyUnary(pipeRaw, 'UpdateDeal'),
      closeDeal: promisifyUnary(pipeRaw, 'CloseDeal'),
      linkContact: promisifyUnary(pipeRaw, 'LinkContact'),
      linkCompany: promisifyUnary(pipeRaw, 'LinkCompany'),
    },
    product: {
      createProduct: promisifyUnary(productRaw, 'CreateProduct'),
      deleteProduct: promisifyUnary(productRaw, 'DeleteProduct'),
    },
    automation: {
      createRule: promisifyUnary(automationRaw, 'CreateRule'),
      executeRule: promisifyUnary(automationRaw, 'ExecuteRule'),
      manualRun: promisifyUnary(automationRaw, 'ManualRun'),
      hookEvent: promisifyUnary(automationRaw, 'HookEvent'),
    },
    activity: {
      createActivity: promisifyUnary(activityRaw, 'CreateActivity'),
    },
    orders: {
      createOrderType: promisifyUnary(ordersRaw, 'CreateOrderType'),
      createOrder: promisifyUnary(ordersRaw, 'CreateOrder'),
    },
  };
}
