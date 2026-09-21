import type { OrderTypeSpecValidatorService } from './order-type-spec-validator.service';

/** No-op spec validator for unit tests that do not exercise type-save validation. */
export const noopSpecValidator = {
  assertValid: async () => undefined,
} as unknown as OrderTypeSpecValidatorService;
