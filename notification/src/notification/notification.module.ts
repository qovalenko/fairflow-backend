import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { MailModule } from '../mail/mail.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ControlClientModule } from '../control/control-client.module';
import { ActivityClientModule } from '../activity/activity-client.module';
import { MetricsModule } from '../metrics/metrics.module';
import { NotificationConsumer } from './notification.consumer';
import { NotificationGrpcController } from './notification.grpc.controller';
import { MailGrpcController } from './mail.grpc.controller';
import { NotificationService } from './notification.service';
import { NotificationPointCheckService } from './notification-point-check.service';
import { ScheduledReminderService } from './scheduled-reminder.service';
import { ReminderDueScannerService } from './reminder-due-scanner.service';

@Module({
  imports: [MessagingModule, MailModule, RealtimeModule, ControlClientModule, ActivityClientModule, MetricsModule],
  controllers: [NotificationGrpcController, MailGrpcController],
  providers: [
    NotificationService,
    NotificationConsumer,
    NotificationPointCheckService,
    ScheduledReminderService,
    ReminderDueScannerService,
  ],
})
export class NotificationModule {}
