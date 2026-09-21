import {
  catalogForRun,
  DEPARTMENT_BENCHMARK_MANAGER_ID,
  PRESET_VIZ_TYPE,
} from './reports-preset-catalog';

describe('reports-preset-catalog', () => {
  it('отдаёт viz.type и формулы для builtin-пресета', () => {
    const cat = catalogForRun('sales', null, 7);
    expect(cat.viz.type).toBe(PRESET_VIZ_TYPE.sales);
    expect(cat.metric_formulas.avg_check).toContain('Сумма сделок');
    expect(cat.metric_formulas.stalled).toBeUndefined();
  });

  it('берёт viz.type из custom spec', () => {
    const cat = catalogForRun(null, { viz: { type: 'line' } });
    expect(cat.viz.type).toBe('line');
  });

  it('подставляет stalled_days в формулу funnel', () => {
    const cat = catalogForRun('funnel', null, 14);
    expect(cat.metric_formulas.stalled).toContain('14');
  });

  it('экспортирует id бенчмарка отдела', () => {
    expect(DEPARTMENT_BENCHMARK_MANAGER_ID).toBe('__dept_benchmark__');
  });
});
