import { SetMetadata } from '@nestjs/common';

export const REQUIRED_MODULE_KEY = 'requiredModule';

export const RequireModule = (moduleId: string) => SetMetadata(REQUIRED_MODULE_KEY, moduleId);
