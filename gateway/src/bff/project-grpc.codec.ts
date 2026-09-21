/**
 * Encode/decode helpers for control `ProjectGrpc` Struct-typed fields
 * (`personal_settings`, `integration_settings`, `module_policies[].condition`).
 * Wire proof: control/src/grpc/module-policies-struct.spec.ts.
 */
import { jsonToStruct, structToJson } from './grpc-struct';

export type GrpcModuleConfigRow = {
  module_id?: string;
  moduleId?: string;
  enabled?: boolean;
  installed?: boolean;
  version?: string;
  personal_settings?: unknown;
  personalSettings?: unknown;
  integration_settings?: unknown;
  integrationSettings?: unknown;
  integration_methods_enabled?: string[];
  integrationMethodsEnabled?: string[];
};

export type GrpcModulePolicyRow = {
  id?: string;
  module_id?: string;
  moduleId?: string;
  effect?: string;
  subject?: string;
  action?: string;
  resource?: string;
  condition?: unknown;
};

function decodeStructField(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return structToJson(value) as Record<string, unknown>;
}

export function decodeGrpcModuleConfigs(configs: unknown): GrpcModuleConfigRow[] {
  if (!Array.isArray(configs)) return [];
  return configs.map((cfg) => {
    if (!cfg || typeof cfg !== 'object') return cfg as GrpcModuleConfigRow;
    const c = cfg as GrpcModuleConfigRow;
    return {
      ...c,
      personal_settings: decodeStructField(c.personal_settings ?? c.personalSettings),
      integration_settings: decodeStructField(c.integration_settings ?? c.integrationSettings),
    };
  });
}

export function decodeGrpcModulePolicies(policies: unknown): GrpcModulePolicyRow[] {
  if (!Array.isArray(policies)) return [];
  return policies.map((rule) => {
    if (!rule || typeof rule !== 'object') return rule as GrpcModulePolicyRow;
    const r = rule as GrpcModulePolicyRow;
    return {
      ...r,
      condition: decodeStructField(r.condition),
    };
  });
}

/** Decode Struct-typed project fields after a control `ProjectGrpc` read. */
export function decodeGrpcProject<T extends Record<string, unknown>>(project: T): T {
  if (!project || typeof project !== 'object') return project;
  const out = { ...project } as T & {
    module_configs?: unknown;
    moduleConfigs?: unknown;
    module_policies?: unknown;
    modulePolicies?: unknown;
  };
  if ('module_configs' in out) out.module_configs = decodeGrpcModuleConfigs(out.module_configs);
  if ('moduleConfigs' in out) out.moduleConfigs = decodeGrpcModuleConfigs(out.moduleConfigs);
  if ('module_policies' in out) out.module_policies = decodeGrpcModulePolicies(out.module_policies);
  if ('modulePolicies' in out) out.modulePolicies = decodeGrpcModulePolicies(out.modulePolicies);
  return out as T;
}

export function encodeGrpcModulePolicyCondition(
  condition: unknown,
): ReturnType<typeof jsonToStruct> {
  const plain =
    condition && typeof condition === 'object' && !Array.isArray(condition)
      ? (condition as Record<string, unknown>)
      : {};
  return jsonToStruct(plain);
}

export function encodeGrpcModulePolicies(
  policies: GrpcModulePolicyRow[],
): Array<Record<string, unknown>> {
  return policies
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({
      id: String(rule.id ?? ''),
      module_id: String(rule.module_id ?? rule.moduleId ?? ''),
      effect: String(rule.effect ?? 'allow'),
      subject: String(rule.subject ?? ''),
      action: String(rule.action ?? ''),
      resource: String(rule.resource ?? '*'),
      condition: encodeGrpcModulePolicyCondition(rule.condition),
    }))
    .filter((rule) => rule.id.length > 0 && rule.module_id.length > 0);
}
