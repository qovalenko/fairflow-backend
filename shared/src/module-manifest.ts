/**
 * Module Manifest contract (`ModuleManifestV1`).
 *
 * Source of truth: docs/tz/areas/module-contract/TZ.md §5.1 + RFC-2-manifest.md.
 *
 * The manifest is the single declarative description of a module: from one
 * artifact the platform derives navigation, gateway gRPC clients, the permission
 * catalog, the auto settings form, mount-points, events, billing and the
 * inheritance of ownership/visibility.
 *
 * This module is ADDITIVE to `module-registry.ts` (the legacy `ModuleDefinition`
 * registry stays untouched). A best-effort mapping `moduleDefinitionToManifest`
 * is provided so the current registry can be projected onto the new contract.
 */

import type { JsonValue, JsonPrimitive, ModuleDefinition } from './module-registry';
import { shorthandToJsonSchema } from './settings-schema';
import {
  validateManifestMountPoints,
  type MountPointValidationIssue,
} from './slot-catalog';
// PermissionAction is the canonical RBAC action vocabulary (rbac.ts), reused
// here per FR-MOD-18 / B2: `write` = create+update; module verbs are a closed set.
import type { PermissionAction } from './rbac';

/** Version of the manifest format itself (FR-MOD-1 / FR-MOD-7). */
export const MANIFEST_CONTRACT_VERSION = '1.0';

/**
 * Major Platform API versions the core currently supports (FR-MOD-8).
 * `platformApi` semver-range of a manifest must intersect one of these.
 */
export const SUPPORTED_PLATFORM_API = ['1'] as const;

/**
 * Registered platform-owned emit prefix aliases (FR-MOD-24 / RFC-2 §1.6).
 * `emits[]` are validated against `namespace(id) ∪ PLATFORM_EMIT_ALIASES`.
 * The full routing-key registry lives in RFC-4; here only the mechanism + the
 * `crm` alias for the 1st-party CRM cluster is fixed.
 */
export const PLATFORM_EMIT_ALIASES = ['crm'] as const;

/**
 * Reserved platform event namespace for partner lifecycle/runtime events
 * (`partner.*`, registered in routing-keys.ts / RFC-4 §3.5). A partner module's
 * own emits are confined to ITS OWN namespace (`<vendor>.<module>.*`) — it is NOT
 * allowed to emit into `partner.*` (that is the platform's namespace for partner
 * lifecycle: install/consent/token/quota). See `validatePartnerManifest`.
 */
export const PARTNER_EVENT_NAMESPACE = 'partner' as const;

/**
 * Human-friendly action synonyms collapsed to the canonical vocabulary at
 * validation time (FR-MOD-18): `create`/`update` → `write`.
 */
export const ACTION_SYNONYMS: Readonly<Record<string, PermissionAction>> = {
  create: 'write',
  update: 'write',
};

export type ModuleKind = 'system' | 'business' | 'partner';
export type VendorType = 'first_party' | 'partner';

// Note: `PermissionAction` is exported from `rbac.ts` (single source); consumers
// import it from `@fairflow/shared` directly. Not re-exported here to avoid a
// duplicate `export *` symbol collision in the package barrel.

/**
 * Supply-chain / bundle integrity fields for `kind:"partner"` modules
 * (PART TZ §5 «Резервирование манифест-полей `signature`/`bundleHash`/
 * `egressDomains`», M-PART-3). RESERVED & VALIDATED in v1: the host never loads a
 * remote by arbitrary URL — the URL/hash/signature come from the signed registry
 * record `ModuleVersion{bundleUrl,bundleHash,signature}` (FR-PART-20). v1 only
 * fixes the *form* + the validation surface; auto-verification of the vendor
 * signature and the supply-chain pipeline are deferred to stage 5
 * (broker/sandbox/marketplace, v1-decisions). 1st-party vendors MUST NOT declare
 * these (the validator rejects them).
 */
export interface ManifestVendorBundle {
  /** Registry-owned bundle URL (host never loads arbitrary URLs, FR-PART-20). */
  url?: string;
  /** SRI hash of the bundle — `sha384-<...>` (СР-5, FR-PART-20). */
  hash?: string;
}

export interface ManifestVendor {
  name: string;
  type: VendorType;
  /**
   * Partner bundle record (`kind:"partner"` only). RESERVED & VALIDATED in v1
   * (M-PART-3); 1st-party manifests MUST omit it.
   */
  bundle?: ManifestVendorBundle;
  /**
   * Detached signature over `{moduleId,version,bundle.url,bundle.hash}` (FR-PART-2).
   * RESERVED in v1: form fixed, auto-verification deferred to stage 5.
   */
  signature?: string;
  /**
   * Egress allow-list for the sandbox CSP `connect-src` (FR-PART-7). Empty/absent
   * → `connect-src 'none'` (only the broker channel). RESERVED & VALIDATED in v1;
   * CSP enforcement is a stage-5 (sandbox) concern. Each entry MUST be an origin
   * (`https://host[:port]`), no paths/wildcards (validated). 1st-party MUST omit.
   */
  egress?: string[];
}

/**
 * Declarative ABAC condition (FR-MOD-19). A serializable JSON tree of operators
 * over operand references (`record.*` / `user.*` / `project.*`) and literals.
 * Not executable code. The final operator syntax is fixed by RFC-5 (OQ-MOD-S4);
 * the shape here is the agreed v1 form (mixed dead `AbacOperand` removed, M2).
 */
export type AbacCondition =
  | { and: AbacCondition[] }
  | { or: AbacCondition[] }
  | { not: AbacCondition }
  | { eq: [string, JsonPrimitive] }
  | { ne: [string, JsonPrimitive] }
  | { gt: [string, number] }
  | { lt: [string, number] }
  | { gte: [string, number] }
  | { lte: [string, number] }
  | { in: [string, JsonPrimitive[]] }
  | { nin: [string, JsonPrimitive[]] };

export interface ManifestPermission {
  /** Must live in the namespace of `id`. */
  subject: string;
  actions: PermissionAction[];
  /** Form declared here; final ABAC syntax — RFC-5 (OQ-MOD-S4). */
  defaultConditions?: AbacCondition;
}

export interface ManifestDataSubject {
  /** Canonical form (RFC-2): {resource, ownable, shareable, ownerField?, departmentField?}. */
  resource: string; // in namespace id
  ownable: boolean;
  shareable: boolean;
  /** Required if `ownable && !departmentField` (FR-MOD-22). */
  ownerField?: string;
  departmentField?: string;
  /** RFC-5 §1.3 ABAC compilation target; default derived from storage. */
  abacBackend?: 'mongo' | 'postgres' | 'mongo-only';
  /** Declared record fields allowed in ABAC predicates (FR-DEALS-380 / RFC-ABAC §5). */
  abacFields?: string[];
  /**
   * PART FR-PART-12b: aggregates / reference data without record owners that a
   * class-A partner token may read «from the installation» (no user, so no
   * user-visibility applies). Visibility-sensitive owned records (`ownable`)
   * MUST NOT be `serviceLevel` — the validator rejects that combination.
   */
  serviceLevel?: boolean;
}

export interface ManifestEvents {
  /** Routing-keys emitted; validated against namespace(id) ∪ PLATFORM_EMIT_ALIASES. */
  emits?: string[];
  /** Cross-module subscriptions; may reference other modules' emits. */
  listens?: string[];
}

/**
 * Gateway gRPC client registration metadata (FR-MOD-23 / RFC-2 §4.12).
 *
 * Carries everything the gateway needs to register a `ClientsModule` entry for
 * the module's domain WITHOUT a manual edit to `grpc-bff.module.ts`: the DI
 * token, the proto package, the `.proto` path (relative to the gateway proto
 * root, POSIX segments) and the ConfigService key that resolves the gRPC URL.
 * Derived once from the manifest by `listGatewayGrpcClients()`.
 */
export interface ManifestGrpcClient {
  /** Nest DI token, e.g. `PIPE_GRPC` (injected via `@Inject('PIPE_GRPC')`). */
  token: string;
  /** Proto package, e.g. `fairflow.pipe.v1`. */
  package: string;
  /** `.proto` path segments under the gateway proto root, e.g. `['pipe','v1','pipe.proto']`. */
  protoPath: string[];
  /** ConfigService key resolving the gRPC URL, e.g. `app.grpc.pipeUrl`. */
  urlConfigKey: string;
  /** Default URL when the config key is unset (dev fallback, matches AS-IS getters). */
  defaultUrl: string;
}

/** Whole block forbidden for `kind:"partner"` (FR-MOD-15a). */
export interface ManifestBackend {
  /** gRPC service name (gateway client generation, FR-MOD-23). */
  grpcService?: string;
  /**
   * Gateway gRPC client registration descriptor (FR-MOD-23). When present, the
   * gateway generates the `ClientsModule` entry from this — no core edit needed.
   */
  grpcClient?: ManifestGrpcClient;
  healthContract?: 'ops-http-contract';
  migrations?: 'prisma' | 'mongo' | null;
  events?: ManifestEvents;
}

export interface ManifestNavigation {
  path: string;
  icon?: string;
  label: string;
  /** Permission gate (existing permission subject:action). */
  requires?: string;
}

/**
 * RFC-3 §1.5 / RFC-2 §1.6: `slot` must belong to the host `SLOT_CATALOG`
 * (typed `MountSlotId`, owned by the ui-shell area). Until that artifact exists
 * in shared it is typed as `string`; the validator enforces membership.
 * Arbitrary props are forbidden — slot context is passed via `requiresContext`
 * (⊆ keys of the slot's `contextSchema`).
 */
export interface ManifestMountPoint {
  slot: string; // ∈ SLOT_CATALOG (MountSlotId), else reject UNKNOWN_SLOT
  component: string;
  requires?: string;
  order?: number;
  requiresContext?: string[];
}

export interface ManifestFrontend {
  remoteName?: string;
  expose?: string;
  /** Dynamic registration (late phase, US-MOD-25). */
  remoteUrl?: string;
  navigation?: ManifestNavigation[];
  mountPoints?: ManifestMountPoint[];
  drawerEntities?: string[];
}

/** Forbidden for `kind:"system"` (FR-MOD-15). */
export interface ManifestBilling {
  model: 'per_seat' | 'flat' | 'usage';
  price: number | null;
  /** [0,1] */
  revenueShare?: number;
}

/** Locale-keyed title/body templates with `{{var}}` placeholders (NFR-MNOT-9). */
export type NotifyI18nTemplate = {
  title: Record<string, string>;
  body: Record<string, string>;
};

export type NotifyFanoutGroup = 'pa' | 'leader' | 'all';

/**
 * RFC-2 §1.7: thin bridge to notifications. Each `events[].eventType` must be in
 * `backend.events.emits`; `severity:"critical"` is forbidden for `kind:"partner"`.
 */
export interface ManifestNotifyEvent {
  eventType: string; // ∈ emits[]
  category: string; // deals|sales|data|org|...
  severity: 'info' | 'important' | 'critical';
  defaultChannels: Array<'in_app' | 'email'>;
  addressee?: 'owner' | 'department' | 'actor' | 'subscriber';
  /** @deprecated use `i18n` */
  template?: string;
  /** i18n title/body templates from the source module (NFR-080). */
  i18n?: NotifyI18nTemplate;
  /** High-frequency collapse window in seconds; 0/absent = disabled (FR-MNOT-19). */
  collapseWindowSec?: number;
  /** Project-wide fan-out groups beyond payload owner (FR-MNOT-4/31). */
  fanout?: NotifyFanoutGroup[];
}

export interface ManifestNotify {
  events: ManifestNotifyEvent[];
}

export interface ModuleManifestV1 {
  // ── required core (in sync with BR-MOD-11 / FR-MOD-3 / AJV — M6) ──
  contractVersion: string; // "1.0"
  id: string; // namespace root
  version: string; // semver
  kind: ModuleKind;
  vendor: ManifestVendor;
  platformApi: string; // semver-range
  displayName: string;

  // ── card (FR-MOD-1a) ──
  description?: string;
  helpUrl?: string;
  icon?: string;

  // ── flags (RFC-2) ──
  // Non-removability = alwaysEnabled || kind==='system'; `locked` is derived by
  // the registry and is NOT declared in the manifest. kind (grammar) ⊥
  // alwaysEnabled (non-removability).
  alwaysEnabled?: boolean;
  dependsOn?: string[]; // "contacts@^1" — hard: auto-enabled
  softDependsOn?: string[]; // soft: NOT auto-enabled; absence → degradation (FAILED_PRECONDITION)
  conflictsWith?: string[]; // executed by FR-MOD-12a

  // ── optional capability blocks ──
  permissions?: ManifestPermission[];
  dataSubjects?: ManifestDataSubject[];
  backend?: ManifestBackend;
  frontend?: ManifestFrontend;
  settingsSchema?: JsonValue; // JSON Schema 2020-12
  billing?: ManifestBilling;
  notify?: ManifestNotify; // RFC-2 §1.7
}

/**
 * Public catalog card for `GET /api/platform/modules` (FR-MOD-1a / FR-MOD-35).
 * Built from human-readable manifest fields; never exposes technical fields
 * (`platformApi`, `contractVersion`, `defaultConditions`). For non-owners
 * `billingSummary` is reduced to paid/free only (no `revenueShare`).
 */
export interface ModuleCard {
  id: string;
  displayName: string;
  description?: string;
  helpUrl?: string;
  icon?: string;
  kind: ModuleKind;
  vendor: ManifestVendor;
  version: string;
  billingSummary?: 'paid' | 'free';
  enabledInProject: boolean;
}

/**
 * Navigation-ready catalog card for `GET /api/v1/platform/modules` (E1-08).
 *
 * Superset of {@link ModuleCard} that additionally carries the host-shell
 * projection fields the manifest-driven navigation needs: `navigation`,
 * `mountPoints` and the flattened `requiredPermissions` (`subject:action`).
 * `enabled` mirrors `enabledInProject` for the per-project filter.
 *
 * Still never exposes technical fields (`platformApi`, `contractVersion`,
 * `defaultConditions`).
 */
export interface ModuleNavCard {
  id: string;
  displayName: string;
  description?: string;
  icon?: string;
  kind: ModuleKind;
  version: string;
  /** Manifest-declared host navigation entries (may be empty for legacy). */
  navigation: ManifestNavigation[];
  /** Manifest-declared host mount-points (may be empty for legacy). */
  mountPoints: ManifestMountPoint[];
  /** Entity types the module contributes to quick-create / global drawer (FR-MOD-28). */
  drawerEntities: string[];
  /** Flattened permission keys (`subject:action`) the module declares. */
  requiredPermissions: string[];
  /** Whether the module is effectively enabled for the current project. */
  enabled: boolean;
}

/**
 * FR-SHELL-210 (in-scope): slot-id / accessKind validation for manifest mount-points.
 * Partner namespace / trust-class checks live in `validatePartnerManifest` (out of scope).
 */
export function getManifestMountPointIssues(
  manifest: ModuleManifestV1,
): MountPointValidationIssue[] {
  return validateManifestMountPoints(manifest.frontend?.mountPoints, manifest.kind);
}

/**
 * Project a manifest onto a navigation-ready card (E1-08). Derives the host
 * navigation/mount-points from `frontend.*`; if the manifest declares no
 * navigation (legacy registry modules), a single default entry is synthesized
 * from `id`/`displayName`/`icon` so the host can still build a menu item.
 */
export function manifestToNavCard(
  manifest: ModuleManifestV1,
  enabled: boolean,
): ModuleNavCard {
  const declaredNav = manifest.frontend?.navigation ?? [];
  const navigation: ManifestNavigation[] =
    declaredNav.length > 0
      ? declaredNav
      : [{ path: `/${manifest.id}`, label: manifest.displayName, icon: manifest.icon }];
  const requiredPermissions: string[] = [];
  for (const perm of manifest.permissions ?? []) {
    for (const action of perm.actions) requiredPermissions.push(`${perm.subject}:${action}`);
  }
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    icon: manifest.icon,
    kind: manifest.kind,
    version: manifest.version,
    navigation,
    mountPoints: manifest.frontend?.mountPoints ?? [],
    drawerEntities: manifest.frontend?.drawerEntities ?? [],
    requiredPermissions,
    enabled,
  };
}

/**
 * Effects a manifest would produce (FR-MOD-37, Could). Returned by the
 * simulator `GET /api/platform/modules/:id/manifest/effects`.
 */
export interface ManifestEffects {
  navigation: ManifestNavigation[];
  permissions: ManifestPermission[];
  slots: string[];
  emits: string[];
  listens: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers (additive, no behavioural change to module-registry.ts)
// ───────────────────────────────────────────────────────────────────────────

/** Namespace prefix derived from a manifest `id` (used by emit/subject checks). */
export function manifestNamespace(id: string): string {
  return id;
}

/** Whether a string lies within the namespace of `id` (`id` or `id.<...>`). */
export function isWithinNamespace(value: string, id: string): boolean {
  return value === id || value.startsWith(`${id}.`);
}

/** Whether an emit routing-key is allowed for the given module id (FR-MOD-24). */
export function isAllowedEmit(emit: string, id: string): boolean {
  if (isWithinNamespace(emit, id)) return true;
  return PLATFORM_EMIT_ALIASES.some((alias) => emit === alias || emit.startsWith(`${alias}.`));
}

/** Collapse human-friendly action synonyms to the canonical vocabulary. */
export function normalizeAction(action: string): string {
  return ACTION_SYNONYMS[action] ?? action;
}

/**
 * Best-effort projection of a legacy `ModuleDefinition` onto `ModuleManifestV1`.
 *
 * Additive bridge: lets the current `MODULE_REGISTRY` be read through the new
 * contract without rewriting it. Fields the legacy model does not carry
 * (`platformApi`, `version`, real `dataSubjects`, events, billing) get sane
 * 1st-party defaults; settings schemas are passed through verbatim.
 */
export function moduleDefinitionToManifest(def: ModuleDefinition): ModuleManifestV1 {
  const actionsBySubject = new Map<string, PermissionAction[]>();
  for (const cap of def.policyCapabilities) {
    actionsBySubject.set(
      cap.subject,
      cap.actions.map((a) => normalizeAction(a) as PermissionAction),
    );
  }
  const permissions: ManifestPermission[] = Array.from(actionsBySubject.entries()).map(
    ([subject, actions]) => ({ subject, actions }),
  );

  // Emit real JSON Schema 2020-12 documents (contract: settingsSchema is 2020-12)
  // rather than passing the registry shorthand through verbatim (U4-BE / P2.d).
  const settingsSchema: Record<string, JsonValue> = {
    personal: shorthandToJsonSchema(def.personalSettingsSchema) as unknown as JsonValue,
    integration: shorthandToJsonSchema(def.integrationSettingsSchema) as unknown as JsonValue,
  };

  return {
    contractVersion: MANIFEST_CONTRACT_VERSION,
    id: def.id,
    version: '1.0.0',
    kind: 'business',
    vendor: { name: 'Fairflow', type: 'first_party' },
    platformApi: '^1',
    displayName: def.name,
    description: def.description,
    alwaysEnabled: def.locked || undefined,
    dependsOn: def.dependencies.length > 0 ? def.dependencies.slice() : undefined,
    // Мягкие рёбра реестра проецируются в `softDependsOn` (НЕ в `dependsOn`):
    // они не участвуют ни в авто-включении (`resolveDependencies`), ни в
    // каскадном выключении (`normalizeModuleConfigs`).
    softDependsOn:
      def.softDependencies && def.softDependencies.length > 0
        ? def.softDependencies.slice()
        : undefined,
    permissions: permissions.length > 0 ? permissions : undefined,
    settingsSchema,
  };
}

/** Project a manifest onto a public catalog card (FR-MOD-1a / FR-MOD-35). */
export function manifestToCard(
  manifest: ModuleManifestV1,
  enabledInProject: boolean,
  options?: { includeBilling?: boolean },
): ModuleCard {
  const card: ModuleCard = {
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    helpUrl: manifest.helpUrl,
    icon: manifest.icon,
    kind: manifest.kind,
    vendor: manifest.vendor,
    version: manifest.version,
    enabledInProject,
  };
  if (options?.includeBilling !== false && manifest.kind !== 'system') {
    card.billingSummary = manifest.billing && manifest.billing.price ? 'paid' : 'free';
  }
  return card;
}
