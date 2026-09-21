// Generates the Fairflow Gateway Postman collection (REST + GraphQL).
// Run: node backend/postman/generate.mjs
// Source of truth for routes: gateway/src/**/*.controller.ts (global prefix /api, version v1).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------- helpers ----------
function buildUrl(path, query, pathVars, baseVar = 'baseUrl') {
  const clean = path.replace(/^\//, '');
  const segs = clean.split('/');
  const base = `{{${baseVar}}}`;
  const q = (query || []).map((x) => ({
    key: x.k,
    value: x.v,
    ...(x.disabled ? { disabled: true } : {}),
  }));
  const raw =
    base + '/' +
    clean +
    (q.length ? '?' + q.map((x) => `${x.key}=${x.value}`).join('&') : '');
  const u = { raw, host: [base], path: segs };
  if (q.length) u.query = q;
  if (pathVars && pathVars.length)
    u.variable = pathVars.map((k) => ({ key: k.replace(/^:/, ''), value: '' }));
  return u;
}

function req(e) {
  const header = [];
  if (e.body && !e.form) header.push({ key: 'Content-Type', value: 'application/json' });
  if (e.projectHeader)
    header.push({ key: 'x-project-id', value: '{{projectId}}', disabled: true,
      description: 'Альтернатива query ?projectId — раскомментируй если нужно' });
  const request = {
    method: e.method,
    header,
    url: buildUrl(e.path, e.query, e.pathVars, e.baseVar),
  };
  if (e.desc) request.description = e.desc;
  if (e.public) request.auth = { type: 'noauth' };
  if (e.body && !e.form)
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(e.body, null, 2),
      options: { raw: { language: 'json' } },
    };
  if (e.form)
    request.body = {
      mode: 'formdata',
      formdata: [{ key: 'file', type: 'file', src: [] }],
    };
  if (e.graphql)
    request.body = {
      mode: 'graphql',
      graphql: { query: e.graphql.query, variables: e.graphql.variables || '{}' },
    };
  const item = { name: e.name, request, response: [] };
  if (e.event) item.event = e.event;
  return item;
}

const loginEvent = [
  {
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec: [
        'const j = pm.response.json();',
        'if (j && j.token) {',
        "  pm.collectionVariables.set('token', j.token);",
        "  try { pm.environment.set('token', j.token); } catch (e) {}",
        "  if (j.user && j.user.userId) {",
        "    pm.collectionVariables.set('userId', j.user.userId);",
        "    try { pm.environment.set('userId', j.user.userId); } catch (e) {}",
        '  }',
        "  console.log('Fairflow: token saved to {{token}}');",
        '} else {',
        "  console.warn('Fairflow: no token in response');",
        '}',
      ],
    },
  },
];

const PID = { k: 'projectId', v: '{{projectId}}' };
const PG = (k, v = '') => ({ k, v, disabled: true });

// ---------- route data ----------
const folders = [
  {
    name: 'Auth',
    desc: 'Логин/регистрация и профиль. Login авто-сохраняет JWT в {{token}}.',
    items: [
      { name: 'Login', method: 'POST', path: '/api/v1/auth/login', public: true,
        body: { email: 'admin@example.com', password: 'changeme' }, event: loginEvent,
        desc: 'login ИЛИ email + password. Тест-скрипт кладёт token в переменную.' },
      { name: 'Register', method: 'POST', path: '/api/v1/auth/register', public: true,
        body: { userName: 'newuser', email: 'new@example.com', password: 'changeme' }, event: loginEvent },
      { name: 'Logout', method: 'POST', path: '/api/v1/auth/logout', public: true, body: {} },
      { name: 'Me (get)', method: 'GET', path: '/api/v1/auth/me' },
      { name: 'Me (update)', method: 'PATCH', path: '/api/v1/auth/me',
        body: { name: 'New Name', phone: '+70000000000', position: 'Manager', timezone: 'Europe/Moscow', language: 'ru' } },
      { name: 'Me — upload avatar', method: 'POST', path: '/api/v1/auth/me/avatar', form: true },
      { name: 'Forgot password', method: 'POST', path: '/api/forgot-password', public: true, body: { email: 'user@example.com' } },
      { name: 'Reset password', method: 'POST', path: '/api/reset-password', public: true, body: { password: 'newpass' } },
    ],
  },
  {
    name: 'Ops / Health',
    desc: 'health/metrics gateway. Обслуживаются самим gateway — зовём напрямую через {{opsBase}}.',
    items: [
      { name: 'healthz', method: 'GET', path: '/healthz', public: true, baseVar: 'opsBase' },
      { name: 'readyz', method: 'GET', path: '/readyz', public: true, baseVar: 'opsBase' },
      { name: 'status', method: 'GET', path: '/status', public: true, baseVar: 'opsBase' },
      { name: 'metrics', method: 'GET', path: '/metrics', public: true, baseVar: 'opsBase' },
    ],
  },
  {
    name: 'Organizations & Projects',
    desc: 'Управление организациями, проектами и модулями.',
    items: [
      { name: 'Create organization', method: 'POST', path: '/api/v1/organizations', body: { name: 'My Org', slug: 'my-org' } },
      { name: 'List organizations', method: 'GET', path: '/api/v1/organizations', query: [PG('userId')] },
      { name: 'List projects', method: 'GET', path: '/api/v1/projects', query: [PG('userId'), PG('ownerType'), PG('ownerId')] },
      { name: 'Create project', method: 'POST', path: '/api/v1/projects',
        body: { ownerType: 'user', name: 'My Project', modules: ['deals', 'contacts', 'companies'] } },
      { name: 'Get project', method: 'GET', path: '/api/v1/projects/:projectId', pathVars: [':projectId'] },
      { name: 'Update project', method: 'PATCH', path: '/api/v1/projects/:projectId', pathVars: [':projectId'],
        body: { name: 'Renamed', modules: ['deals', 'orders'] } },
      { name: 'Project members', method: 'GET', path: '/api/v1/projects/:projectId/members', pathVars: [':projectId'] },
      { name: 'Modules registry', method: 'GET', path: '/api/v1/modules/registry' },
    ],
  },
  {
    name: 'Contacts',
    items: [
      { name: 'List contacts', method: 'GET', path: '/api/v1/contacts', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('query')] },
      { name: 'Get contact', method: 'GET', path: '/api/v1/contacts/:id', pathVars: [':id'], query: [PID] },
      { name: 'Create contact', method: 'POST', path: '/api/v1/contacts',
        body: { projectId: '{{projectId}}', firstName: 'Ivan', lastName: 'Petrov', phone: '+70000000000', email: 'ivan@example.com' } },
      { name: 'Update contact', method: 'PUT', path: '/api/v1/contacts/:id', pathVars: [':id'], query: [PID],
        body: { firstName: 'Ivan', lastName: 'Sidorov' } },
      { name: 'Delete contact', method: 'DELETE', path: '/api/v1/contacts/:id', pathVars: [':id'], query: [PID] },
      { name: 'Import contacts', method: 'POST', path: '/api/v1/contacts/import', query: [PID], form: true },
    ],
  },
  {
    name: 'Companies',
    items: [
      { name: 'List companies', method: 'GET', path: '/api/v1/companies', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('query')] },
      { name: 'Get company', method: 'GET', path: '/api/v1/companies/:id', pathVars: [':id'], query: [PID] },
      { name: 'Create company', method: 'POST', path: '/api/v1/companies',
        body: { projectId: '{{projectId}}', name: 'ООО Ромашка', inn: '7700000000', phone: '+74950000000', industry: 'IT' } },
      { name: 'Update company', method: 'PUT', path: '/api/v1/companies/:id', pathVars: [':id'], query: [PID], body: { name: 'ООО Ромашка 2' } },
      { name: 'Delete company', method: 'DELETE', path: '/api/v1/companies/:id', pathVars: [':id'], query: [PID] },
      { name: 'Import companies', method: 'POST', path: '/api/v1/companies/import', query: [PID], form: true },
    ],
  },
  {
    name: 'Deals',
    desc: 'Сделки, воронки, дашборд (модуль deals).',
    items: [
      { name: 'CRM dashboard', method: 'GET', path: '/api/v1/dashboard', query: [PID] },
      { name: 'List deals', method: 'GET', path: '/api/v1/deals', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('query'), PG('pipelineId'), PG('stageId')] },
      { name: 'Deals kanban', method: 'GET', path: '/api/v1/deals/kanban', query: [PID, PG('pipelineId')] },
      { name: 'Get deal', method: 'GET', path: '/api/v1/deals/:id', pathVars: [':id'], query: [PID] },
      { name: 'Create deal', method: 'POST', path: '/api/v1/deals',
        body: { projectId: '{{projectId}}', name: 'New Deal', amount: 100000, currency: 'RUB', pipelineId: '', stageId: '' } },
      { name: 'Update deal', method: 'PUT', path: '/api/v1/deals/:id', pathVars: [':id'], query: [PID], body: { name: 'Updated Deal', amount: 150000 } },
      { name: 'Delete deal', method: 'DELETE', path: '/api/v1/deals/:id', pathVars: [':id'], query: [PID] },
      { name: 'Move deal to stage', method: 'PUT', path: '/api/v1/deals/:dealId/stage', pathVars: [':dealId'], query: [PID], body: { stageId: '' } },
      { name: 'List pipelines', method: 'GET', path: '/api/v1/pipelines', query: [PID] },
      { name: 'List deal sources', method: 'GET', path: '/api/v1/deal-sources', query: [PID] },
      { name: 'List members', method: 'GET', path: '/api/v1/members', query: [PID] },
    ],
  },
  {
    name: 'Orders',
    desc: 'Заказы и типы заказов (модуль orders).',
    items: [
      { name: 'List orders', method: 'GET', path: '/api/v1/orders', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('query'), PG('dealId')] },
      { name: 'Orders kanban', method: 'GET', path: '/api/v1/orders/kanban', query: [PID] },
      { name: 'Get order', method: 'GET', path: '/api/v1/orders/:id', pathVars: [':id'], query: [PID] },
      { name: 'List order types', method: 'GET', path: '/api/v1/order-types', query: [PID] },
      { name: 'Create order', method: 'POST', path: '/api/v1/orders',
        body: { projectId: '{{projectId}}', dealId: '', orderTypeId: '', fields: {} } },
      { name: 'Update order', method: 'PUT', path: '/api/v1/orders/:id', pathVars: [':id'], query: [PID], body: { fields: {}, assigneeId: '' } },
      { name: 'Move order to stage', method: 'PUT', path: '/api/v1/orders/:orderId/stage', pathVars: [':orderId'], query: [PID], body: { stageId: '' } },
    ],
  },
  {
    name: 'Activities',
    desc: 'Активности/задачи (модуль activities).',
    items: [
      { name: 'List activities', method: 'GET', path: '/api/v1/activities', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('query'), PG('overdueOnly'), PG('assigneeId')] },
      { name: 'Activities calendar', method: 'GET', path: '/api/v1/activities/calendar', query: [PID] },
      { name: 'Get activity', method: 'GET', path: '/api/v1/activities/:id', pathVars: [':id'], query: [PID] },
      { name: 'Create activity', method: 'POST', path: '/api/v1/activities',
        body: { projectId: '{{projectId}}', type: 'call', title: 'Позвонить клиенту', priority: 'normal', dueDate: null } },
      { name: 'Update activity', method: 'PUT', path: '/api/v1/activities/:id', pathVars: [':id'], query: [PID], body: { title: 'Updated', status: 'done' } },
    ],
  },
  {
    name: 'Products',
    items: [
      { name: 'List products', method: 'GET', path: '/api/v1/products', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('query')] },
      { name: 'Get product', method: 'GET', path: '/api/v1/products/:id', pathVars: [':id'], query: [PID] },
    ],
  },
  {
    name: 'Documents',
    desc: 'Шаблоны и сгенерированные документы (модуль documents).',
    items: [
      { name: 'List templates', method: 'GET', path: '/api/v1/document-templates', query: [PID] },
      { name: 'Get template', method: 'GET', path: '/api/v1/document-templates/:id', pathVars: [':id'], query: [PID] },
      { name: 'Create template', method: 'POST', path: '/api/v1/document-templates',
        body: { projectId: '{{projectId}}', name: 'Договор', content: '<html>...</html>', mimeType: 'text/html' } },
      { name: 'Update template', method: 'PUT', path: '/api/v1/document-templates/:id', pathVars: [':id'], query: [PID], body: { name: 'Договор v2' } },
      { name: 'Delete template', method: 'DELETE', path: '/api/v1/document-templates/:id', pathVars: [':id'], query: [PID] },
      { name: 'List documents', method: 'GET', path: '/api/v1/documents', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25')] },
      { name: 'Get document', method: 'GET', path: '/api/v1/documents/:id', pathVars: [':id'], query: [PID] },
      { name: 'Generate document', method: 'POST', path: '/api/v1/documents/generate',
        body: { projectId: '{{projectId}}', templateId: '', name: 'Договор №1', payload: {} } },
    ],
  },
  {
    name: 'Reports',
    items: [
      { name: 'List reports', method: 'GET', path: '/api/v1/reports', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('query')] },
      { name: 'Get report', method: 'GET', path: '/api/v1/reports/:id', pathVars: [':id'], query: [PID] },
      { name: 'Create report', method: 'POST', path: '/api/v1/reports', body: { projectId: '{{projectId}}', name: 'Sales', kind: 'table' } },
      { name: 'Run report', method: 'POST', path: '/api/v1/reports/:id/run', pathVars: [':id'], query: [PID], body: { params: {} } },
      { name: 'Export report', method: 'POST', path: '/api/v1/reports/:id/export', pathVars: [':id'], query: [PID], body: { format: 'csv', params: {} } },
    ],
  },
  {
    name: 'Automation',
    items: [
      { name: 'List rules', method: 'GET', path: '/api/v1/automation/rules', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('query'), PG('enabledOnly')] },
      { name: 'Get rule', method: 'GET', path: '/api/v1/automation/rules/:id', pathVars: [':id'], query: [PID] },
      { name: 'Create rule', method: 'POST', path: '/api/v1/automation/rules',
        body: { projectId: '{{projectId}}', name: 'Auto-assign', enabled: true, triggerType: 'deal.created', actions: {} } },
      { name: 'Update rule', method: 'PUT', path: '/api/v1/automation/rules/:id', pathVars: [':id'], query: [PID], body: { enabled: false } },
      { name: 'Delete rule', method: 'DELETE', path: '/api/v1/automation/rules/:id', pathVars: [':id'], query: [PID] },
      { name: 'Execute rule', method: 'POST', path: '/api/v1/automation/rules/:id/execute', pathVars: [':id'], query: [PID], body: { source: 'manual', payload: {} } },
    ],
  },
  {
    name: 'Notifications',
    items: [
      { name: 'Unread count', method: 'GET', path: '/api/notification/count', query: [PID, PG('unreadOnly', 'true')] },
      { name: 'List', method: 'GET', path: '/api/notification/list', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('unreadOnly')] },
      { name: 'Mark read', method: 'PUT', path: '/api/notification/:id/read', pathVars: [':id'], query: [PID] },
      { name: 'Send', method: 'POST', path: '/api/notification/send',
        body: { projectId: '{{projectId}}', userId: '{{userId}}', channel: 'in-app', title: 'Hi', body: 'Test' } },
    ],
  },
  {
    name: 'Search',
    items: [
      { name: 'Query', method: 'GET', path: '/api/search/query', query: [{ k: 'query', v: 'test' }, PID, PG('pageIndex', '0'), PG('pageSize', '25')] },
      { name: 'Reindex', method: 'POST', path: '/api/search/reindex', query: [PID], body: {} },
    ],
  },
  {
    name: 'Audit',
    items: [
      { name: 'List events', method: 'GET', path: '/api/audit/events', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25'), PG('entityType'), PG('entityId')] },
      { name: 'Get event', method: 'GET', path: '/api/audit/events/:id', pathVars: [':id'], query: [PID] },
      // Записи через REST нет: AppendEvent — internal (service-key), путь записи — шина.
    ],
  },
  {
    name: 'Billing',
    items: [
      { name: 'List plans', method: 'GET', path: '/api/billing/plans', query: [PG('includeInactive')] },
      { name: 'Get plan', method: 'GET', path: '/api/billing/plan', query: [PG('planId'), PG('planCode')] },
      { name: 'Subscribe', method: 'POST', path: '/api/billing/subscribe', body: { projectId: '{{projectId}}', planId: '' } },
      { name: 'Payments', method: 'GET', path: '/api/billing/payments', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25')] },
      { name: 'Invoices', method: 'GET', path: '/api/billing/invoices', query: [PID, PG('pageIndex', '0'), PG('pageSize', '25')] },
      { name: 'Quota', method: 'GET', path: '/api/billing/quota', query: [PID, { k: 'action', v: 'create_deal' }] },
    ],
  },
  {
    name: 'Users',
    items: [
      { name: 'List users', method: 'GET', path: '/api/v1/users', query: [PG('skip', '0'), PG('take', '25'), PG('login'), PG('isActive')] },
    ],
  },
  {
    name: 'GraphQL',
    desc: 'GraphQL endpoint /graphql (Mercurius). GraphiQL UI: {{baseUrl}}/graphiql',
    items: [
      { name: 'hello', method: 'POST', path: '/graphql', public: true, graphql: { query: '{ hello }' } },
      { name: 'users', method: 'POST', path: '/graphql',
        graphql: { query: 'query Users($take: Int) {\n  users(take: $take) {\n    total\n    list { id login email name isActive createdAt }\n  }\n}', variables: '{ "take": 25 }' } },
      { name: 'crmDashboardJson', method: 'POST', path: '/graphql', public: true,
        graphql: { query: 'query($projectId: String!) {\n  crmDashboardJson(projectId: $projectId)\n}', variables: '{ "projectId": "{{projectId}}" }' } },
      { name: 'crmPipelinesJson', method: 'POST', path: '/graphql', public: true,
        graphql: { query: 'query($projectId: String!) {\n  crmPipelinesJson(projectId: $projectId)\n}', variables: '{ "projectId": "{{projectId}}" }' } },
      { name: 'crmDealsListJson', method: 'POST', path: '/graphql', public: true,
        graphql: { query: 'query($projectId: String!, $pipelineId: String) {\n  crmDealsListJson(projectId: $projectId, pipelineId: $pipelineId)\n}', variables: '{ "projectId": "{{projectId}}" }' } },
    ],
  },
];

// ---------- assemble collection ----------
const collection = {
  info: {
    _postman_id: randomUUID(),
    name: 'Fairflow — Gateway',
    description:
      'REST (/api) + GraphQL (/graphql) публичного gateway. Авторизация — Bearer {{token}} (Login авто-сохраняет). ' +
      'gRPC-домены не входят в эту коллекцию (Postman не импортирует gRPC из JSON) — см. README.md рядом.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  event: [],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000', type: 'string' },
    { key: 'opsBase', value: 'http://localhost:3000', type: 'string' },
    { key: 'token', value: '', type: 'string' },
    { key: 'projectId', value: '', type: 'string' },
    { key: 'userId', value: '', type: 'string' },
  ],
  item: folders.map((f) => ({
    name: f.name,
    ...(f.desc ? { description: f.desc } : {}),
    item: f.items.map(req),
  })),
};

const total = folders.reduce((n, f) => n + f.items.length, 0);
writeFileSync(join(OUT_DIR, 'fairflow-gateway.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
console.log(`Wrote fairflow-gateway.postman_collection.json — ${folders.length} folders, ${total} requests`);

// ---------- environment (HTTP vars + gRPC endpoints + service metadata) ----------
// gRPC services: name -> { port, proto, package, services[] }. Used by README too.
const GRPC = [
  ['auth', 5001, 'auth', 'fairflow.auth.v1', ['AuthGrpc', 'ApiKeyGrpc']],
  ['control', 5002, 'control', 'fairflow.control.v1', ['ProjectGrpc', 'OrganizationGrpc']],
  ['contact', 5003, 'contact', 'fairflow.contact.v1', ['ContactGrpc']],
  ['company', 5004, 'company', 'fairflow.company.v1', ['CompanyGrpc']],
  ['pipe', 5005, 'pipe', 'fairflow.pipe.v1', ['PipeGrpc']],
  ['orders', 5006, 'orders', 'fairflow.orders.v1', ['OrdersGrpc']],
  ['product', 5007, 'product', 'fairflow.product.v1', ['ProductGrpc']],
  ['activity', 5008, 'activity', 'fairflow.activity.v1', ['ActivityGrpc']],
  ['documents', 5010, 'documents', 'fairflow.documents.v1', ['DocumentsGrpc']],
  ['reports', 5011, 'reports', 'fairflow.reports.v1', ['ReportsGrpc']],
  ['automation', 5012, 'automation', 'fairflow.automation.v1', ['AutomationGrpc']],
  ['search', 5013, 'search', 'fairflow.search.v1', ['SearchGrpc']],
  ['audit', 5014, 'audit', 'fairflow.audit.v1', ['AuditGrpc']],
  ['notification', 5015, 'notification', 'fairflow.notification.v1', ['NotificationGrpc']],
  ['billing', 5016, 'billing', 'fairflow.billing.v1', ['BillingGrpc']],
];

const v = (key, value, type = 'default') => ({ key, value, type, enabled: true });
const env = {
  id: randomUUID(),
  name: 'Fairflow — local',
  values: [
    v('baseUrl', 'http://localhost:3000'),
    v('opsBase', 'http://localhost:3000'), // gateway NodePort (health/metrics не идут через ingress)
    v('token', '', 'secret'),
    v('projectId', ''),
    v('userId', ''),
    // --- gRPC metadata (нужно для вызова доменов напрямую) ---
    v('svc_api_key', '', 'secret'), // = GATEWAY_SERVICE_API_KEY (ak_...) из окружения gateway — НЕ коммитить
    v('gw_api_key_id', ''),         // x-gateway-api-key-id стенда
    v('request_id', '{{$guid}}'),   // x-request-id
    // --- gRPC endpoints: по умолчанию port-forward на localhost; для кластера подставь доступный адрес ---
    ...GRPC.map(([name, port]) => v(`grpc_${name}`, `127.0.0.1:${port}`)),
  ],
  _postman_variable_scope: 'environment',
};
writeFileSync(join(OUT_DIR, 'fairflow.postman_environment.json'), JSON.stringify(env, null, 2) + '\n');
console.log(`Wrote fairflow.postman_environment.json — ${env.values.length} variables (${GRPC.length} gRPC hosts)`);
