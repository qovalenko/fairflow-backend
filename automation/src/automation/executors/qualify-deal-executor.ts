import { Injectable, Logger } from '@nestjs/common';
import type { ActionExecutor, ExecutorContext, ExecutorOutcome } from './executor.types';
import { DomainGrpcClient } from './grpc-action-executor';
import { classifyGrpcFailure } from './executor-errors';
import { ENTITY_DOMAINS } from './entity-domains';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * FR-DEALS-020: auto-qualify a light deal into a contact when an automation rule
 * fires (typically on `crm.deal.stage_changed`). Mirrors the gateway qualify path
 * via existing PipeGrpc + ContactGrpc contracts — no new REST surface.
 */
@Injectable()
export class QualifyDealExecutor implements ActionExecutor {
  readonly handles = ['qualify_deal'] as const;
  private readonly logger = new Logger(QualifyDealExecutor.name);
  private readonly pipe = new DomainGrpcClient(ENTITY_DOMAINS.deal.target);
  private readonly contact = new DomainGrpcClient(ENTITY_DOMAINS.contact.target);

  async execute(
    _type: string,
    action: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const nested = (
      action.config && typeof action.config === 'object' ? action.config : {}
    ) as Record<string, unknown>;
    const cfg = { ...action, ...nested };
    const dealId = str(cfg.deal_id ?? cfg.dealId ?? ctx.payload?.dealId ?? ctx.payload?.id).trim();
    if (!dealId) return { ok: false, error: 'qualify_deal_deal_required' };
    const target = str(cfg.target ?? 'contact').toLowerCase();
    if (target !== 'contact') return { ok: false, error: 'qualify_deal_contact_only_v1' };

    const dealRes = await this.pipe.invoke(
      'GetDeal',
      { project_id: ctx.projectId, id: dealId },
      ctx,
    );
    if (!dealRes.ok) return { ok: false, error: classifyGrpcFailure(dealRes, 'qualify_deal') };
    const deal = dealRes.response as Record<string, unknown>;
    if (str(deal.contact_id)) return { ok: true, noop: true };

    const lightPhone = str(deal.light_phone);
    const lightEmail = str(deal.light_email);
    const lightName = str(deal.light_name);
    const forceCreate = Boolean(cfg.force_create ?? cfg.forceCreate);

    let contactId = '';
    if (!forceCreate) {
      const dupRes = await this.contact.invoke(
        'FindDuplicates',
        { project_id: ctx.projectId, phone: lightPhone, email: lightEmail },
        ctx,
      );
      if (!dupRes.ok) return { ok: false, error: classifyGrpcFailure(dupRes, 'qualify_deal') };
      const candidates =
        ((dupRes.response as { candidates?: Record<string, unknown>[] })?.candidates ?? []) as Record<
          string,
          unknown
        >[];
      const live = candidates.filter((c) => !c.deleted);
      if (live.length === 1) {
        contactId = str(live[0].contact_id ?? live[0].contactId);
      } else if (candidates.length > 0) {
        return { ok: false, error: 'qualify_deal_duplicates_need_manual' };
      }
    }

    let snapshot: { name: string; phone: string; email: string };
    if (!contactId) {
      const parts = lightName.split(/\s+/).filter(Boolean);
      const firstName = parts.slice(1).join(' ') || parts[0] || '';
      const lastName = parts.length > 1 ? parts[0] : '';
      const createdRes = await this.contact.invoke(
        'CreateContact',
        {
          project_id: ctx.projectId,
          first_name: firstName,
          last_name: lastName,
          phone: lightPhone,
          email: lightEmail,
          source: str(deal.source),
          assignee_id: str(deal.assignee_id),
        },
        ctx,
      );
      if (!createdRes.ok)
        return { ok: false, error: classifyGrpcFailure(createdRes, 'qualify_deal') };
      const created = createdRes.response as Record<string, unknown>;
      contactId = str(created.id);
      snapshot = {
        name: [str(created.first_name), str(created.last_name)].filter(Boolean).join(' '),
        phone: str(created.phone),
        email: str(created.email),
      };
    } else {
      const readRes = await this.contact.invoke(
        'GetContact',
        { project_id: ctx.projectId, id: contactId },
        ctx,
      );
      if (!readRes.ok) return { ok: false, error: classifyGrpcFailure(readRes, 'qualify_deal') };
      const c = readRes.response as Record<string, unknown>;
      snapshot = {
        name: [str(c.first_name), str(c.last_name)].filter(Boolean).join(' '),
        phone: str(c.phone),
        email: str(c.email),
      };
    }

    const linkRes = await this.pipe.invoke(
      'LinkContact',
      { project_id: ctx.projectId, id: dealId, contact_id: contactId, snapshot },
      ctx,
    );
    if (!linkRes.ok) return { ok: false, error: classifyGrpcFailure(linkRes, 'qualify_deal') };
    this.logger.log(`qualify_deal linked contact ${contactId} to deal ${dealId}`);
    return { ok: true };
  }
}
