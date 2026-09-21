import { Module, forwardRef } from '@nestjs/common';
import { ProductService } from './product.service';
import { ProductGrpcController } from './product.grpc.controller';
import { UsageModule } from '../usage/usage.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ControlClientModule } from '../control/control-client.module';

@Module({
  imports: [forwardRef(() => UsageModule), ControlClientModule],
  controllers: [ProductGrpcController],
  providers: [ProductService, IdempotencyService],
  exports: [ProductService],
})
export class ProductModule {}
