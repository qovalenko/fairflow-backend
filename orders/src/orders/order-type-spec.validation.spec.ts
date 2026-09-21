import {
  collectDocumentTemplateSpecViolations,
  collectFinalActionSpecViolations,
  extractDocumentTemplateIds,
  extractFinalActionExistenceChecks,
  type SpecViolation,
} from './order-type-spec.validation';

function violationsOf(fn: (v: SpecViolation[]) => void): SpecViolation[] {
  const v: SpecViolation[] = [];
  fn(v);
  return v;
}

describe('order-type-spec.validation (FR-ORDERS-035)', () => {
  const stages = [
    { id: 's1', name: 'New', order: 0, isTerminal: false },
    { id: 's2', name: 'Done', order: 1, isTerminal: true },
  ];

  it('rejects webhook without connection ref', () => {
    const v = violationsOf((out) =>
      collectFinalActionSpecViolations({ type: 'webhook', config: {} }, out),
    );
    expect(v).toContainEqual({
      field: 'finalActionSpec.config',
      reason: 'webhook_connection_required',
    });
  });

  it('rejects webhook with raw URL', () => {
    const v = violationsOf((out) =>
      collectFinalActionSpecViolations(
        { type: 'webhook', config: { connection_id: 'c1', url: 'http://evil' } },
        out,
      ),
    );
    expect(v).toContainEqual({ field: 'finalActionSpec.config', reason: 'raw_url_forbidden' });
  });

  it('accepts webhook with connection ref only', () => {
    const v = violationsOf((out) =>
      collectFinalActionSpecViolations({ type: 'webhook', config: { connection_id: 'c1' } }, out),
    );
    expect(v).toHaveLength(0);
    expect(
      extractFinalActionExistenceChecks({ type: 'webhook', config: { connection_id: 'c1' } }),
    ).toEqual({ connectionId: 'c1' });
  });

  it('rejects email without recipient', () => {
    const v = violationsOf((out) =>
      collectFinalActionSpecViolations({ type: 'email', config: { subject: 'Hi' } }, out),
    );
    expect(v).toContainEqual({
      field: 'finalActionSpec.config.to',
      reason: 'email_recipient_required',
    });
  });

  it('accepts email with literal mailbox', () => {
    const v = violationsOf((out) =>
      collectFinalActionSpecViolations(
        { type: 'email', config: { to: 'client@example.com' } },
        out,
      ),
    );
    expect(v).toHaveLength(0);
  });

  it('accepts email with placeholder recipient', () => {
    const v = violationsOf((out) =>
      collectFinalActionSpecViolations({ type: 'email', config: { to: '{{contact.email}}' } }, out),
    );
    expect(v).toHaveLength(0);
  });

  it('rejects email with invalid recipient', () => {
    const v = violationsOf((out) =>
      collectFinalActionSpecViolations({ type: 'email', config: { to: 'not-an-email' } }, out),
    );
    expect(v).toContainEqual({
      field: 'finalActionSpec.config.to',
      reason: 'email_recipient_invalid',
    });
  });

  it('rejects task without title', () => {
    const v = violationsOf((out) =>
      collectFinalActionSpecViolations({ type: 'task', config: { description: 'x' } }, out),
    );
    expect(v).toContainEqual({
      field: 'finalActionSpec.config.title',
      reason: 'task_title_required',
    });
  });

  it('accepts task with title and optional assignee for existence check', () => {
    const spec = { type: 'task', config: { title: 'Позвонить', userId: 'u1' } };
    const v = violationsOf((out) => collectFinalActionSpecViolations(spec, out));
    expect(v).toHaveLength(0);
    expect(extractFinalActionExistenceChecks(spec)).toEqual({ assigneeId: 'u1' });
    void stages;
  });
});

describe('order-type-spec.validation (FR-ORDERS-100)', () => {
  it('rejects non-array documentTemplates', () => {
    const v = violationsOf((out) => collectDocumentTemplateSpecViolations({}, out));
    expect(v).toContainEqual({ field: 'documentTemplates', reason: 'invalid_shape' });
  });

  it('rejects entries without template id', () => {
    const v = violationsOf((out) => collectDocumentTemplateSpecViolations([{ name: 'x' }], out));
    expect(v).toContainEqual({
      field: 'documentTemplates[0]',
      reason: 'template_id_required',
    });
  });

  it('rejects duplicate template ids', () => {
    const v = violationsOf((out) =>
      collectDocumentTemplateSpecViolations([{ id: 't1' }, { templateId: 't1' }], out),
    );
    expect(v).toContainEqual({
      field: 'documentTemplates[1]',
      reason: 'duplicate_template_id',
    });
  });

  it('extracts template ids from id/templateId keys', () => {
    expect(extractDocumentTemplateIds([{ id: 'a' }, { templateId: 'b' }])).toEqual(['a', 'b']);
  });
});
