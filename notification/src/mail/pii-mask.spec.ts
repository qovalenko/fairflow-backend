import { maskEmail, maskEmailsInText } from './pii-mask';

/**
 * X1 — the masking contract. Two properties matter and pull against each other:
 * the mailbox must NOT survive, and the message must stay diagnosable.
 */
describe('email PII masking (X1)', () => {
  describe('maskEmail', () => {
    it('keeps the domain and cuts the local part to one character', () => {
      expect(maskEmail('john.doe@example.com')).toBe('j***@example.com');
      expect(maskEmail('  Ivan.Petrov@corp.example.org  ')).toBe('I***@corp.example.org');
    });

    it('drops a one-character local part whole (l*** would BE the address)', () => {
      expect(maskEmail('a@b.ru')).toBe('***@b.ru');
    });

    it('never returns something that is not an address as-is', () => {
      expect(maskEmail('not an address')).toBe('***');
      expect(maskEmail('@example.com')).toBe('***');
      expect(maskEmail('john@')).toBe('***');
      expect(maskEmail('')).toBe('');
    });

    it('masks the mailbox, not the sub-addressing tag (plus-addressing)', () => {
      // the tag is part of the local part and goes away with it
      expect(maskEmail('sales+lead42@example.com')).toBe('s***@example.com');
    });
  });

  describe('maskEmailsInText', () => {
    it('masks addresses echoed by SMTP and keeps everything else verbatim', () => {
      expect(maskEmailsInText('550 5.1.1 <john.doe@example.com>: Recipient address rejected')).toBe(
        '550 5.1.1 <j***@example.com>: Recipient address rejected',
      );
    });

    it('masks EVERY address in the message, not just the first', () => {
      const out = maskEmailsInText('envelope from ceo@acme.io to buyer@client.co failed');
      expect(out).not.toContain('ceo@acme.io');
      expect(out).not.toContain('buyer@client.co');
      expect(out).toBe('envelope from c***@acme.io to b***@client.co failed');
    });

    it('leaves address-free diagnostics completely untouched', () => {
      expect(maskEmailsInText('connect ECONNREFUSED 10.0.0.5:587')).toBe(
        'connect ECONNREFUSED 10.0.0.5:587',
      );
      expect(maskEmailsInText('451 4.7.1 Try again later')).toBe('451 4.7.1 Try again later');
    });

    it('accepts a thrown Error, not just a string', () => {
      const err = new Error('Invalid recipient: bob@corp.example.org');
      expect(maskEmailsInText(err)).toBe('Error: Invalid recipient: b***@corp.example.org');
      expect(maskEmailsInText(undefined)).toBe('');
    });
  });
});
