/**
 * Бюджет и ограничение частоты для выгрузки продаж (`GET /v1/orders/export`).
 *
 * ЗАЧЕМ. Выгрузка — единственный маршрут продаж, где один HTTP-запрос
 * разворачивается в СОТНИ и ТЫСЯЧИ gRPC-вызовов: до 100 последовательных
 * `ListOrders` (страница = доменный максимум 100 строк, потолок 10 000 строк)
 * плюс резолв имён в четыре соседних домена одиночными `GetProduct`/`GetDeal`/
 * `GetContact`/`GetCompany` — в худшем случае по одному на строку на каждый вид,
 * т.е. до ~40 000 вызовов. Каждый вызов имеет СВОЙ дедлайн (5 с), а общего
 * потолка ни по времени, ни по количеству у запроса не было: несколько
 * параллельных выгрузок укладывали не gateway, а contacts/companies/pipe/product.
 *
 * ЧТО ЗДЕСЬ. Три ограничителя, которых не хватало:
 *  1) `ExportBudget.hasTime()` — ОБЩИЙ wall-clock бюджет запроса. Листание
 *     прерывается по его исчерпанию с тем же маркером усечения, что и потолок
 *     строк (пользователь видит «выгружены первые N»), резолв имён — с явной
 *     пометкой «имена разрешены не все».
 *  2) `ExportBudget.takeCalls()` — ОБЩИЙ на все четыре вида имён потолок
 *     одиночных Get*-вызовов. Кончился — оставшиеся имена в файле пустые
 *     и об этом сказано, а не «тихо 40 000 RPC».
 *  3) `ExportInflightLimiter` — сколько выгрузок разрешено ОДНОВРЕМЕННО на
 *     пользователя / проект / процесс. Это и есть egress rate-limit из
 *     `TODO(152-ФЗ / E2-08)` в части нагрузки: усиление опасно ровно
 *     параллелизмом, последовательные выгрузки уже ограничены бюджетом выше.
 *
 * ЧЕГО ЗДЕСЬ НЕТ (сознательно). Настоящее лечение усиления — батч-резолв имён
 * (`Get<Entity>Batch` / `List…?ids=`) у доноров: 10 000 имён это один-два вызова,
 * а не 10 000. Доноры (contact/company/pipe/product) — чужой слой, их proto и
 * сервисы правит владелец соответствующего домена; здесь стоит честный потолок
 * с деградацией, а не имитация батча на gateway.
 */

/** Целое из env с нижней границей; мусор/отсутствие → значение по умолчанию. */
function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export interface OrdersExportLimits {
  /** Общий wall-clock бюджет одного запроса выгрузки, мс. */
  budgetMs: number;
  /** Общий потолок одиночных Get*-вызовов резолва имён на одну выгрузку. */
  nameRpcBudget: number;
  /** Одновременных выгрузок на пользователя. */
  perUser: number;
  /** Одновременных выгрузок на проект. */
  perProject: number;
  /** Одновременных выгрузок на процесс gateway. */
  total: number;
}

/**
 * Лимиты читаются из env НА КАЖДЫЙ запрос, а не один раз при загрузке модуля:
 * коробка настраивается переменными окружения без пересборки, а тестам не нужен
 * `jest.resetModules`.
 */
export function ordersExportLimits(): OrdersExportLimits {
  return {
    // 45 с: больше клиентского терпения уже нет смысла держать соединение,
    // а 10 000 строк по 100 в странице при здоровом домене укладываются в единицы секунд.
    budgetMs: envInt('ORDERS_EXPORT_BUDGET_MS', 45_000, 1),
    // 2000 одиночных RPC на все четыре вида имён: типовая выгрузка (дедуп по id —
    // продуктов/типов в проекте десятки) укладывается целиком, патологическая
    // «10 000 строк × 4 уникальных id» деградирует явно, а не топит доноров.
    nameRpcBudget: envInt('ORDERS_EXPORT_NAME_RPC_BUDGET', 2000, 0),
    perUser: envInt('ORDERS_EXPORT_MAX_INFLIGHT_PER_USER', 1, 1),
    perProject: envInt('ORDERS_EXPORT_MAX_INFLIGHT_PER_PROJECT', 2, 1),
    total: envInt('ORDERS_EXPORT_MAX_INFLIGHT', 4, 1),
  };
}

export interface ExportBudgetOptions {
  budgetMs: number;
  nameRpcBudget: number;
  /** Источник времени — подменяется в тестах. */
  now?: () => number;
}

/** Бюджет ОДНОГО запроса выгрузки: время на всё + количество Get*-вызовов на имена. */
export class ExportBudget {
  private readonly now: () => number;
  private readonly deadlineAt: number;
  private callsLeft: number;
  private namesIncompleteFlag = false;
  private timedOutFlag = false;

  constructor(opts: ExportBudgetOptions) {
    this.now = opts.now ?? Date.now;
    this.deadlineAt = this.now() + Math.max(1, opts.budgetMs);
    this.callsLeft = Math.max(0, opts.nameRpcBudget);
  }

  /** Осталось ли время. Без побочных эффектов: факт остановки отмечает вызывающий. */
  hasTime(): boolean {
    return this.now() < this.deadlineAt;
  }

  /** Бронирует до `n` вызовов в доноров; вернёт, сколько РАЗРЕШЕНО сделать. */
  takeCalls(n: number): number {
    const want = Math.max(0, n);
    const allowed = Math.min(want, this.callsLeft);
    this.callsLeft -= allowed;
    if (allowed < want) this.markNamesIncomplete();
    return allowed;
  }

  /** Работу прервал дедлайн (а не потолок строк) — для формулировки маркера. */
  markTimedOut(): void {
    this.timedOutFlag = true;
  }

  /** Часть имён осталась неразрешённой — файл обязан сказать об этом. */
  markNamesIncomplete(): void {
    this.namesIncompleteFlag = true;
  }

  get timedOut(): boolean {
    return this.timedOutFlag;
  }

  get namesIncomplete(): boolean {
    return this.namesIncompleteFlag;
  }

  /** Остаток бюджета вызовов — для тестов и диагностики. */
  get callsRemaining(): number {
    return this.callsLeft;
  }
}

/**
 * Счётчик одновременных выгрузок. Процессный (in-memory): в коробке gateway —
 * один процесс, а в облаке это нижняя граница защиты, которую при желании
 * дополняет edge-лимитер; распределённый счётчик в Redis сюда не тянем, чтобы
 * ограничитель не зависел от доступности внешнего хранилища (иначе его отказ
 * либо снимает защиту, либо ломает выгрузку).
 */
export class ExportInflightLimiter {
  private readonly perUser = new Map<string, number>();
  private readonly perProject = new Map<string, number>();
  private totalInflight = 0;

  /**
   * Занять слот. Возвращает функцию освобождения (идемпотентную) либо `null` —
   * свободных слотов нет, вызывающий обязан ответить 429.
   */
  acquire(userKey: string, projectKey: string, limits: OrdersExportLimits): (() => void) | null {
    const u = this.perUser.get(userKey) ?? 0;
    const p = this.perProject.get(projectKey) ?? 0;
    if (this.totalInflight >= limits.total || u >= limits.perUser || p >= limits.perProject) {
      return null;
    }
    this.perUser.set(userKey, u + 1);
    this.perProject.set(projectKey, p + 1);
    this.totalInflight += 1;

    let released = false;
    return () => {
      // Двойной release (например, из finally и из обработчика ошибки) не должен
      // «печатать» слоты: счётчик обязан вернуться ровно на единицу.
      if (released) return;
      released = true;
      this.dec(this.perUser, userKey);
      this.dec(this.perProject, projectKey);
      this.totalInflight = Math.max(0, this.totalInflight - 1);
    };
  }

  /** Уменьшить счётчик ключа, удаляя нулевые записи (иначе карта течёт по userId). */
  private dec(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 1) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  get inflight(): number {
    return this.totalInflight;
  }
}
