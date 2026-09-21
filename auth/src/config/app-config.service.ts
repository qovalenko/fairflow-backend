import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}
  get grpcPort(): number {
    return this.config.get<number>('app.grpc.port', 5001);
  }
  get port(): number {
    return this.config.get<number>('app.app.port', 3001);
  }
  get host(): string {
    return this.config.get<string>('app.app.host', '0.0.0.0');
  }
  get databaseUrl(): string {
    return this.config.get<string>('app.database.url', '');
  }
  get jwtSecret(): string {
    return this.config.get<string>('app.jwt.secret', 'change-me');
  }
  get jwtAccessExpire(): string {
    return this.config.get<string>('app.jwt.accessExpire', '15m');
  }
  get jwtRefreshExpire(): string {
    return this.config.get<string>('app.jwt.refreshExpire', '7d');
  }
  get oauth2Issuer(): string {
    return this.config.get<string>('app.oauth2.issuer', 'http://localhost:3001');
  }
  get corsOrigin(): string | string[] {
    return this.config.get<string | string[]>('app.cors.origin', '*');
  }
  get corsCredentials(): boolean {
    return this.config.get<boolean>('app.cors.credentials', false);
  }
}
