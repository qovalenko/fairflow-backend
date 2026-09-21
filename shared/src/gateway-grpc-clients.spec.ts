import { listGatewayGrpcClients } from './gateway-grpc-clients';

/**
 * box productisation (03-ARCHITECTURE.md §3.2/§3.4): the billing plane is not
 * deployed on-prem, so the gateway gRPC client registry never contains the
 * `BILLING_GRPC` descriptor — the DI token cannot be resolved by any controller.
 * The other infra clients are always present.
 */
describe('listGatewayGrpcClients — box registry', () => {
  it('never registers BILLING_GRPC', () => {
    const tokens = listGatewayGrpcClients().map((c) => c.token);
    expect(tokens).not.toContain('BILLING_GRPC');
  });

  it('registers the core infra clients', () => {
    const tokens = listGatewayGrpcClients().map((c) => c.token);
    expect(tokens).toContain('AUTH_GRPC');
    expect(tokens).toContain('CONTROL_GRPC');
  });
});
