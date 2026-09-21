/**
 * Канон пресетов отчётов: viz.type и формулы метрик (FR-REPORTS-160, FR-REPORTS-270).
 * Единый источник правды на бэкенде; фронт читает из payload прогона.
 */

export type PresetVizType = 'area' | 'bar' | 'line' | 'pie' | 'funnel' | 'table';

/** Дефолтный тип диаграммы встроенного пресета (таблица всегда строится на FE). */
export const PRESET_VIZ_TYPE: Record<string, PresetVizType> = {
  sales: 'area',
  funnel: 'funnel',
  clients: 'bar',
  activity: 'bar',
  sources: 'pie',
  by_managers: 'bar',
  my_overdue: 'table',
};

/** Машиночитаемые формулы KPI-карточек по пресету (ключ карточки → текст тултипа). */
export const PRESET_METRIC_FORMULAS: Record<string, Record<string, string>> = {
  sales: {
    avg_check: 'Сумма сделок ÷ количество сделок за период',
    conversion: 'Выигранные сделки ÷ все сделки периода',
  },
  funnel: {
    conversion: 'Сделки на последней стадии ÷ сделки на входной стадии',
    stalled: 'Открытые сделки без движения по стадии дольше N дн.',
  },
  clients: {
    contacts_without_deals: 'Контакты периода, на которых не заведено ни одной сделки',
    filled_both_pct: 'Доля живых контактов, у которых заполнены и email, и телефон',
  },
  activity: {
    overdue: 'Незавершённые активности, срок которых уже прошёл',
  },
  sources: {
    conversion: 'Выигранные сделки ÷ все сделки источника',
    avg_check: 'Сумма сделок ÷ количество сделок источника',
  },
  by_managers: {
    conversion: 'Выигранные сделки менеджера ÷ все его сделки периода',
    avg_check: 'Сумма сделок ÷ количество сделок менеджера',
  },
  my_overdue: {
    overdue_activities: 'Незавершённые активности в вашем scope, срок которых прошёл',
    inactive_deals: 'Открытые сделки без связанной активности дольше N дн.',
  },
};

export type RunCatalogPayload = {
  viz: { type: PresetVizType };
  metric_formulas: Record<string, string>;
};

/** Собрать каталог визуализации/формул для прогона (builtin или custom spec). */
export function catalogForRun(
  presetKey: string | null | undefined,
  spec?: Record<string, unknown> | null,
  stalledDays?: number,
): RunCatalogPayload {
  const specViz = spec?.viz;
  const specType =
    specViz && typeof specViz === 'object' && !Array.isArray(specViz)
      ? String((specViz as { type?: string }).type ?? '').trim()
      : '';
  const vizType = (specType || PRESET_VIZ_TYPE[presetKey ?? ''] || 'table') as PresetVizType;

  const baseFormulas = presetKey ? { ...(PRESET_METRIC_FORMULAS[presetKey] ?? {}) } : {};
  const formulas: Record<string, string> = { ...baseFormulas };
  if (stalledDays != null && formulas.stalled) {
    formulas.stalled = formulas.stalled.replace('N', String(stalledDays));
  }
  if (stalledDays != null && formulas.inactive_deals) {
    formulas.inactive_deals = formulas.inactive_deals.replace('N', String(stalledDays));
  }

  const specFormulas = spec?.metric_formulas ?? spec?.metricFormulas;
  if (specFormulas && typeof specFormulas === 'object' && !Array.isArray(specFormulas)) {
    for (const [k, v] of Object.entries(specFormulas as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) formulas[k] = v.trim();
    }
  }

  return { viz: { type: vizType }, metric_formulas: formulas };
}

/** Синтетический id строки обезличенного бенчмарка отдела (FR-REPORTS-100). */
export const DEPARTMENT_BENCHMARK_MANAGER_ID = '__dept_benchmark__';
