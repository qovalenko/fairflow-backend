import { hashInvitationToken, mintInvitationToken } from './invitation-token.util';

describe('invitation-token.util', () => {
  it('stores SHA-256 hash, not plaintext', () => {
    const { plaintext, hash } = mintInvitationToken();
    expect(plaintext).toHaveLength(64);
    expect(hash).toBe(hashInvitationToken(plaintext));
    expect(hash).not.toBe(plaintext);
  });

  it('hashes lookup tokens deterministically', () => {
    const plain = 'deadbeef';
    expect(hashInvitationToken(plain)).toBe(hashInvitationToken('  deadbeef  '));
  });
});
