/** Shared noop deps for unit tests constructing {@link ReportsService} directly. */
export const reportsRollupHarness = {
  rollupStore: {
    read: async () => [],
    applyIncrement: async () => undefined,
  },
  rollupCoverage: {
    get: async () => null,
    isTrusted: () => false,
    markBackfilled: async () => undefined,
  },
  stageTransitions: {
    listForDeal: async () => [],
    avgDurationByStage: async () => [],
    applyTransition: async () => undefined,
  },
} as const;
