import { buildContactDocumentVariables, CONTACT_REQUIRED_VARIABLES } from './contacts.service';

/**
 * Donor variable-provider mapping (documents contract §4): a contact record
 * (toResponse shape) → flat `contact.*` map + drift hash + empty-required.
 */
describe('buildContactDocumentVariables', () => {
  it('maps contact fields to the contact.* variable namespace', () => {
    const res = buildContactDocumentVariables({
      firstName: 'Иван',
      lastName: 'Иванов',
      middleName: 'Петрович',
      phone: '+79001234567',
      email: 'ivan@example.com',
      position: 'Директор',
    });

    expect(res.values).toEqual({
      'contact.name': 'Иван Иванов',
      'contact.fullName': 'Иванов Иван Петрович',
      'contact.firstName': 'Иван',
      'contact.lastName': 'Иванов',
      'contact.middleName': 'Петрович',
      'contact.phone': '+79001234567',
      'contact.email': 'ivan@example.com',
      'contact.position': 'Директор',
    });
    expect(res.empty_required).toEqual([]);
    expect(res.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reports a blank required variable in empty_required', () => {
    const res = buildContactDocumentVariables({ firstName: '', lastName: '' });
    expect(res.empty_required).toEqual(CONTACT_REQUIRED_VARIABLES);
    expect(res.values['contact.name']).toBe('');
  });

  it('produces a deterministic, order-independent source_hash', () => {
    const a = buildContactDocumentVariables({ firstName: 'A', lastName: 'B', phone: '1' });
    const b = buildContactDocumentVariables({ phone: '1', lastName: 'B', firstName: 'A' });
    expect(a.source_hash).toBe(b.source_hash);

    const c = buildContactDocumentVariables({ firstName: 'A', lastName: 'B', phone: '2' });
    expect(c.source_hash).not.toBe(a.source_hash);
  });
});
