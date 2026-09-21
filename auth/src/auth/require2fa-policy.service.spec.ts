import { Require2faPolicyService } from './require2fa-policy.service';

describe('Require2faPolicyService', () => {
  it('defaults to false unless env or setRequired flips it', () => {
    const svc = new Require2faPolicyService();
    expect(svc.isRequired()).toBe(false);
    svc.setRequired(true);
    expect(svc.isRequired()).toBe(true);
    svc.setRequired(false);
    expect(svc.isRequired()).toBe(false);
  });
});
