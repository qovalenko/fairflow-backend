import { DocumentStorageService } from './document-storage.service';

/**
 * BX-FIX-5(в): `contextType`/`recordId` land in the S3 object key. They must be
 * whitelisted to `[A-Za-z0-9_-]` so a client can never inject `/` or `..` and
 * escape the `<projectId>/uploads/` prefix.
 */
describe('[BX-FIX-5] DocumentStorageService.sanitizeKeySegment', () => {
  const sanitize = DocumentStorageService.sanitizeKeySegment;

  it('passes through a plain safe segment unchanged', () => {
    expect(sanitize('deal')).toBe('deal');
    expect(sanitize('rec-123_x')).toBe('rec-123_x');
  });

  it('neutralizes path traversal and slashes', () => {
    expect(sanitize('../../etc/passwd')).not.toContain('/');
    expect(sanitize('../../etc/passwd')).not.toContain('..');
    expect(sanitize('a/b/c')).toBe('a_b_c');
  });

  it('collapses runs and trims separators produced by stripping', () => {
    expect(sanitize('..deal..')).toBe('deal');
    expect(sanitize('a...b')).toBe('a_b');
  });

  it('falls back to a safe token for empty / all-stripped input', () => {
    expect(sanitize(undefined)).toBe('x');
    expect(sanitize('')).toBe('x');
    expect(sanitize('///')).toBe('x');
  });

  it('caps segment length', () => {
    expect(sanitize('a'.repeat(500)).length).toBeLessThanOrEqual(128);
  });
});
