import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get httpPort(): number {
    return this.configService.get<number>('app.app.httpPort', 3007);
  }

  get grpcProductPort(): number {
    return this.configService.get<number>('app.app.grpcProductPort', 5007);
  }

  /** [#19] control gRPC address for domain-side deferred-scope hydration. */
  get controlGrpcUrl(): string {
    return this.configService.get<string>('app.grpc.controlUrl', '127.0.0.1:5002');
  }

  get databaseUrl(): string {
    return this.configService.get<string>('app.database.url', '');
  }

  get jwtSecret(): string {
    return this.configService.get<string>('app.jwt.secret', 'change-me');
  }
}
