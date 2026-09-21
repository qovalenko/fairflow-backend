import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get grpcPort(): number {
    return this.configService.get<number>('app.grpc.port', 5004);
  }

  get authGrpcUrl(): string {
    return this.configService.get<string>('app.grpc.authValidationUrl', '127.0.0.1:5001');
  }

  /** [#19] control gRPC address for domain-side deferred-scope hydration. */
  get controlGrpcUrl(): string {
    return this.configService.get<string>('app.grpc.controlUrl', '127.0.0.1:5002');
  }

  get port(): number {
    return this.configService.get<number>('app.app.port', 3000);
  }

  get host(): string {
    return this.configService.get<string>('app.app.host', '0.0.0.0');
  }

  get nodeEnv(): string {
    return this.configService.get<string>('app.app.nodeEnv', 'development');
  }

  get databaseUrl(): string {
    return this.configService.get<string>('app.database.url', '');
  }

  get jwtSecret(): string {
    return this.configService.get<string>('app.jwt.secret', 'change-me');
  }

  get jwtExpiresIn(): string {
    return this.configService.get<string>('app.jwt.expiresIn', '7d');
  }

  get corsOrigin(): string | string[] {
    return this.configService.get<string | string[]>('app.cors.origin', '*');
  }

  get corsCredentials(): boolean {
    return this.configService.get<boolean>('app.cors.credentials', false);
  }

  get sleepBeforeShutdownMs(): number {
    return this.configService.get<number>('app.gracefulShutdown.sleepBeforeShutdownMs', 5000);
  }

  get forceShutdownTimeoutMs(): number {
    return this.configService.get<number>('app.gracefulShutdown.forceShutdownTimeoutMs', 30000);
  }
}
