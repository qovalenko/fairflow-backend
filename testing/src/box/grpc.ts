import { join } from "node:path";
import { loadSync } from "@grpc/proto-loader";
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  type Client,
  type ServiceClientConstructor,
} from "@grpc/grpc-js";

const LOADER = { keepCase: true, arrays: true, longs: Number } as const;

function servicesRoot(): string {
  // testing/dist/box → testing → repo root (worktree backend root)
  return join(__dirname, "..", "..", "..");
}

function protoPath(...parts: string[]): string {
  return join(servicesRoot(), "proto", "fairflow", ...parts);
}

function loadService<T extends Client>(
  protoRel: string[],
  servicePath: string[],
  address: string,
): T {
  const def = loadSync(protoPath(...protoRel), {
    ...LOADER,
    includeDirs: [join(servicesRoot(), "proto")],
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

type UnaryClient = Client & Record<string, (...args: unknown[]) => unknown>;

/** Promisified unary gRPC on a dynamically loaded client. */
export function promisifyUnary<TReq, TRes>(
  client: UnaryClient,
  method: string,
): (req: TReq, metadata?: Metadata) => Promise<TRes> {
  const fn = client[method];
  if (typeof fn !== "function") {
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

export interface ControlGrpcClients {
  address: string;
  project: {
    createProject: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    getProject: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    listMembers: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    resolveRecordVisibility: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    getModuleDisableImpact: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    updateProject: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    archiveProject: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    requestProjectDeletion: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    addMember: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
  };
  moduleLifecycle: {
    listModuleStates: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    disableModule: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    enableModule: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    resumeModuleDelivery: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
  };
  organization: {
    listDepartments: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    deactivateEmployee: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
    addEmployee: (
      req: Record<string, unknown>,
      md?: Metadata,
    ) => Promise<Record<string, unknown>>;
  };
}

export function createControlGrpcClient(address: string): ControlGrpcClients {
  const projectRaw = loadService<UnaryClient>(
    ["control", "v1", "control.proto"],
    ["fairflow", "control", "v1", "ProjectGrpc"],
    address,
  );
  const lifecycleRaw = loadService<UnaryClient>(
    ["control", "v1", "control.proto"],
    ["fairflow", "control", "v1", "ModuleLifecycleControlGrpc"],
    address,
  );
  const organizationRaw = loadService<UnaryClient>(
    ["control", "v1", "control.proto"],
    ["fairflow", "control", "v1", "OrganizationGrpc"],
    address,
  );
  return {
    address,
    project: {
      createProject: promisifyUnary(projectRaw, "CreateProject"),
      getProject: promisifyUnary(projectRaw, "GetProject"),
      listMembers: promisifyUnary(projectRaw, "ListMembers"),
      resolveRecordVisibility: promisifyUnary(
        projectRaw,
        "ResolveRecordVisibility",
      ),
      getModuleDisableImpact: promisifyUnary(
        projectRaw,
        "GetModuleDisableImpact",
      ),
      updateProject: promisifyUnary(projectRaw, "UpdateProject"),
      archiveProject: promisifyUnary(projectRaw, "ArchiveProject"),
      requestProjectDeletion: promisifyUnary(projectRaw, "RequestProjectDeletion"),
      addMember: promisifyUnary(projectRaw, "AddMember"),
    },
    moduleLifecycle: {
      listModuleStates: promisifyUnary(lifecycleRaw, "ListModuleStates"),
      disableModule: promisifyUnary(lifecycleRaw, "DisableModule"),
      enableModule: promisifyUnary(lifecycleRaw, "EnableModule"),
      resumeModuleDelivery: promisifyUnary(
        lifecycleRaw,
        "ResumeModuleDelivery",
      ),
    },
    organization: {
      listDepartments: promisifyUnary(organizationRaw, "ListDepartments"),
      deactivateEmployee: promisifyUnary(organizationRaw, "DeactivateEmployee"),
      addEmployee: promisifyUnary(organizationRaw, "AddEmployee"),
    },
  };
}

export function createPipeGrpcClient(address: string): {
  listPipelines: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["pipe", "v1", "pipe.proto"],
    ["fairflow", "pipe", "v1", "PipeGrpc"],
    address,
  );
  return { listPipelines: promisifyUnary(raw, "ListPipelines") };
}

export function createAuthGrpcClient(address: string): {
  provisionUser: (
    req: { email: string; name: string; password: string },
    md?: Metadata,
  ) => Promise<{ user: Record<string, unknown>; created: boolean }>;
} {
  const raw = loadService<UnaryClient>(
    ["auth", "v1", "auth.proto"],
    ["fairflow", "auth", "v1", "AuthGrpc"],
    address,
  );
  return { provisionUser: promisifyUnary(raw, "ProvisionUser") };
}

export function createOrdersGrpcClient(address: string): {
  listOrderTypes: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
  createOrder: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
  provisionDefaults: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["orders", "v1", "orders.proto"],
    ["fairflow", "orders", "v1", "OrdersGrpc"],
    address,
  );
  return {
    listOrderTypes: promisifyUnary(raw, "ListOrderTypes"),
    createOrder: promisifyUnary(raw, "CreateOrder"),
    provisionDefaults: promisifyUnary(raw, "ProvisionDefaults"),
  };
}

export function createAuthDirectoryGrpcClient(address: string): {
  resolveUsers: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
  revokeUserSessions: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["auth", "v1", "auth.proto"],
    ["fairflow", "auth", "v1", "UserDirectoryGrpc"],
    address,
  );
  return {
    resolveUsers: promisifyUnary(raw, "ResolveUsers"),
    revokeUserSessions: promisifyUnary(raw, "RevokeUserSessions"),
  };
}

export function createAuthApiKeyGrpcClient(address: string): {
  validateServiceApiKey: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["auth", "v1", "auth.proto"],
    ["fairflow", "auth", "v1", "ApiKeyGrpc"],
    address,
  );
  return {
    validateServiceApiKey: promisifyUnary(raw, "ValidateServiceApiKey"),
  };
}

export function createDocumentsGrpcClient(address: string): {
  listTemplates: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
  provisionDefaults: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["documents", "v1", "documents.proto"],
    ["fairflow", "documents", "v1", "DocumentsGrpc"],
    address,
  );
  return {
    listTemplates: promisifyUnary(raw, "ListTemplates"),
    provisionDefaults: promisifyUnary(raw, "ProvisionDefaults"),
  };
}

export function createAutomationGrpcClient(address: string): {
  listRules: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
  createRule: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
  deleteRule: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["automation", "v1", "automation.proto"],
    ["fairflow", "automation", "v1", "AutomationGrpc"],
    address,
  );
  return {
    listRules: promisifyUnary(raw, "ListRules"),
    createRule: promisifyUnary(raw, "CreateRule"),
    deleteRule: promisifyUnary(raw, "DeleteRule"),
  };
}

export function createContactGrpcClient(address: string): {
  listContacts: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
  createContact: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["contact", "v1", "contact.proto"],
    ["fairflow", "contact", "v1", "ContactGrpc"],
    address,
  );
  return {
    listContacts: promisifyUnary(raw, "ListContacts"),
    createContact: promisifyUnary(raw, "CreateContact"),
  };
}

export function createCompanyGrpcClient(address: string): {
  listCompanies: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
  createCompany: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["company", "v1", "company.proto"],
    ["fairflow", "company", "v1", "CompanyGrpc"],
    address,
  );
  return {
    listCompanies: promisifyUnary(raw, "ListCompanies"),
    createCompany: promisifyUnary(raw, "CreateCompany"),
  };
}

export function createActivityGrpcClient(address: string): {
  listActivities: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["activity", "v1", "activity.proto"],
    ["fairflow", "activity", "v1", "ActivityGrpc"],
    address,
  );
  return { listActivities: promisifyUnary(raw, "ListActivities") };
}

export function createProductGrpcClient(address: string): {
  listProducts: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["product", "v1", "product.proto"],
    ["fairflow", "product", "v1", "ProductGrpc"],
    address,
  );
  return { listProducts: promisifyUnary(raw, "ListProducts") };
}

export function createReportsGrpcClient(address: string): {
  listReports: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["reports", "v1", "reports.proto"],
    ["fairflow", "reports", "v1", "ReportsGrpc"],
    address,
  );
  return { listReports: promisifyUnary(raw, "ListReports") };
}

export function createSearchGrpcClient(address: string): {
  listUnassigned: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["search", "v1", "search.proto"],
    ["fairflow", "search", "v1", "SearchGrpc"],
    address,
  );
  return { listUnassigned: promisifyUnary(raw, "ListUnassigned") };
}

export function createNotificationGrpcClient(address: string): {
  listNotifications: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["notification", "v1", "notification.proto"],
    ["fairflow", "notification", "v1", "NotificationGrpc"],
    address,
  );
  return { listNotifications: promisifyUnary(raw, "ListNotifications") };
}

export function createChatGrpcClient(address: string): {
  listConversations: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["chat", "v1", "chat.proto"],
    ["fairflow", "chat", "v1", "ChatService"],
    address,
  );
  return { listConversations: promisifyUnary(raw, "ListConversations") };
}

export function createAuditGrpcClient(address: string): {
  listEvents: (
    req: Record<string, unknown>,
    md?: Metadata,
  ) => Promise<Record<string, unknown>>;
} {
  const raw = loadService<UnaryClient>(
    ["audit", "v1", "audit.proto"],
    ["fairflow", "audit", "v1", "AuditGrpc"],
    address,
  );
  return { listEvents: promisifyUnary(raw, "ListEvents") };
}

/** Wait until a TCP port accepts connections (deterministic readiness probe). */
export async function waitForPort(
  host: string,
  port: number,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const net = await import("node:net");
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ host, port }, () => {
          s.end();
          resolve();
        });
        s.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`port ${host}:${port} not ready within ${timeoutMs}ms`);
}
