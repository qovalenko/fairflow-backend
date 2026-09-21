import {
  validateWebhookTarget,
  classifyResolvedIp,
  assertResolvedTargetAllowed,
} from './webhook-target';

describe('validateWebhookTarget — canonical anti-SSRF', () => {
  it('allows a plain public https host', () => {
    expect(validateWebhookTarget('https://hooks.example.com/x').ok).toBe(true);
  });

  it('rejects non-https schemes', () => {
    expect(validateWebhookTarget('http://example.com')).toEqual({ ok: false, reason: 'scheme' });
  });

  it('blocks canonical loopback / RFC1918 / metadata', () => {
    expect(validateWebhookTarget('https://127.0.0.1/').reason).toBe('loopback');
    expect(validateWebhookTarget('https://10.0.0.5/').reason).toBe('private_ip');
    expect(validateWebhookTarget('https://192.168.1.1/').reason).toBe('private_ip');
    expect(validateWebhookTarget('https://172.16.0.1/').reason).toBe('private_ip');
    expect(validateWebhookTarget('https://169.254.169.254/').reason).toBe('metadata');
    expect(validateWebhookTarget('https://169.254.1.1/').reason).toBe('link_local');
  });

  it('blocks obfuscated numeric loopback (short / decimal / octal / hex)', () => {
    for (const h of ['127.1', '2130706433', '0177.0.0.1', '0x7f.1', '0x7f000001', '017700000001']) {
      const v = validateWebhookTarget(`https://${h}/`);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('loopback');
    }
  });

  it('blocks decimal-encoded metadata endpoint', () => {
    // 169.254.169.254 == 2852039166
    expect(validateWebhookTarget('https://2852039166/').reason).toBe('metadata');
  });

  it('rejects numeric-looking but out-of-range hosts as malformed', () => {
    expect(validateWebhookTarget('https://999.999.999.999/').reason).toBe('malformed');
    expect(validateWebhookTarget('https://1.2.3.4.5/').reason).toBe('malformed');
    expect(validateWebhookTarget('https://08.0.0.1/').reason).toBe('malformed');
  });

  it('allows an obfuscated PUBLIC numeric literal (declassified to 8.8.8.8)', () => {
    expect(validateWebhookTarget('https://0x08080808/').ok).toBe(true);
  });

  it('blocks IPv6 loopback / ULA / link-local', () => {
    expect(validateWebhookTarget('https://[::1]/').reason).toBe('loopback');
    expect(validateWebhookTarget('https://[fc00::1]/').reason).toBe('private_ip');
    expect(validateWebhookTarget('https://[fd12:3456::1]/').reason).toBe('private_ip');
    expect(validateWebhookTarget('https://[fe80::1]/').reason).toBe('link_local');
    expect(validateWebhookTarget('https://[::]/').reason).toBe('loopback');
  });

  it('blocks IPv4-mapped IPv6 pointing at private space', () => {
    expect(validateWebhookTarget('https://[::ffff:127.0.0.1]/').reason).toBe('loopback');
    expect(validateWebhookTarget('https://[::ffff:169.254.169.254]/').reason).toBe('metadata');
    expect(validateWebhookTarget('https://[::ffff:10.0.0.1]/').reason).toBe('private_ip');
  });

  it('blocks internal hostnames', () => {
    expect(validateWebhookTarget('https://localhost/').reason).toBe('internal_host');
    expect(validateWebhookTarget('https://svc.internal/').reason).toBe('internal_host');
    expect(validateWebhookTarget('https://svc.lan/').reason).toBe('internal_host');
    expect(validateWebhookTarget('https://box.ts.net/').reason).toBe('internal_host');
  });
});

describe('classifyResolvedIp — send-time DNS re-check', () => {
  it('flags private resolved addresses', () => {
    expect(classifyResolvedIp('127.0.0.1')).toBe('loopback');
    expect(classifyResolvedIp('169.254.169.254')).toBe('metadata');
    expect(classifyResolvedIp('::1')).toBe('loopback');
    expect(classifyResolvedIp('::ffff:127.0.0.1')).toBe('loopback');
  });
  it('passes public resolved addresses', () => {
    expect(classifyResolvedIp('8.8.8.8')).toBeNull();
    expect(classifyResolvedIp('2001:4860:4860::8888')).toBeNull();
  });
});

describe('assertResolvedTargetAllowed — literal short-circuit', () => {
  it('blocks obfuscated numeric literal without touching DNS', async () => {
    await expect(assertResolvedTargetAllowed('https://2130706433/')).resolves.toEqual({
      ok: false,
      reason: 'loopback',
    });
  });
  it('allows a public IP literal', async () => {
    await expect(assertResolvedTargetAllowed('https://8.8.8.8/')).resolves.toEqual({ ok: true });
  });
});
