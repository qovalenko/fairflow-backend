import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { createHash } from 'node:crypto';
import { GatewayOutboundMetadataService } from '../../bff/gateway-outbound-metadata.service';

/**
 * The synthetic principal a valid inbound `ffk_…` key resolves to. Read-only,
 * project-scoped: the key of project A physically cannot reach project B — the
 * `projectId` comes from the key (control lookup), never from the URL/body.
 */
export interface ProjectApiKeyPrincipal {
  kind: 'api-key';
  projectId: string;
  keyId: string;
  name: string;
  /** Fixed read-only scope — no manage/admin action is ever possible with a key. */
  scopes: readonly ['records:read'];
}

/** Request enriched by this guard once the key is validated. */
export type ApiKeyRequest = {
  headers: Record<string, unknown>;
  apiKeyPrincipal?: ProjectApiKeyPrincipal;
};

/** Wire shape of control's ValidateProjectApiKey response (keepCase-tolerant). */
type ValidateResult = {
  valid?: boolean;
  project_id?: string;
  projectId?: string;
  key_id?: string;
  keyId?: string;
  name?: string;
  status?: string;
};

type IntegrationClient = {
  validateProjectApiKey: (x: { key_hash: string }, m?: unknown) => Observable<ValidateResult>;
};

/** sha-256(hex) — byte-for-byte the same as control `hashKey` so the lookup matches. */
function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Extract the presented `ffk_…` from `Authorization: Bearer …` or `X-Api-Key: …`. */
function readPresentedKey(headers: Record<string, unknown>): string {
  const auth = headers['authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (typeof authStr === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(authStr.trim());
    if (m) return m[1].trim();
  }
  const x = headers['x-api-key'];
  const xStr = Array.isArray(x) ? x[0] : x;
  if (typeof xStr === 'string') return xStr.trim();
  return '';
}

/**
 * PEP for the public project API (`/api/v1/public/*`). Reads the inbound key,
 * hashes it, and asks control's `IntegrationGrpc.ValidateProjectApiKey` (the PDP,
 * BX-INTEG-1) to resolve it to its owning project. On success it attaches a
 * read-only, project-scoped `apiKeyPrincipal` to the request.
 *
 * Fail-closed (§3): a missing / malformed (non-`ffk_`) / unknown / revoked key —
 * or an unavailable control — yields a plain `401`, with NO reason leaked.
 */
@Injectable()
export class ProjectApiKeyGuard implements CanActivate {
  private client?: IntegrationClient;

  constructor(
    @Inject('CONTROL_GRPC') private readonly control: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  private getClient(): IntegrationClient {
    if (!this.client) {
      this.client = this.control.getService<IntegrationClient>('IntegrationGrpc');
    }
    return this.client;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyRequest>();
    const presented = readPresentedKey(request.headers ?? {});
    // Cheap fail-closed: never hash/round-trip a value that isn't even a key.
    if (!presented || !presented.startsWith('ffk_')) {
      throw new UnauthorizedException();
    }

    let res: ValidateResult;
    try {
      // Service-actor envelope (no end user) so control's inbound key guard accepts
      // the call; the key hash — never the plaintext — is what we send.
      const md = this.outboundMeta.build(request as never);
      res = await firstValueFrom(
        this.getClient().validateProjectApiKey({ key_hash: hashKey(presented) }, md),
      );
    } catch {
      // Control unavailable / errored → fail closed, no reason leaked.
      throw new UnauthorizedException();
    }

    const projectId = (res?.project_id ?? res?.projectId ?? '').trim();
    if (!res?.valid || !projectId) {
      throw new UnauthorizedException();
    }

    request.apiKeyPrincipal = {
      kind: 'api-key',
      projectId,
      keyId: (res.key_id ?? res.keyId ?? '').trim(),
      name: res.name ?? '',
      scopes: ['records:read'],
    };
    return true;
  }
}
