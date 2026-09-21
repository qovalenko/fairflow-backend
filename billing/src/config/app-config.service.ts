import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get httpPort(): number {
    return this.configService.get<number>('app.app.port', 3011);
  }

  get host(): string {
    return this.configService.get<string>('app.app.host', '0.0.0.0');
  }

  get grpcBillingPort(): number {
    return this.configService.get<number>('app.app.grpcBillingPort', 5016);
  }

  get authGrpcUrl(): string {
    return this.configService.get<string>('app.grpc.authValidationUrl', '127.0.0.1:5001');
  }

  get databaseUrl(): string {
    return this.configService.get<string>('app.database.url', '');
  }
}
