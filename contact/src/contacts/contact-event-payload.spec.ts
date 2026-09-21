import { buildContactCreatedEventPayload } from './contact-event-payload';

describe('buildContactCreatedEventPayload (NFR-CONTACTS-050)', () => {
  it('не отдаёт сырой email/phone, но несёт masked subtitle и indexTokens', () => {
    const payload = buildContactCreatedEventPayload({
      contactId: 'c1',
      firstName: 'Иван',
      lastName: 'Иванов',
      email: 'ivan@example.com',
      phone: '+79001112233',
      companyIds: ['co1'],
      ownerId: 'u1',
      departmentId: null,
    });
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('phone');
    expect(payload.contactId).toBe('c1');
    expect(payload.subtitle).toBe('i***@example.com · +***2233');
    expect(String(payload.indexTokens)).toContain('ivan@example.com');
    expect(String(payload.indexTokens)).toContain('9001112233');
  });
});
