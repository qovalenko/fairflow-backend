import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AppErrorFilter } from './app-error.filter';
import type { GatewayEventsService } from '../events/gateway-events.service';

describe('AppErrorFilter access-denied audit (FR-ACCESS-630)', () => {
  it('emits control.access.denied on HTTP 403', () => {
    const accessDenied = jest.fn();
    const gatewayEvents = { accessDenied } as unknown as GatewayEventsService;
    const sent = {} as { status: number; body: Record<string, unknown> };
    const reply = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      send(body: Record<string, unknown>) {
        sent.body = body;
      },
    };
    const request = {
      headers: { 'x-request-id': 'rid-403', 'x-project-id': 'proj-9' },
      url: '/api/v1/deals',
      method: 'GET',
      query: {},
      user: { userId: 'actor-1' },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => request,
      }),
    };

    new AppErrorFilter(gatewayEvents).catch(
      new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'not allowed',
      }),
      host as never,
    );

    expect(sent.status).toBe(403);
    expect(accessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'actor-1',
        projectId: 'proj-9',
        requestId: 'rid-403',
        code: 'PERMISSION_DENIED',
        message: 'not allowed',
      }),
    );
  });

  it('takes projectId from guard-authorized __projectId / path param when header is absent', () => {
    const accessDenied = jest.fn();
    const gatewayEvents = { accessDenied } as unknown as GatewayEventsService;
    const reply = {
      status() {
        return this;
      },
      send() {},
    };
    const request = {
      headers: { 'x-request-id': 'rid-path' },
      url: '/api/v1/projects/proj-path/deals',
      method: 'GET',
      query: {},
      params: { projectId: 'proj-path' },
      __projectId: 'proj-auth',
      user: { userId: 'actor-2' },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => request,
      }),
    };

    new AppErrorFilter(gatewayEvents).catch(
      new ForbiddenException({ code: 'PROJECT_ACCESS_DENIED', message: 'nope' }),
      host as never,
    );

    expect(accessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'actor-2',
        projectId: 'proj-auth',
        code: 'PROJECT_ACCESS_DENIED',
      }),
    );
  });

  it('does not emit on 404', () => {
    const accessDenied = jest.fn();
    const gatewayEvents = { accessDenied } as unknown as GatewayEventsService;
    const sent = {} as { status: number };
    const reply = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      send() {},
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({
          headers: {},
          url: '/api/v1/missing',
          method: 'GET',
          query: {},
        }),
      }),
    };

    new AppErrorFilter(gatewayEvents).catch(new NotFoundException('nope'), host as never);

    expect(sent.status).toBe(404);
    expect(accessDenied).not.toHaveBeenCalled();
  });
});
