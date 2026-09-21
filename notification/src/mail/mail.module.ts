import { Module } from '@nestjs/common';
import { AuthValidationModule } from '../auth-validation/auth-validation.module';
import { MailerService } from './mailer.service';
import { UserDirectoryService } from './user-directory.service';

/**
 * Outbound email: SMTP transport ({@link MailerService}) + the trusted recipient
 * lookup ({@link UserDirectoryService}). Imports AuthValidationModule to reuse its
 * exported AUTH_VALIDATION_GRPC client (fairflow.auth.v1) for directory resolution.
 */
@Module({
  imports: [AuthValidationModule],
  providers: [MailerService, UserDirectoryService],
  exports: [MailerService, UserDirectoryService],
})
export class MailModule {}
