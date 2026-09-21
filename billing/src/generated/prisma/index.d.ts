
/**
 * Client
**/

import * as runtime from './runtime/client.js';
import $Types = runtime.Types // general types
import $Public = runtime.Types.Public
import $Utils = runtime.Types.Utils
import $Extensions = runtime.Types.Extensions
import $Result = runtime.Types.Result

export type PrismaPromise<T> = $Public.PrismaPromise<T>


/**
 * Model BillingPlan
 * 
 */
export type BillingPlan = $Result.DefaultSelection<Prisma.$BillingPlanPayload>
/**
 * Model BillingPlanQuota
 * 
 */
export type BillingPlanQuota = $Result.DefaultSelection<Prisma.$BillingPlanQuotaPayload>
/**
 * Model BillingSubscription
 * 
 */
export type BillingSubscription = $Result.DefaultSelection<Prisma.$BillingSubscriptionPayload>
/**
 * Model BillingPayment
 * 
 */
export type BillingPayment = $Result.DefaultSelection<Prisma.$BillingPaymentPayload>
/**
 * Model BillingInvoice
 * 
 */
export type BillingInvoice = $Result.DefaultSelection<Prisma.$BillingInvoicePayload>
/**
 * Model BillingQuotaUsage
 * 
 */
export type BillingQuotaUsage = $Result.DefaultSelection<Prisma.$BillingQuotaUsagePayload>
/**
 * Model ModuleSubscription
 * I1a (E3-04): per-(project, module) paid-module subscription — second
 * monetization layer (FR-BILL-16/17/18). Thin MVP scopes by `projectId`
 * (current subject; full `account_ref` migration is NFR-BILL-7, deferred).
 */
export type ModuleSubscription = $Result.DefaultSelection<Prisma.$ModuleSubscriptionPayload>
/**
 * Model AccountStateChange
 * I1a (E3-04): journal of account/module state transitions (FR-BILL-14).
 */
export type AccountStateChange = $Result.DefaultSelection<Prisma.$AccountStateChangePayload>
/**
 * Model BillingProcessedMessage
 * I1a (E3-04): transport dedup for the bus consumer / idempotent IncrementUsage
 * (NFR-BILL-4, RFC-4 §Р-4). Dedup key = `idempotencyKey ?? messageId`.
 */
export type BillingProcessedMessage = $Result.DefaultSelection<Prisma.$BillingProcessedMessagePayload>
/**
 * Model BillingEventOutbox
 * I1a (E3-04): transactional outbox for `billing.*` emits (E3-01, RFC-4 §Р-1).
 * Written in the same Prisma tx as the business mutation; a relay pumps rows.
 */
export type BillingEventOutbox = $Result.DefaultSelection<Prisma.$BillingEventOutboxPayload>

/**
 * ##  Prisma Client ʲˢ
 *
 * Type-safe database client for TypeScript & Node.js
 * @example
 * ```
 * const prisma = new PrismaClient({
 *   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })
 * })
 * // Fetch zero or more BillingPlans
 * const billingPlans = await prisma.billingPlan.findMany()
 * ```
 *
 *
 * Read more in our [docs](https://pris.ly/d/client).
 */
export class PrismaClient<
  ClientOptions extends Prisma.PrismaClientOptions = Prisma.PrismaClientOptions,
  const U = 'log' extends keyof ClientOptions ? ClientOptions['log'] extends Array<Prisma.LogLevel | Prisma.LogDefinition> ? Prisma.GetEvents<ClientOptions['log']> : never : never,
  ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs
> {
  [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['other'] }

    /**
   * ##  Prisma Client ʲˢ
   *
   * Type-safe database client for TypeScript & Node.js
   * @example
   * ```
   * const prisma = new PrismaClient({
   *   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })
   * })
   * // Fetch zero or more BillingPlans
   * const billingPlans = await prisma.billingPlan.findMany()
   * ```
   *
   *
   * Read more in our [docs](https://pris.ly/d/client).
   */

  constructor(optionsArg ?: Prisma.Subset<ClientOptions, Prisma.PrismaClientOptions>);
  $on<V extends U>(eventType: V, callback: (event: V extends 'query' ? Prisma.QueryEvent : Prisma.LogEvent) => void): PrismaClient;

  /**
   * Connect with the database
   */
  $connect(): $Utils.JsPromise<void>;

  /**
   * Disconnect from the database
   */
  $disconnect(): $Utils.JsPromise<void>;

/**
   * Executes a prepared raw query and returns the number of affected rows.
   * @example
   * ```
   * const result = await prisma.$executeRaw`UPDATE User SET cool = ${true} WHERE email = ${'user@email.com'};`
   * ```
   *
   * Read more in our [docs](https://pris.ly/d/raw-queries).
   */
  $executeRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Prisma.PrismaPromise<number>;

  /**
   * Executes a raw query and returns the number of affected rows.
   * Susceptible to SQL injections, see documentation.
   * @example
   * ```
   * const result = await prisma.$executeRawUnsafe('UPDATE User SET cool = $1 WHERE email = $2 ;', true, 'user@email.com')
   * ```
   *
   * Read more in our [docs](https://pris.ly/d/raw-queries).
   */
  $executeRawUnsafe<T = unknown>(query: string, ...values: any[]): Prisma.PrismaPromise<number>;

  /**
   * Performs a prepared raw query and returns the `SELECT` data.
   * @example
   * ```
   * const result = await prisma.$queryRaw`SELECT * FROM User WHERE id = ${1} OR email = ${'user@email.com'};`
   * ```
   *
   * Read more in our [docs](https://pris.ly/d/raw-queries).
   */
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Prisma.PrismaPromise<T>;

  /**
   * Performs a raw query and returns the `SELECT` data.
   * Susceptible to SQL injections, see documentation.
   * @example
   * ```
   * const result = await prisma.$queryRawUnsafe('SELECT * FROM User WHERE id = $1 OR email = $2;', 1, 'user@email.com')
   * ```
   *
   * Read more in our [docs](https://pris.ly/d/raw-queries).
   */
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Prisma.PrismaPromise<T>;


  /**
   * Allows the running of a sequence of read/write operations that are guaranteed to either succeed or fail as a whole.
   * @example
   * ```
   * const [george, bob, alice] = await prisma.$transaction([
   *   prisma.user.create({ data: { name: 'George' } }),
   *   prisma.user.create({ data: { name: 'Bob' } }),
   *   prisma.user.create({ data: { name: 'Alice' } }),
   * ])
   * ```
   * 
   * Read more in our [docs](https://www.prisma.io/docs/orm/prisma-client/queries/transactions).
   */
  $transaction<P extends Prisma.PrismaPromise<any>[]>(arg: [...P], options?: { isolationLevel?: Prisma.TransactionIsolationLevel }): $Utils.JsPromise<runtime.Types.Utils.UnwrapTuple<P>>

  $transaction<R>(fn: (prisma: Omit<PrismaClient, runtime.ITXClientDenyList>) => $Utils.JsPromise<R>, options?: { maxWait?: number, timeout?: number, isolationLevel?: Prisma.TransactionIsolationLevel }): $Utils.JsPromise<R>

  $extends: $Extensions.ExtendsHook<"extends", Prisma.TypeMapCb<ClientOptions>, ExtArgs, $Utils.Call<Prisma.TypeMapCb<ClientOptions>, {
    extArgs: ExtArgs
  }>>

      /**
   * `prisma.billingPlan`: Exposes CRUD operations for the **BillingPlan** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more BillingPlans
    * const billingPlans = await prisma.billingPlan.findMany()
    * ```
    */
  get billingPlan(): Prisma.BillingPlanDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.billingPlanQuota`: Exposes CRUD operations for the **BillingPlanQuota** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more BillingPlanQuotas
    * const billingPlanQuotas = await prisma.billingPlanQuota.findMany()
    * ```
    */
  get billingPlanQuota(): Prisma.BillingPlanQuotaDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.billingSubscription`: Exposes CRUD operations for the **BillingSubscription** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more BillingSubscriptions
    * const billingSubscriptions = await prisma.billingSubscription.findMany()
    * ```
    */
  get billingSubscription(): Prisma.BillingSubscriptionDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.billingPayment`: Exposes CRUD operations for the **BillingPayment** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more BillingPayments
    * const billingPayments = await prisma.billingPayment.findMany()
    * ```
    */
  get billingPayment(): Prisma.BillingPaymentDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.billingInvoice`: Exposes CRUD operations for the **BillingInvoice** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more BillingInvoices
    * const billingInvoices = await prisma.billingInvoice.findMany()
    * ```
    */
  get billingInvoice(): Prisma.BillingInvoiceDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.billingQuotaUsage`: Exposes CRUD operations for the **BillingQuotaUsage** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more BillingQuotaUsages
    * const billingQuotaUsages = await prisma.billingQuotaUsage.findMany()
    * ```
    */
  get billingQuotaUsage(): Prisma.BillingQuotaUsageDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.moduleSubscription`: Exposes CRUD operations for the **ModuleSubscription** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more ModuleSubscriptions
    * const moduleSubscriptions = await prisma.moduleSubscription.findMany()
    * ```
    */
  get moduleSubscription(): Prisma.ModuleSubscriptionDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.accountStateChange`: Exposes CRUD operations for the **AccountStateChange** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more AccountStateChanges
    * const accountStateChanges = await prisma.accountStateChange.findMany()
    * ```
    */
  get accountStateChange(): Prisma.AccountStateChangeDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.billingProcessedMessage`: Exposes CRUD operations for the **BillingProcessedMessage** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more BillingProcessedMessages
    * const billingProcessedMessages = await prisma.billingProcessedMessage.findMany()
    * ```
    */
  get billingProcessedMessage(): Prisma.BillingProcessedMessageDelegate<ExtArgs, ClientOptions>;

  /**
   * `prisma.billingEventOutbox`: Exposes CRUD operations for the **BillingEventOutbox** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more BillingEventOutboxes
    * const billingEventOutboxes = await prisma.billingEventOutbox.findMany()
    * ```
    */
  get billingEventOutbox(): Prisma.BillingEventOutboxDelegate<ExtArgs, ClientOptions>;
}

export namespace Prisma {
  export import DMMF = runtime.DMMF

  export type PrismaPromise<T> = $Public.PrismaPromise<T>

  /**
   * Validator
   */
  export import validator = runtime.Public.validator

  /**
   * Prisma Errors
   */
  export import PrismaClientKnownRequestError = runtime.PrismaClientKnownRequestError
  export import PrismaClientUnknownRequestError = runtime.PrismaClientUnknownRequestError
  export import PrismaClientRustPanicError = runtime.PrismaClientRustPanicError
  export import PrismaClientInitializationError = runtime.PrismaClientInitializationError
  export import PrismaClientValidationError = runtime.PrismaClientValidationError

  /**
   * Re-export of sql-template-tag
   */
  export import sql = runtime.sqltag
  export import empty = runtime.empty
  export import join = runtime.join
  export import raw = runtime.raw
  export import Sql = runtime.Sql



  /**
   * Decimal.js
   */
  export import Decimal = runtime.Decimal

  export type DecimalJsLike = runtime.DecimalJsLike

  /**
  * Extensions
  */
  export import Extension = $Extensions.UserArgs
  export import getExtensionContext = runtime.Extensions.getExtensionContext
  export import Args = $Public.Args
  export import Payload = $Public.Payload
  export import Result = $Public.Result
  export import Exact = $Public.Exact

  /**
   * Prisma Client JS version: 7.5.0
   * Query Engine version: 280c870be64f457428992c43c1f6d557fab6e29e
   */
  export type PrismaVersion = {
    client: string
    engine: string
  }

  export const prismaVersion: PrismaVersion

  /**
   * Utility Types
   */


  export import Bytes = runtime.Bytes
  export import JsonObject = runtime.JsonObject
  export import JsonArray = runtime.JsonArray
  export import JsonValue = runtime.JsonValue
  export import InputJsonObject = runtime.InputJsonObject
  export import InputJsonArray = runtime.InputJsonArray
  export import InputJsonValue = runtime.InputJsonValue

  /**
   * Types of the values used to represent different kinds of `null` values when working with JSON fields.
   *
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  namespace NullTypes {
    /**
    * Type of `Prisma.DbNull`.
    *
    * You cannot use other instances of this class. Please use the `Prisma.DbNull` value.
    *
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class DbNull {
      private DbNull: never
      private constructor()
    }

    /**
    * Type of `Prisma.JsonNull`.
    *
    * You cannot use other instances of this class. Please use the `Prisma.JsonNull` value.
    *
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class JsonNull {
      private JsonNull: never
      private constructor()
    }

    /**
    * Type of `Prisma.AnyNull`.
    *
    * You cannot use other instances of this class. Please use the `Prisma.AnyNull` value.
    *
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class AnyNull {
      private AnyNull: never
      private constructor()
    }
  }

  /**
   * Helper for filtering JSON entries that have `null` on the database (empty on the db)
   *
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const DbNull: NullTypes.DbNull

  /**
   * Helper for filtering JSON entries that have JSON `null` values (not empty on the db)
   *
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const JsonNull: NullTypes.JsonNull

  /**
   * Helper for filtering JSON entries that are `Prisma.DbNull` or `Prisma.JsonNull`
   *
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const AnyNull: NullTypes.AnyNull

  type SelectAndInclude = {
    select: any
    include: any
  }

  type SelectAndOmit = {
    select: any
    omit: any
  }

  /**
   * Get the type of the value, that the Promise holds.
   */
  export type PromiseType<T extends PromiseLike<any>> = T extends PromiseLike<infer U> ? U : T;

  /**
   * Get the return type of a function which returns a Promise.
   */
  export type PromiseReturnType<T extends (...args: any) => $Utils.JsPromise<any>> = PromiseType<ReturnType<T>>

  /**
   * From T, pick a set of properties whose keys are in the union K
   */
  type Prisma__Pick<T, K extends keyof T> = {
      [P in K]: T[P];
  };


  export type Enumerable<T> = T | Array<T>;

  export type RequiredKeys<T> = {
    [K in keyof T]-?: {} extends Prisma__Pick<T, K> ? never : K
  }[keyof T]

  export type TruthyKeys<T> = keyof {
    [K in keyof T as T[K] extends false | undefined | null ? never : K]: K
  }

  export type TrueKeys<T> = TruthyKeys<Prisma__Pick<T, RequiredKeys<T>>>

  /**
   * Subset
   * @desc From `T` pick properties that exist in `U`. Simple version of Intersection
   */
  export type Subset<T, U> = {
    [key in keyof T]: key extends keyof U ? T[key] : never;
  };

  /**
   * SelectSubset
   * @desc From `T` pick properties that exist in `U`. Simple version of Intersection.
   * Additionally, it validates, if both select and include are present. If the case, it errors.
   */
  export type SelectSubset<T, U> = {
    [key in keyof T]: key extends keyof U ? T[key] : never
  } &
    (T extends SelectAndInclude
      ? 'Please either choose `select` or `include`.'
      : T extends SelectAndOmit
        ? 'Please either choose `select` or `omit`.'
        : {})

  /**
   * Subset + Intersection
   * @desc From `T` pick properties that exist in `U` and intersect `K`
   */
  export type SubsetIntersection<T, U, K> = {
    [key in keyof T]: key extends keyof U ? T[key] : never
  } &
    K

  type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };

  /**
   * XOR is needed to have a real mutually exclusive union type
   * https://stackoverflow.com/questions/42123407/does-typescript-support-mutually-exclusive-types
   */
  type XOR<T, U> =
    T extends object ?
    U extends object ?
      (Without<T, U> & U) | (Without<U, T> & T)
    : U : T


  /**
   * Is T a Record?
   */
  type IsObject<T extends any> = T extends Array<any>
  ? False
  : T extends Date
  ? False
  : T extends Uint8Array
  ? False
  : T extends BigInt
  ? False
  : T extends object
  ? True
  : False


  /**
   * If it's T[], return T
   */
  export type UnEnumerate<T extends unknown> = T extends Array<infer U> ? U : T

  /**
   * From ts-toolbelt
   */

  type __Either<O extends object, K extends Key> = Omit<O, K> &
    {
      // Merge all but K
      [P in K]: Prisma__Pick<O, P & keyof O> // With K possibilities
    }[K]

  type EitherStrict<O extends object, K extends Key> = Strict<__Either<O, K>>

  type EitherLoose<O extends object, K extends Key> = ComputeRaw<__Either<O, K>>

  type _Either<
    O extends object,
    K extends Key,
    strict extends Boolean
  > = {
    1: EitherStrict<O, K>
    0: EitherLoose<O, K>
  }[strict]

  type Either<
    O extends object,
    K extends Key,
    strict extends Boolean = 1
  > = O extends unknown ? _Either<O, K, strict> : never

  export type Union = any

  type PatchUndefined<O extends object, O1 extends object> = {
    [K in keyof O]: O[K] extends undefined ? At<O1, K> : O[K]
  } & {}

  /** Helper Types for "Merge" **/
  export type IntersectOf<U extends Union> = (
    U extends unknown ? (k: U) => void : never
  ) extends (k: infer I) => void
    ? I
    : never

  export type Overwrite<O extends object, O1 extends object> = {
      [K in keyof O]: K extends keyof O1 ? O1[K] : O[K];
  } & {};

  type _Merge<U extends object> = IntersectOf<Overwrite<U, {
      [K in keyof U]-?: At<U, K>;
  }>>;

  type Key = string | number | symbol;
  type AtBasic<O extends object, K extends Key> = K extends keyof O ? O[K] : never;
  type AtStrict<O extends object, K extends Key> = O[K & keyof O];
  type AtLoose<O extends object, K extends Key> = O extends unknown ? AtStrict<O, K> : never;
  export type At<O extends object, K extends Key, strict extends Boolean = 1> = {
      1: AtStrict<O, K>;
      0: AtLoose<O, K>;
  }[strict];

  export type ComputeRaw<A extends any> = A extends Function ? A : {
    [K in keyof A]: A[K];
  } & {};

  export type OptionalFlat<O> = {
    [K in keyof O]?: O[K];
  } & {};

  type _Record<K extends keyof any, T> = {
    [P in K]: T;
  };

  // cause typescript not to expand types and preserve names
  type NoExpand<T> = T extends unknown ? T : never;

  // this type assumes the passed object is entirely optional
  type AtLeast<O extends object, K extends string> = NoExpand<
    O extends unknown
    ? | (K extends keyof O ? { [P in K]: O[P] } & O : O)
      | {[P in keyof O as P extends K ? P : never]-?: O[P]} & O
    : never>;

  type _Strict<U, _U = U> = U extends unknown ? U & OptionalFlat<_Record<Exclude<Keys<_U>, keyof U>, never>> : never;

  export type Strict<U extends object> = ComputeRaw<_Strict<U>>;
  /** End Helper Types for "Merge" **/

  export type Merge<U extends object> = ComputeRaw<_Merge<Strict<U>>>;

  /**
  A [[Boolean]]
  */
  export type Boolean = True | False

  // /**
  // 1
  // */
  export type True = 1

  /**
  0
  */
  export type False = 0

  export type Not<B extends Boolean> = {
    0: 1
    1: 0
  }[B]

  export type Extends<A1 extends any, A2 extends any> = [A1] extends [never]
    ? 0 // anything `never` is false
    : A1 extends A2
    ? 1
    : 0

  export type Has<U extends Union, U1 extends Union> = Not<
    Extends<Exclude<U1, U>, U1>
  >

  export type Or<B1 extends Boolean, B2 extends Boolean> = {
    0: {
      0: 0
      1: 1
    }
    1: {
      0: 1
      1: 1
    }
  }[B1][B2]

  export type Keys<U extends Union> = U extends unknown ? keyof U : never

  type Cast<A, B> = A extends B ? A : B;

  export const type: unique symbol;



  /**
   * Used by group by
   */

  export type GetScalarType<T, O> = O extends object ? {
    [P in keyof T]: P extends keyof O
      ? O[P]
      : never
  } : never

  type FieldPaths<
    T,
    U = Omit<T, '_avg' | '_sum' | '_count' | '_min' | '_max'>
  > = IsObject<T> extends True ? U : T

  type GetHavingFields<T> = {
    [K in keyof T]: Or<
      Or<Extends<'OR', K>, Extends<'AND', K>>,
      Extends<'NOT', K>
    > extends True
      ? // infer is only needed to not hit TS limit
        // based on the brilliant idea of Pierre-Antoine Mills
        // https://github.com/microsoft/TypeScript/issues/30188#issuecomment-478938437
        T[K] extends infer TK
        ? GetHavingFields<UnEnumerate<TK> extends object ? Merge<UnEnumerate<TK>> : never>
        : never
      : {} extends FieldPaths<T[K]>
      ? never
      : K
  }[keyof T]

  /**
   * Convert tuple to union
   */
  type _TupleToUnion<T> = T extends (infer E)[] ? E : never
  type TupleToUnion<K extends readonly any[]> = _TupleToUnion<K>
  type MaybeTupleToUnion<T> = T extends any[] ? TupleToUnion<T> : T

  /**
   * Like `Pick`, but additionally can also accept an array of keys
   */
  type PickEnumerable<T, K extends Enumerable<keyof T> | keyof T> = Prisma__Pick<T, MaybeTupleToUnion<K>>

  /**
   * Exclude all keys with underscores
   */
  type ExcludeUnderscoreKeys<T extends string> = T extends `_${string}` ? never : T


  export type FieldRef<Model, FieldType> = runtime.FieldRef<Model, FieldType>

  type FieldRefInputType<Model, FieldType> = Model extends never ? never : FieldRef<Model, FieldType>


  export const ModelName: {
    BillingPlan: 'BillingPlan',
    BillingPlanQuota: 'BillingPlanQuota',
    BillingSubscription: 'BillingSubscription',
    BillingPayment: 'BillingPayment',
    BillingInvoice: 'BillingInvoice',
    BillingQuotaUsage: 'BillingQuotaUsage',
    ModuleSubscription: 'ModuleSubscription',
    AccountStateChange: 'AccountStateChange',
    BillingProcessedMessage: 'BillingProcessedMessage',
    BillingEventOutbox: 'BillingEventOutbox'
  };

  export type ModelName = (typeof ModelName)[keyof typeof ModelName]



  interface TypeMapCb<ClientOptions = {}> extends $Utils.Fn<{extArgs: $Extensions.InternalArgs }, $Utils.Record<string, any>> {
    returns: Prisma.TypeMap<this['params']['extArgs'], ClientOptions extends { omit: infer OmitOptions } ? OmitOptions : {}>
  }

  export type TypeMap<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> = {
    globalOmitOptions: {
      omit: GlobalOmitOptions
    }
    meta: {
      modelProps: "billingPlan" | "billingPlanQuota" | "billingSubscription" | "billingPayment" | "billingInvoice" | "billingQuotaUsage" | "moduleSubscription" | "accountStateChange" | "billingProcessedMessage" | "billingEventOutbox"
      txIsolationLevel: Prisma.TransactionIsolationLevel
    }
    model: {
      BillingPlan: {
        payload: Prisma.$BillingPlanPayload<ExtArgs>
        fields: Prisma.BillingPlanFieldRefs
        operations: {
          findUnique: {
            args: Prisma.BillingPlanFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.BillingPlanFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>
          }
          findFirst: {
            args: Prisma.BillingPlanFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.BillingPlanFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>
          }
          findMany: {
            args: Prisma.BillingPlanFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>[]
          }
          create: {
            args: Prisma.BillingPlanCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>
          }
          createMany: {
            args: Prisma.BillingPlanCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.BillingPlanCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>[]
          }
          delete: {
            args: Prisma.BillingPlanDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>
          }
          update: {
            args: Prisma.BillingPlanUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>
          }
          deleteMany: {
            args: Prisma.BillingPlanDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.BillingPlanUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.BillingPlanUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>[]
          }
          upsert: {
            args: Prisma.BillingPlanUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanPayload>
          }
          aggregate: {
            args: Prisma.BillingPlanAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateBillingPlan>
          }
          groupBy: {
            args: Prisma.BillingPlanGroupByArgs<ExtArgs>
            result: $Utils.Optional<BillingPlanGroupByOutputType>[]
          }
          count: {
            args: Prisma.BillingPlanCountArgs<ExtArgs>
            result: $Utils.Optional<BillingPlanCountAggregateOutputType> | number
          }
        }
      }
      BillingPlanQuota: {
        payload: Prisma.$BillingPlanQuotaPayload<ExtArgs>
        fields: Prisma.BillingPlanQuotaFieldRefs
        operations: {
          findUnique: {
            args: Prisma.BillingPlanQuotaFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.BillingPlanQuotaFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>
          }
          findFirst: {
            args: Prisma.BillingPlanQuotaFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.BillingPlanQuotaFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>
          }
          findMany: {
            args: Prisma.BillingPlanQuotaFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>[]
          }
          create: {
            args: Prisma.BillingPlanQuotaCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>
          }
          createMany: {
            args: Prisma.BillingPlanQuotaCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.BillingPlanQuotaCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>[]
          }
          delete: {
            args: Prisma.BillingPlanQuotaDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>
          }
          update: {
            args: Prisma.BillingPlanQuotaUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>
          }
          deleteMany: {
            args: Prisma.BillingPlanQuotaDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.BillingPlanQuotaUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.BillingPlanQuotaUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>[]
          }
          upsert: {
            args: Prisma.BillingPlanQuotaUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPlanQuotaPayload>
          }
          aggregate: {
            args: Prisma.BillingPlanQuotaAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateBillingPlanQuota>
          }
          groupBy: {
            args: Prisma.BillingPlanQuotaGroupByArgs<ExtArgs>
            result: $Utils.Optional<BillingPlanQuotaGroupByOutputType>[]
          }
          count: {
            args: Prisma.BillingPlanQuotaCountArgs<ExtArgs>
            result: $Utils.Optional<BillingPlanQuotaCountAggregateOutputType> | number
          }
        }
      }
      BillingSubscription: {
        payload: Prisma.$BillingSubscriptionPayload<ExtArgs>
        fields: Prisma.BillingSubscriptionFieldRefs
        operations: {
          findUnique: {
            args: Prisma.BillingSubscriptionFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.BillingSubscriptionFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>
          }
          findFirst: {
            args: Prisma.BillingSubscriptionFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.BillingSubscriptionFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>
          }
          findMany: {
            args: Prisma.BillingSubscriptionFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>[]
          }
          create: {
            args: Prisma.BillingSubscriptionCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>
          }
          createMany: {
            args: Prisma.BillingSubscriptionCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.BillingSubscriptionCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>[]
          }
          delete: {
            args: Prisma.BillingSubscriptionDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>
          }
          update: {
            args: Prisma.BillingSubscriptionUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>
          }
          deleteMany: {
            args: Prisma.BillingSubscriptionDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.BillingSubscriptionUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.BillingSubscriptionUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>[]
          }
          upsert: {
            args: Prisma.BillingSubscriptionUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingSubscriptionPayload>
          }
          aggregate: {
            args: Prisma.BillingSubscriptionAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateBillingSubscription>
          }
          groupBy: {
            args: Prisma.BillingSubscriptionGroupByArgs<ExtArgs>
            result: $Utils.Optional<BillingSubscriptionGroupByOutputType>[]
          }
          count: {
            args: Prisma.BillingSubscriptionCountArgs<ExtArgs>
            result: $Utils.Optional<BillingSubscriptionCountAggregateOutputType> | number
          }
        }
      }
      BillingPayment: {
        payload: Prisma.$BillingPaymentPayload<ExtArgs>
        fields: Prisma.BillingPaymentFieldRefs
        operations: {
          findUnique: {
            args: Prisma.BillingPaymentFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.BillingPaymentFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>
          }
          findFirst: {
            args: Prisma.BillingPaymentFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.BillingPaymentFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>
          }
          findMany: {
            args: Prisma.BillingPaymentFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>[]
          }
          create: {
            args: Prisma.BillingPaymentCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>
          }
          createMany: {
            args: Prisma.BillingPaymentCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.BillingPaymentCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>[]
          }
          delete: {
            args: Prisma.BillingPaymentDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>
          }
          update: {
            args: Prisma.BillingPaymentUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>
          }
          deleteMany: {
            args: Prisma.BillingPaymentDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.BillingPaymentUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.BillingPaymentUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>[]
          }
          upsert: {
            args: Prisma.BillingPaymentUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingPaymentPayload>
          }
          aggregate: {
            args: Prisma.BillingPaymentAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateBillingPayment>
          }
          groupBy: {
            args: Prisma.BillingPaymentGroupByArgs<ExtArgs>
            result: $Utils.Optional<BillingPaymentGroupByOutputType>[]
          }
          count: {
            args: Prisma.BillingPaymentCountArgs<ExtArgs>
            result: $Utils.Optional<BillingPaymentCountAggregateOutputType> | number
          }
        }
      }
      BillingInvoice: {
        payload: Prisma.$BillingInvoicePayload<ExtArgs>
        fields: Prisma.BillingInvoiceFieldRefs
        operations: {
          findUnique: {
            args: Prisma.BillingInvoiceFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.BillingInvoiceFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>
          }
          findFirst: {
            args: Prisma.BillingInvoiceFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.BillingInvoiceFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>
          }
          findMany: {
            args: Prisma.BillingInvoiceFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>[]
          }
          create: {
            args: Prisma.BillingInvoiceCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>
          }
          createMany: {
            args: Prisma.BillingInvoiceCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.BillingInvoiceCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>[]
          }
          delete: {
            args: Prisma.BillingInvoiceDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>
          }
          update: {
            args: Prisma.BillingInvoiceUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>
          }
          deleteMany: {
            args: Prisma.BillingInvoiceDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.BillingInvoiceUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.BillingInvoiceUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>[]
          }
          upsert: {
            args: Prisma.BillingInvoiceUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingInvoicePayload>
          }
          aggregate: {
            args: Prisma.BillingInvoiceAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateBillingInvoice>
          }
          groupBy: {
            args: Prisma.BillingInvoiceGroupByArgs<ExtArgs>
            result: $Utils.Optional<BillingInvoiceGroupByOutputType>[]
          }
          count: {
            args: Prisma.BillingInvoiceCountArgs<ExtArgs>
            result: $Utils.Optional<BillingInvoiceCountAggregateOutputType> | number
          }
        }
      }
      BillingQuotaUsage: {
        payload: Prisma.$BillingQuotaUsagePayload<ExtArgs>
        fields: Prisma.BillingQuotaUsageFieldRefs
        operations: {
          findUnique: {
            args: Prisma.BillingQuotaUsageFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.BillingQuotaUsageFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>
          }
          findFirst: {
            args: Prisma.BillingQuotaUsageFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.BillingQuotaUsageFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>
          }
          findMany: {
            args: Prisma.BillingQuotaUsageFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>[]
          }
          create: {
            args: Prisma.BillingQuotaUsageCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>
          }
          createMany: {
            args: Prisma.BillingQuotaUsageCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.BillingQuotaUsageCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>[]
          }
          delete: {
            args: Prisma.BillingQuotaUsageDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>
          }
          update: {
            args: Prisma.BillingQuotaUsageUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>
          }
          deleteMany: {
            args: Prisma.BillingQuotaUsageDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.BillingQuotaUsageUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.BillingQuotaUsageUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>[]
          }
          upsert: {
            args: Prisma.BillingQuotaUsageUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingQuotaUsagePayload>
          }
          aggregate: {
            args: Prisma.BillingQuotaUsageAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateBillingQuotaUsage>
          }
          groupBy: {
            args: Prisma.BillingQuotaUsageGroupByArgs<ExtArgs>
            result: $Utils.Optional<BillingQuotaUsageGroupByOutputType>[]
          }
          count: {
            args: Prisma.BillingQuotaUsageCountArgs<ExtArgs>
            result: $Utils.Optional<BillingQuotaUsageCountAggregateOutputType> | number
          }
        }
      }
      ModuleSubscription: {
        payload: Prisma.$ModuleSubscriptionPayload<ExtArgs>
        fields: Prisma.ModuleSubscriptionFieldRefs
        operations: {
          findUnique: {
            args: Prisma.ModuleSubscriptionFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.ModuleSubscriptionFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>
          }
          findFirst: {
            args: Prisma.ModuleSubscriptionFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.ModuleSubscriptionFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>
          }
          findMany: {
            args: Prisma.ModuleSubscriptionFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>[]
          }
          create: {
            args: Prisma.ModuleSubscriptionCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>
          }
          createMany: {
            args: Prisma.ModuleSubscriptionCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.ModuleSubscriptionCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>[]
          }
          delete: {
            args: Prisma.ModuleSubscriptionDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>
          }
          update: {
            args: Prisma.ModuleSubscriptionUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>
          }
          deleteMany: {
            args: Prisma.ModuleSubscriptionDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.ModuleSubscriptionUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.ModuleSubscriptionUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>[]
          }
          upsert: {
            args: Prisma.ModuleSubscriptionUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$ModuleSubscriptionPayload>
          }
          aggregate: {
            args: Prisma.ModuleSubscriptionAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateModuleSubscription>
          }
          groupBy: {
            args: Prisma.ModuleSubscriptionGroupByArgs<ExtArgs>
            result: $Utils.Optional<ModuleSubscriptionGroupByOutputType>[]
          }
          count: {
            args: Prisma.ModuleSubscriptionCountArgs<ExtArgs>
            result: $Utils.Optional<ModuleSubscriptionCountAggregateOutputType> | number
          }
        }
      }
      AccountStateChange: {
        payload: Prisma.$AccountStateChangePayload<ExtArgs>
        fields: Prisma.AccountStateChangeFieldRefs
        operations: {
          findUnique: {
            args: Prisma.AccountStateChangeFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.AccountStateChangeFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>
          }
          findFirst: {
            args: Prisma.AccountStateChangeFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.AccountStateChangeFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>
          }
          findMany: {
            args: Prisma.AccountStateChangeFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>[]
          }
          create: {
            args: Prisma.AccountStateChangeCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>
          }
          createMany: {
            args: Prisma.AccountStateChangeCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.AccountStateChangeCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>[]
          }
          delete: {
            args: Prisma.AccountStateChangeDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>
          }
          update: {
            args: Prisma.AccountStateChangeUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>
          }
          deleteMany: {
            args: Prisma.AccountStateChangeDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.AccountStateChangeUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.AccountStateChangeUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>[]
          }
          upsert: {
            args: Prisma.AccountStateChangeUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$AccountStateChangePayload>
          }
          aggregate: {
            args: Prisma.AccountStateChangeAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateAccountStateChange>
          }
          groupBy: {
            args: Prisma.AccountStateChangeGroupByArgs<ExtArgs>
            result: $Utils.Optional<AccountStateChangeGroupByOutputType>[]
          }
          count: {
            args: Prisma.AccountStateChangeCountArgs<ExtArgs>
            result: $Utils.Optional<AccountStateChangeCountAggregateOutputType> | number
          }
        }
      }
      BillingProcessedMessage: {
        payload: Prisma.$BillingProcessedMessagePayload<ExtArgs>
        fields: Prisma.BillingProcessedMessageFieldRefs
        operations: {
          findUnique: {
            args: Prisma.BillingProcessedMessageFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.BillingProcessedMessageFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>
          }
          findFirst: {
            args: Prisma.BillingProcessedMessageFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.BillingProcessedMessageFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>
          }
          findMany: {
            args: Prisma.BillingProcessedMessageFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>[]
          }
          create: {
            args: Prisma.BillingProcessedMessageCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>
          }
          createMany: {
            args: Prisma.BillingProcessedMessageCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.BillingProcessedMessageCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>[]
          }
          delete: {
            args: Prisma.BillingProcessedMessageDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>
          }
          update: {
            args: Prisma.BillingProcessedMessageUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>
          }
          deleteMany: {
            args: Prisma.BillingProcessedMessageDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.BillingProcessedMessageUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.BillingProcessedMessageUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>[]
          }
          upsert: {
            args: Prisma.BillingProcessedMessageUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingProcessedMessagePayload>
          }
          aggregate: {
            args: Prisma.BillingProcessedMessageAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateBillingProcessedMessage>
          }
          groupBy: {
            args: Prisma.BillingProcessedMessageGroupByArgs<ExtArgs>
            result: $Utils.Optional<BillingProcessedMessageGroupByOutputType>[]
          }
          count: {
            args: Prisma.BillingProcessedMessageCountArgs<ExtArgs>
            result: $Utils.Optional<BillingProcessedMessageCountAggregateOutputType> | number
          }
        }
      }
      BillingEventOutbox: {
        payload: Prisma.$BillingEventOutboxPayload<ExtArgs>
        fields: Prisma.BillingEventOutboxFieldRefs
        operations: {
          findUnique: {
            args: Prisma.BillingEventOutboxFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.BillingEventOutboxFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>
          }
          findFirst: {
            args: Prisma.BillingEventOutboxFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.BillingEventOutboxFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>
          }
          findMany: {
            args: Prisma.BillingEventOutboxFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>[]
          }
          create: {
            args: Prisma.BillingEventOutboxCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>
          }
          createMany: {
            args: Prisma.BillingEventOutboxCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.BillingEventOutboxCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>[]
          }
          delete: {
            args: Prisma.BillingEventOutboxDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>
          }
          update: {
            args: Prisma.BillingEventOutboxUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>
          }
          deleteMany: {
            args: Prisma.BillingEventOutboxDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.BillingEventOutboxUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.BillingEventOutboxUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>[]
          }
          upsert: {
            args: Prisma.BillingEventOutboxUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$BillingEventOutboxPayload>
          }
          aggregate: {
            args: Prisma.BillingEventOutboxAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateBillingEventOutbox>
          }
          groupBy: {
            args: Prisma.BillingEventOutboxGroupByArgs<ExtArgs>
            result: $Utils.Optional<BillingEventOutboxGroupByOutputType>[]
          }
          count: {
            args: Prisma.BillingEventOutboxCountArgs<ExtArgs>
            result: $Utils.Optional<BillingEventOutboxCountAggregateOutputType> | number
          }
        }
      }
    }
  } & {
    other: {
      payload: any
      operations: {
        $executeRaw: {
          args: [query: TemplateStringsArray | Prisma.Sql, ...values: any[]],
          result: any
        }
        $executeRawUnsafe: {
          args: [query: string, ...values: any[]],
          result: any
        }
        $queryRaw: {
          args: [query: TemplateStringsArray | Prisma.Sql, ...values: any[]],
          result: any
        }
        $queryRawUnsafe: {
          args: [query: string, ...values: any[]],
          result: any
        }
      }
    }
  }
  export const defineExtension: $Extensions.ExtendsHook<"define", Prisma.TypeMapCb, $Extensions.DefaultArgs>
  export type DefaultPrismaClient = PrismaClient
  export type ErrorFormat = 'pretty' | 'colorless' | 'minimal'
  export interface PrismaClientOptions {
    /**
     * @default "colorless"
     */
    errorFormat?: ErrorFormat
    /**
     * @example
     * ```
     * // Shorthand for `emit: 'stdout'`
     * log: ['query', 'info', 'warn', 'error']
     * 
     * // Emit as events only
     * log: [
     *   { emit: 'event', level: 'query' },
     *   { emit: 'event', level: 'info' },
     *   { emit: 'event', level: 'warn' }
     *   { emit: 'event', level: 'error' }
     * ]
     * 
     * / Emit as events and log to stdout
     * og: [
     *  { emit: 'stdout', level: 'query' },
     *  { emit: 'stdout', level: 'info' },
     *  { emit: 'stdout', level: 'warn' }
     *  { emit: 'stdout', level: 'error' }
     * 
     * ```
     * Read more in our [docs](https://pris.ly/d/logging).
     */
    log?: (LogLevel | LogDefinition)[]
    /**
     * The default values for transactionOptions
     * maxWait ?= 2000
     * timeout ?= 5000
     */
    transactionOptions?: {
      maxWait?: number
      timeout?: number
      isolationLevel?: Prisma.TransactionIsolationLevel
    }
    /**
     * Instance of a Driver Adapter, e.g., like one provided by `@prisma/adapter-planetscale`
     */
    adapter?: runtime.SqlDriverAdapterFactory
    /**
     * Prisma Accelerate URL allowing the client to connect through Accelerate instead of a direct database.
     */
    accelerateUrl?: string
    /**
     * Global configuration for omitting model fields by default.
     * 
     * @example
     * ```
     * const prisma = new PrismaClient({
     *   omit: {
     *     user: {
     *       password: true
     *     }
     *   }
     * })
     * ```
     */
    omit?: Prisma.GlobalOmitConfig
    /**
     * SQL commenter plugins that add metadata to SQL queries as comments.
     * Comments follow the sqlcommenter format: https://google.github.io/sqlcommenter/
     * 
     * @example
     * ```
     * const prisma = new PrismaClient({
     *   adapter,
     *   comments: [
     *     traceContext(),
     *     queryInsights(),
     *   ],
     * })
     * ```
     */
    comments?: runtime.SqlCommenterPlugin[]
  }
  export type GlobalOmitConfig = {
    billingPlan?: BillingPlanOmit
    billingPlanQuota?: BillingPlanQuotaOmit
    billingSubscription?: BillingSubscriptionOmit
    billingPayment?: BillingPaymentOmit
    billingInvoice?: BillingInvoiceOmit
    billingQuotaUsage?: BillingQuotaUsageOmit
    moduleSubscription?: ModuleSubscriptionOmit
    accountStateChange?: AccountStateChangeOmit
    billingProcessedMessage?: BillingProcessedMessageOmit
    billingEventOutbox?: BillingEventOutboxOmit
  }

  /* Types for Logging */
  export type LogLevel = 'info' | 'query' | 'warn' | 'error'
  export type LogDefinition = {
    level: LogLevel
    emit: 'stdout' | 'event'
  }

  export type CheckIsLogLevel<T> = T extends LogLevel ? T : never;

  export type GetLogType<T> = CheckIsLogLevel<
    T extends LogDefinition ? T['level'] : T
  >;

  export type GetEvents<T extends any[]> = T extends Array<LogLevel | LogDefinition>
    ? GetLogType<T[number]>
    : never;

  export type QueryEvent = {
    timestamp: Date
    query: string
    params: string
    duration: number
    target: string
  }

  export type LogEvent = {
    timestamp: Date
    message: string
    target: string
  }
  /* End Types for Logging */


  export type PrismaAction =
    | 'findUnique'
    | 'findUniqueOrThrow'
    | 'findMany'
    | 'findFirst'
    | 'findFirstOrThrow'
    | 'create'
    | 'createMany'
    | 'createManyAndReturn'
    | 'update'
    | 'updateMany'
    | 'updateManyAndReturn'
    | 'upsert'
    | 'delete'
    | 'deleteMany'
    | 'executeRaw'
    | 'queryRaw'
    | 'aggregate'
    | 'count'
    | 'runCommandRaw'
    | 'findRaw'
    | 'groupBy'

  // tested in getLogLevel.test.ts
  export function getLogLevel(log: Array<LogLevel | LogDefinition>): LogLevel | undefined;

  /**
   * `PrismaClient` proxy available in interactive transactions.
   */
  export type TransactionClient = Omit<Prisma.DefaultPrismaClient, runtime.ITXClientDenyList>

  export type Datasource = {
    url?: string
  }

  /**
   * Count Types
   */


  /**
   * Count Type BillingPlanCountOutputType
   */

  export type BillingPlanCountOutputType = {
    quotas: number
    subscriptions: number
  }

  export type BillingPlanCountOutputTypeSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    quotas?: boolean | BillingPlanCountOutputTypeCountQuotasArgs
    subscriptions?: boolean | BillingPlanCountOutputTypeCountSubscriptionsArgs
  }

  // Custom InputTypes
  /**
   * BillingPlanCountOutputType without action
   */
  export type BillingPlanCountOutputTypeDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanCountOutputType
     */
    select?: BillingPlanCountOutputTypeSelect<ExtArgs> | null
  }

  /**
   * BillingPlanCountOutputType without action
   */
  export type BillingPlanCountOutputTypeCountQuotasArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingPlanQuotaWhereInput
  }

  /**
   * BillingPlanCountOutputType without action
   */
  export type BillingPlanCountOutputTypeCountSubscriptionsArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingSubscriptionWhereInput
  }


  /**
   * Count Type BillingSubscriptionCountOutputType
   */

  export type BillingSubscriptionCountOutputType = {
    payments: number
    invoices: number
  }

  export type BillingSubscriptionCountOutputTypeSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    payments?: boolean | BillingSubscriptionCountOutputTypeCountPaymentsArgs
    invoices?: boolean | BillingSubscriptionCountOutputTypeCountInvoicesArgs
  }

  // Custom InputTypes
  /**
   * BillingSubscriptionCountOutputType without action
   */
  export type BillingSubscriptionCountOutputTypeDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscriptionCountOutputType
     */
    select?: BillingSubscriptionCountOutputTypeSelect<ExtArgs> | null
  }

  /**
   * BillingSubscriptionCountOutputType without action
   */
  export type BillingSubscriptionCountOutputTypeCountPaymentsArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingPaymentWhereInput
  }

  /**
   * BillingSubscriptionCountOutputType without action
   */
  export type BillingSubscriptionCountOutputTypeCountInvoicesArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingInvoiceWhereInput
  }


  /**
   * Models
   */

  /**
   * Model BillingPlan
   */

  export type AggregateBillingPlan = {
    _count: BillingPlanCountAggregateOutputType | null
    _avg: BillingPlanAvgAggregateOutputType | null
    _sum: BillingPlanSumAggregateOutputType | null
    _min: BillingPlanMinAggregateOutputType | null
    _max: BillingPlanMaxAggregateOutputType | null
  }

  export type BillingPlanAvgAggregateOutputType = {
    priceMinor: number | null
  }

  export type BillingPlanSumAggregateOutputType = {
    priceMinor: bigint | null
  }

  export type BillingPlanMinAggregateOutputType = {
    id: string | null
    code: string | null
    name: string | null
    description: string | null
    priceMinor: bigint | null
    currency: string | null
    billingPeriod: string | null
    isActive: boolean | null
    createdAt: Date | null
    updatedAt: Date | null
  }

  export type BillingPlanMaxAggregateOutputType = {
    id: string | null
    code: string | null
    name: string | null
    description: string | null
    priceMinor: bigint | null
    currency: string | null
    billingPeriod: string | null
    isActive: boolean | null
    createdAt: Date | null
    updatedAt: Date | null
  }

  export type BillingPlanCountAggregateOutputType = {
    id: number
    code: number
    name: number
    description: number
    priceMinor: number
    currency: number
    billingPeriod: number
    isActive: number
    createdAt: number
    updatedAt: number
    _all: number
  }


  export type BillingPlanAvgAggregateInputType = {
    priceMinor?: true
  }

  export type BillingPlanSumAggregateInputType = {
    priceMinor?: true
  }

  export type BillingPlanMinAggregateInputType = {
    id?: true
    code?: true
    name?: true
    description?: true
    priceMinor?: true
    currency?: true
    billingPeriod?: true
    isActive?: true
    createdAt?: true
    updatedAt?: true
  }

  export type BillingPlanMaxAggregateInputType = {
    id?: true
    code?: true
    name?: true
    description?: true
    priceMinor?: true
    currency?: true
    billingPeriod?: true
    isActive?: true
    createdAt?: true
    updatedAt?: true
  }

  export type BillingPlanCountAggregateInputType = {
    id?: true
    code?: true
    name?: true
    description?: true
    priceMinor?: true
    currency?: true
    billingPeriod?: true
    isActive?: true
    createdAt?: true
    updatedAt?: true
    _all?: true
  }

  export type BillingPlanAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingPlan to aggregate.
     */
    where?: BillingPlanWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPlans to fetch.
     */
    orderBy?: BillingPlanOrderByWithRelationInput | BillingPlanOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: BillingPlanWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPlans from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPlans.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned BillingPlans
    **/
    _count?: true | BillingPlanCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: BillingPlanAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: BillingPlanSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: BillingPlanMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: BillingPlanMaxAggregateInputType
  }

  export type GetBillingPlanAggregateType<T extends BillingPlanAggregateArgs> = {
        [P in keyof T & keyof AggregateBillingPlan]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateBillingPlan[P]>
      : GetScalarType<T[P], AggregateBillingPlan[P]>
  }




  export type BillingPlanGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingPlanWhereInput
    orderBy?: BillingPlanOrderByWithAggregationInput | BillingPlanOrderByWithAggregationInput[]
    by: BillingPlanScalarFieldEnum[] | BillingPlanScalarFieldEnum
    having?: BillingPlanScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: BillingPlanCountAggregateInputType | true
    _avg?: BillingPlanAvgAggregateInputType
    _sum?: BillingPlanSumAggregateInputType
    _min?: BillingPlanMinAggregateInputType
    _max?: BillingPlanMaxAggregateInputType
  }

  export type BillingPlanGroupByOutputType = {
    id: string
    code: string
    name: string
    description: string | null
    priceMinor: bigint
    currency: string
    billingPeriod: string
    isActive: boolean
    createdAt: Date
    updatedAt: Date
    _count: BillingPlanCountAggregateOutputType | null
    _avg: BillingPlanAvgAggregateOutputType | null
    _sum: BillingPlanSumAggregateOutputType | null
    _min: BillingPlanMinAggregateOutputType | null
    _max: BillingPlanMaxAggregateOutputType | null
  }

  type GetBillingPlanGroupByPayload<T extends BillingPlanGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<BillingPlanGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof BillingPlanGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], BillingPlanGroupByOutputType[P]>
            : GetScalarType<T[P], BillingPlanGroupByOutputType[P]>
        }
      >
    >


  export type BillingPlanSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    code?: boolean
    name?: boolean
    description?: boolean
    priceMinor?: boolean
    currency?: boolean
    billingPeriod?: boolean
    isActive?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    quotas?: boolean | BillingPlan$quotasArgs<ExtArgs>
    subscriptions?: boolean | BillingPlan$subscriptionsArgs<ExtArgs>
    _count?: boolean | BillingPlanCountOutputTypeDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingPlan"]>

  export type BillingPlanSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    code?: boolean
    name?: boolean
    description?: boolean
    priceMinor?: boolean
    currency?: boolean
    billingPeriod?: boolean
    isActive?: boolean
    createdAt?: boolean
    updatedAt?: boolean
  }, ExtArgs["result"]["billingPlan"]>

  export type BillingPlanSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    code?: boolean
    name?: boolean
    description?: boolean
    priceMinor?: boolean
    currency?: boolean
    billingPeriod?: boolean
    isActive?: boolean
    createdAt?: boolean
    updatedAt?: boolean
  }, ExtArgs["result"]["billingPlan"]>

  export type BillingPlanSelectScalar = {
    id?: boolean
    code?: boolean
    name?: boolean
    description?: boolean
    priceMinor?: boolean
    currency?: boolean
    billingPeriod?: boolean
    isActive?: boolean
    createdAt?: boolean
    updatedAt?: boolean
  }

  export type BillingPlanOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"id" | "code" | "name" | "description" | "priceMinor" | "currency" | "billingPeriod" | "isActive" | "createdAt" | "updatedAt", ExtArgs["result"]["billingPlan"]>
  export type BillingPlanInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    quotas?: boolean | BillingPlan$quotasArgs<ExtArgs>
    subscriptions?: boolean | BillingPlan$subscriptionsArgs<ExtArgs>
    _count?: boolean | BillingPlanCountOutputTypeDefaultArgs<ExtArgs>
  }
  export type BillingPlanIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {}
  export type BillingPlanIncludeUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {}

  export type $BillingPlanPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "BillingPlan"
    objects: {
      quotas: Prisma.$BillingPlanQuotaPayload<ExtArgs>[]
      subscriptions: Prisma.$BillingSubscriptionPayload<ExtArgs>[]
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      code: string
      name: string
      description: string | null
      priceMinor: bigint
      currency: string
      billingPeriod: string
      isActive: boolean
      createdAt: Date
      updatedAt: Date
    }, ExtArgs["result"]["billingPlan"]>
    composites: {}
  }

  type BillingPlanGetPayload<S extends boolean | null | undefined | BillingPlanDefaultArgs> = $Result.GetResult<Prisma.$BillingPlanPayload, S>

  type BillingPlanCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<BillingPlanFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: BillingPlanCountAggregateInputType | true
    }

  export interface BillingPlanDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['BillingPlan'], meta: { name: 'BillingPlan' } }
    /**
     * Find zero or one BillingPlan that matches the filter.
     * @param {BillingPlanFindUniqueArgs} args - Arguments to find a BillingPlan
     * @example
     * // Get one BillingPlan
     * const billingPlan = await prisma.billingPlan.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends BillingPlanFindUniqueArgs>(args: SelectSubset<T, BillingPlanFindUniqueArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one BillingPlan that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {BillingPlanFindUniqueOrThrowArgs} args - Arguments to find a BillingPlan
     * @example
     * // Get one BillingPlan
     * const billingPlan = await prisma.billingPlan.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends BillingPlanFindUniqueOrThrowArgs>(args: SelectSubset<T, BillingPlanFindUniqueOrThrowArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingPlan that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanFindFirstArgs} args - Arguments to find a BillingPlan
     * @example
     * // Get one BillingPlan
     * const billingPlan = await prisma.billingPlan.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends BillingPlanFindFirstArgs>(args?: SelectSubset<T, BillingPlanFindFirstArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingPlan that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanFindFirstOrThrowArgs} args - Arguments to find a BillingPlan
     * @example
     * // Get one BillingPlan
     * const billingPlan = await prisma.billingPlan.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends BillingPlanFindFirstOrThrowArgs>(args?: SelectSubset<T, BillingPlanFindFirstOrThrowArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more BillingPlans that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all BillingPlans
     * const billingPlans = await prisma.billingPlan.findMany()
     * 
     * // Get first 10 BillingPlans
     * const billingPlans = await prisma.billingPlan.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const billingPlanWithIdOnly = await prisma.billingPlan.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends BillingPlanFindManyArgs>(args?: SelectSubset<T, BillingPlanFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a BillingPlan.
     * @param {BillingPlanCreateArgs} args - Arguments to create a BillingPlan.
     * @example
     * // Create one BillingPlan
     * const BillingPlan = await prisma.billingPlan.create({
     *   data: {
     *     // ... data to create a BillingPlan
     *   }
     * })
     * 
     */
    create<T extends BillingPlanCreateArgs>(args: SelectSubset<T, BillingPlanCreateArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many BillingPlans.
     * @param {BillingPlanCreateManyArgs} args - Arguments to create many BillingPlans.
     * @example
     * // Create many BillingPlans
     * const billingPlan = await prisma.billingPlan.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends BillingPlanCreateManyArgs>(args?: SelectSubset<T, BillingPlanCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many BillingPlans and returns the data saved in the database.
     * @param {BillingPlanCreateManyAndReturnArgs} args - Arguments to create many BillingPlans.
     * @example
     * // Create many BillingPlans
     * const billingPlan = await prisma.billingPlan.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many BillingPlans and only return the `id`
     * const billingPlanWithIdOnly = await prisma.billingPlan.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends BillingPlanCreateManyAndReturnArgs>(args?: SelectSubset<T, BillingPlanCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a BillingPlan.
     * @param {BillingPlanDeleteArgs} args - Arguments to delete one BillingPlan.
     * @example
     * // Delete one BillingPlan
     * const BillingPlan = await prisma.billingPlan.delete({
     *   where: {
     *     // ... filter to delete one BillingPlan
     *   }
     * })
     * 
     */
    delete<T extends BillingPlanDeleteArgs>(args: SelectSubset<T, BillingPlanDeleteArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one BillingPlan.
     * @param {BillingPlanUpdateArgs} args - Arguments to update one BillingPlan.
     * @example
     * // Update one BillingPlan
     * const billingPlan = await prisma.billingPlan.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends BillingPlanUpdateArgs>(args: SelectSubset<T, BillingPlanUpdateArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more BillingPlans.
     * @param {BillingPlanDeleteManyArgs} args - Arguments to filter BillingPlans to delete.
     * @example
     * // Delete a few BillingPlans
     * const { count } = await prisma.billingPlan.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends BillingPlanDeleteManyArgs>(args?: SelectSubset<T, BillingPlanDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingPlans.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many BillingPlans
     * const billingPlan = await prisma.billingPlan.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends BillingPlanUpdateManyArgs>(args: SelectSubset<T, BillingPlanUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingPlans and returns the data updated in the database.
     * @param {BillingPlanUpdateManyAndReturnArgs} args - Arguments to update many BillingPlans.
     * @example
     * // Update many BillingPlans
     * const billingPlan = await prisma.billingPlan.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more BillingPlans and only return the `id`
     * const billingPlanWithIdOnly = await prisma.billingPlan.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends BillingPlanUpdateManyAndReturnArgs>(args: SelectSubset<T, BillingPlanUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one BillingPlan.
     * @param {BillingPlanUpsertArgs} args - Arguments to update or create a BillingPlan.
     * @example
     * // Update or create a BillingPlan
     * const billingPlan = await prisma.billingPlan.upsert({
     *   create: {
     *     // ... data to create a BillingPlan
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the BillingPlan we want to update
     *   }
     * })
     */
    upsert<T extends BillingPlanUpsertArgs>(args: SelectSubset<T, BillingPlanUpsertArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of BillingPlans.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanCountArgs} args - Arguments to filter BillingPlans to count.
     * @example
     * // Count the number of BillingPlans
     * const count = await prisma.billingPlan.count({
     *   where: {
     *     // ... the filter for the BillingPlans we want to count
     *   }
     * })
    **/
    count<T extends BillingPlanCountArgs>(
      args?: Subset<T, BillingPlanCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], BillingPlanCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a BillingPlan.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends BillingPlanAggregateArgs>(args: Subset<T, BillingPlanAggregateArgs>): Prisma.PrismaPromise<GetBillingPlanAggregateType<T>>

    /**
     * Group by BillingPlan.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends BillingPlanGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: BillingPlanGroupByArgs['orderBy'] }
        : { orderBy?: BillingPlanGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, BillingPlanGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetBillingPlanGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the BillingPlan model
   */
  readonly fields: BillingPlanFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for BillingPlan.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__BillingPlanClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    quotas<T extends BillingPlan$quotasArgs<ExtArgs> = {}>(args?: Subset<T, BillingPlan$quotasArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "findMany", GlobalOmitOptions> | Null>
    subscriptions<T extends BillingPlan$subscriptionsArgs<ExtArgs> = {}>(args?: Subset<T, BillingPlan$subscriptionsArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "findMany", GlobalOmitOptions> | Null>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the BillingPlan model
   */
  interface BillingPlanFieldRefs {
    readonly id: FieldRef<"BillingPlan", 'String'>
    readonly code: FieldRef<"BillingPlan", 'String'>
    readonly name: FieldRef<"BillingPlan", 'String'>
    readonly description: FieldRef<"BillingPlan", 'String'>
    readonly priceMinor: FieldRef<"BillingPlan", 'BigInt'>
    readonly currency: FieldRef<"BillingPlan", 'String'>
    readonly billingPeriod: FieldRef<"BillingPlan", 'String'>
    readonly isActive: FieldRef<"BillingPlan", 'Boolean'>
    readonly createdAt: FieldRef<"BillingPlan", 'DateTime'>
    readonly updatedAt: FieldRef<"BillingPlan", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * BillingPlan findUnique
   */
  export type BillingPlanFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlan to fetch.
     */
    where: BillingPlanWhereUniqueInput
  }

  /**
   * BillingPlan findUniqueOrThrow
   */
  export type BillingPlanFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlan to fetch.
     */
    where: BillingPlanWhereUniqueInput
  }

  /**
   * BillingPlan findFirst
   */
  export type BillingPlanFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlan to fetch.
     */
    where?: BillingPlanWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPlans to fetch.
     */
    orderBy?: BillingPlanOrderByWithRelationInput | BillingPlanOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingPlans.
     */
    cursor?: BillingPlanWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPlans from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPlans.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPlans.
     */
    distinct?: BillingPlanScalarFieldEnum | BillingPlanScalarFieldEnum[]
  }

  /**
   * BillingPlan findFirstOrThrow
   */
  export type BillingPlanFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlan to fetch.
     */
    where?: BillingPlanWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPlans to fetch.
     */
    orderBy?: BillingPlanOrderByWithRelationInput | BillingPlanOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingPlans.
     */
    cursor?: BillingPlanWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPlans from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPlans.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPlans.
     */
    distinct?: BillingPlanScalarFieldEnum | BillingPlanScalarFieldEnum[]
  }

  /**
   * BillingPlan findMany
   */
  export type BillingPlanFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlans to fetch.
     */
    where?: BillingPlanWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPlans to fetch.
     */
    orderBy?: BillingPlanOrderByWithRelationInput | BillingPlanOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing BillingPlans.
     */
    cursor?: BillingPlanWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPlans from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPlans.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPlans.
     */
    distinct?: BillingPlanScalarFieldEnum | BillingPlanScalarFieldEnum[]
  }

  /**
   * BillingPlan create
   */
  export type BillingPlanCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * The data needed to create a BillingPlan.
     */
    data: XOR<BillingPlanCreateInput, BillingPlanUncheckedCreateInput>
  }

  /**
   * BillingPlan createMany
   */
  export type BillingPlanCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many BillingPlans.
     */
    data: BillingPlanCreateManyInput | BillingPlanCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingPlan createManyAndReturn
   */
  export type BillingPlanCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * The data used to create many BillingPlans.
     */
    data: BillingPlanCreateManyInput | BillingPlanCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingPlan update
   */
  export type BillingPlanUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * The data needed to update a BillingPlan.
     */
    data: XOR<BillingPlanUpdateInput, BillingPlanUncheckedUpdateInput>
    /**
     * Choose, which BillingPlan to update.
     */
    where: BillingPlanWhereUniqueInput
  }

  /**
   * BillingPlan updateMany
   */
  export type BillingPlanUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update BillingPlans.
     */
    data: XOR<BillingPlanUpdateManyMutationInput, BillingPlanUncheckedUpdateManyInput>
    /**
     * Filter which BillingPlans to update
     */
    where?: BillingPlanWhereInput
    /**
     * Limit how many BillingPlans to update.
     */
    limit?: number
  }

  /**
   * BillingPlan updateManyAndReturn
   */
  export type BillingPlanUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * The data used to update BillingPlans.
     */
    data: XOR<BillingPlanUpdateManyMutationInput, BillingPlanUncheckedUpdateManyInput>
    /**
     * Filter which BillingPlans to update
     */
    where?: BillingPlanWhereInput
    /**
     * Limit how many BillingPlans to update.
     */
    limit?: number
  }

  /**
   * BillingPlan upsert
   */
  export type BillingPlanUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * The filter to search for the BillingPlan to update in case it exists.
     */
    where: BillingPlanWhereUniqueInput
    /**
     * In case the BillingPlan found by the `where` argument doesn't exist, create a new BillingPlan with this data.
     */
    create: XOR<BillingPlanCreateInput, BillingPlanUncheckedCreateInput>
    /**
     * In case the BillingPlan was found with the provided `where` argument, update it with this data.
     */
    update: XOR<BillingPlanUpdateInput, BillingPlanUncheckedUpdateInput>
  }

  /**
   * BillingPlan delete
   */
  export type BillingPlanDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
    /**
     * Filter which BillingPlan to delete.
     */
    where: BillingPlanWhereUniqueInput
  }

  /**
   * BillingPlan deleteMany
   */
  export type BillingPlanDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingPlans to delete
     */
    where?: BillingPlanWhereInput
    /**
     * Limit how many BillingPlans to delete.
     */
    limit?: number
  }

  /**
   * BillingPlan.quotas
   */
  export type BillingPlan$quotasArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    where?: BillingPlanQuotaWhereInput
    orderBy?: BillingPlanQuotaOrderByWithRelationInput | BillingPlanQuotaOrderByWithRelationInput[]
    cursor?: BillingPlanQuotaWhereUniqueInput
    take?: number
    skip?: number
    distinct?: BillingPlanQuotaScalarFieldEnum | BillingPlanQuotaScalarFieldEnum[]
  }

  /**
   * BillingPlan.subscriptions
   */
  export type BillingPlan$subscriptionsArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    where?: BillingSubscriptionWhereInput
    orderBy?: BillingSubscriptionOrderByWithRelationInput | BillingSubscriptionOrderByWithRelationInput[]
    cursor?: BillingSubscriptionWhereUniqueInput
    take?: number
    skip?: number
    distinct?: BillingSubscriptionScalarFieldEnum | BillingSubscriptionScalarFieldEnum[]
  }

  /**
   * BillingPlan without action
   */
  export type BillingPlanDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlan
     */
    select?: BillingPlanSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlan
     */
    omit?: BillingPlanOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanInclude<ExtArgs> | null
  }


  /**
   * Model BillingPlanQuota
   */

  export type AggregateBillingPlanQuota = {
    _count: BillingPlanQuotaCountAggregateOutputType | null
    _avg: BillingPlanQuotaAvgAggregateOutputType | null
    _sum: BillingPlanQuotaSumAggregateOutputType | null
    _min: BillingPlanQuotaMinAggregateOutputType | null
    _max: BillingPlanQuotaMaxAggregateOutputType | null
  }

  export type BillingPlanQuotaAvgAggregateOutputType = {
    limit: number | null
  }

  export type BillingPlanQuotaSumAggregateOutputType = {
    limit: bigint | null
  }

  export type BillingPlanQuotaMinAggregateOutputType = {
    id: string | null
    planId: string | null
    action: string | null
    limit: bigint | null
    createdAt: Date | null
  }

  export type BillingPlanQuotaMaxAggregateOutputType = {
    id: string | null
    planId: string | null
    action: string | null
    limit: bigint | null
    createdAt: Date | null
  }

  export type BillingPlanQuotaCountAggregateOutputType = {
    id: number
    planId: number
    action: number
    limit: number
    createdAt: number
    _all: number
  }


  export type BillingPlanQuotaAvgAggregateInputType = {
    limit?: true
  }

  export type BillingPlanQuotaSumAggregateInputType = {
    limit?: true
  }

  export type BillingPlanQuotaMinAggregateInputType = {
    id?: true
    planId?: true
    action?: true
    limit?: true
    createdAt?: true
  }

  export type BillingPlanQuotaMaxAggregateInputType = {
    id?: true
    planId?: true
    action?: true
    limit?: true
    createdAt?: true
  }

  export type BillingPlanQuotaCountAggregateInputType = {
    id?: true
    planId?: true
    action?: true
    limit?: true
    createdAt?: true
    _all?: true
  }

  export type BillingPlanQuotaAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingPlanQuota to aggregate.
     */
    where?: BillingPlanQuotaWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPlanQuotas to fetch.
     */
    orderBy?: BillingPlanQuotaOrderByWithRelationInput | BillingPlanQuotaOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: BillingPlanQuotaWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPlanQuotas from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPlanQuotas.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned BillingPlanQuotas
    **/
    _count?: true | BillingPlanQuotaCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: BillingPlanQuotaAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: BillingPlanQuotaSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: BillingPlanQuotaMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: BillingPlanQuotaMaxAggregateInputType
  }

  export type GetBillingPlanQuotaAggregateType<T extends BillingPlanQuotaAggregateArgs> = {
        [P in keyof T & keyof AggregateBillingPlanQuota]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateBillingPlanQuota[P]>
      : GetScalarType<T[P], AggregateBillingPlanQuota[P]>
  }




  export type BillingPlanQuotaGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingPlanQuotaWhereInput
    orderBy?: BillingPlanQuotaOrderByWithAggregationInput | BillingPlanQuotaOrderByWithAggregationInput[]
    by: BillingPlanQuotaScalarFieldEnum[] | BillingPlanQuotaScalarFieldEnum
    having?: BillingPlanQuotaScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: BillingPlanQuotaCountAggregateInputType | true
    _avg?: BillingPlanQuotaAvgAggregateInputType
    _sum?: BillingPlanQuotaSumAggregateInputType
    _min?: BillingPlanQuotaMinAggregateInputType
    _max?: BillingPlanQuotaMaxAggregateInputType
  }

  export type BillingPlanQuotaGroupByOutputType = {
    id: string
    planId: string
    action: string
    limit: bigint
    createdAt: Date
    _count: BillingPlanQuotaCountAggregateOutputType | null
    _avg: BillingPlanQuotaAvgAggregateOutputType | null
    _sum: BillingPlanQuotaSumAggregateOutputType | null
    _min: BillingPlanQuotaMinAggregateOutputType | null
    _max: BillingPlanQuotaMaxAggregateOutputType | null
  }

  type GetBillingPlanQuotaGroupByPayload<T extends BillingPlanQuotaGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<BillingPlanQuotaGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof BillingPlanQuotaGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], BillingPlanQuotaGroupByOutputType[P]>
            : GetScalarType<T[P], BillingPlanQuotaGroupByOutputType[P]>
        }
      >
    >


  export type BillingPlanQuotaSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    planId?: boolean
    action?: boolean
    limit?: boolean
    createdAt?: boolean
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingPlanQuota"]>

  export type BillingPlanQuotaSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    planId?: boolean
    action?: boolean
    limit?: boolean
    createdAt?: boolean
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingPlanQuota"]>

  export type BillingPlanQuotaSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    planId?: boolean
    action?: boolean
    limit?: boolean
    createdAt?: boolean
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingPlanQuota"]>

  export type BillingPlanQuotaSelectScalar = {
    id?: boolean
    planId?: boolean
    action?: boolean
    limit?: boolean
    createdAt?: boolean
  }

  export type BillingPlanQuotaOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"id" | "planId" | "action" | "limit" | "createdAt", ExtArgs["result"]["billingPlanQuota"]>
  export type BillingPlanQuotaInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }
  export type BillingPlanQuotaIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }
  export type BillingPlanQuotaIncludeUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }

  export type $BillingPlanQuotaPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "BillingPlanQuota"
    objects: {
      plan: Prisma.$BillingPlanPayload<ExtArgs>
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      planId: string
      action: string
      limit: bigint
      createdAt: Date
    }, ExtArgs["result"]["billingPlanQuota"]>
    composites: {}
  }

  type BillingPlanQuotaGetPayload<S extends boolean | null | undefined | BillingPlanQuotaDefaultArgs> = $Result.GetResult<Prisma.$BillingPlanQuotaPayload, S>

  type BillingPlanQuotaCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<BillingPlanQuotaFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: BillingPlanQuotaCountAggregateInputType | true
    }

  export interface BillingPlanQuotaDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['BillingPlanQuota'], meta: { name: 'BillingPlanQuota' } }
    /**
     * Find zero or one BillingPlanQuota that matches the filter.
     * @param {BillingPlanQuotaFindUniqueArgs} args - Arguments to find a BillingPlanQuota
     * @example
     * // Get one BillingPlanQuota
     * const billingPlanQuota = await prisma.billingPlanQuota.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends BillingPlanQuotaFindUniqueArgs>(args: SelectSubset<T, BillingPlanQuotaFindUniqueArgs<ExtArgs>>): Prisma__BillingPlanQuotaClient<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one BillingPlanQuota that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {BillingPlanQuotaFindUniqueOrThrowArgs} args - Arguments to find a BillingPlanQuota
     * @example
     * // Get one BillingPlanQuota
     * const billingPlanQuota = await prisma.billingPlanQuota.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends BillingPlanQuotaFindUniqueOrThrowArgs>(args: SelectSubset<T, BillingPlanQuotaFindUniqueOrThrowArgs<ExtArgs>>): Prisma__BillingPlanQuotaClient<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingPlanQuota that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanQuotaFindFirstArgs} args - Arguments to find a BillingPlanQuota
     * @example
     * // Get one BillingPlanQuota
     * const billingPlanQuota = await prisma.billingPlanQuota.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends BillingPlanQuotaFindFirstArgs>(args?: SelectSubset<T, BillingPlanQuotaFindFirstArgs<ExtArgs>>): Prisma__BillingPlanQuotaClient<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingPlanQuota that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanQuotaFindFirstOrThrowArgs} args - Arguments to find a BillingPlanQuota
     * @example
     * // Get one BillingPlanQuota
     * const billingPlanQuota = await prisma.billingPlanQuota.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends BillingPlanQuotaFindFirstOrThrowArgs>(args?: SelectSubset<T, BillingPlanQuotaFindFirstOrThrowArgs<ExtArgs>>): Prisma__BillingPlanQuotaClient<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more BillingPlanQuotas that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanQuotaFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all BillingPlanQuotas
     * const billingPlanQuotas = await prisma.billingPlanQuota.findMany()
     * 
     * // Get first 10 BillingPlanQuotas
     * const billingPlanQuotas = await prisma.billingPlanQuota.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const billingPlanQuotaWithIdOnly = await prisma.billingPlanQuota.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends BillingPlanQuotaFindManyArgs>(args?: SelectSubset<T, BillingPlanQuotaFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a BillingPlanQuota.
     * @param {BillingPlanQuotaCreateArgs} args - Arguments to create a BillingPlanQuota.
     * @example
     * // Create one BillingPlanQuota
     * const BillingPlanQuota = await prisma.billingPlanQuota.create({
     *   data: {
     *     // ... data to create a BillingPlanQuota
     *   }
     * })
     * 
     */
    create<T extends BillingPlanQuotaCreateArgs>(args: SelectSubset<T, BillingPlanQuotaCreateArgs<ExtArgs>>): Prisma__BillingPlanQuotaClient<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many BillingPlanQuotas.
     * @param {BillingPlanQuotaCreateManyArgs} args - Arguments to create many BillingPlanQuotas.
     * @example
     * // Create many BillingPlanQuotas
     * const billingPlanQuota = await prisma.billingPlanQuota.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends BillingPlanQuotaCreateManyArgs>(args?: SelectSubset<T, BillingPlanQuotaCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many BillingPlanQuotas and returns the data saved in the database.
     * @param {BillingPlanQuotaCreateManyAndReturnArgs} args - Arguments to create many BillingPlanQuotas.
     * @example
     * // Create many BillingPlanQuotas
     * const billingPlanQuota = await prisma.billingPlanQuota.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many BillingPlanQuotas and only return the `id`
     * const billingPlanQuotaWithIdOnly = await prisma.billingPlanQuota.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends BillingPlanQuotaCreateManyAndReturnArgs>(args?: SelectSubset<T, BillingPlanQuotaCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a BillingPlanQuota.
     * @param {BillingPlanQuotaDeleteArgs} args - Arguments to delete one BillingPlanQuota.
     * @example
     * // Delete one BillingPlanQuota
     * const BillingPlanQuota = await prisma.billingPlanQuota.delete({
     *   where: {
     *     // ... filter to delete one BillingPlanQuota
     *   }
     * })
     * 
     */
    delete<T extends BillingPlanQuotaDeleteArgs>(args: SelectSubset<T, BillingPlanQuotaDeleteArgs<ExtArgs>>): Prisma__BillingPlanQuotaClient<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one BillingPlanQuota.
     * @param {BillingPlanQuotaUpdateArgs} args - Arguments to update one BillingPlanQuota.
     * @example
     * // Update one BillingPlanQuota
     * const billingPlanQuota = await prisma.billingPlanQuota.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends BillingPlanQuotaUpdateArgs>(args: SelectSubset<T, BillingPlanQuotaUpdateArgs<ExtArgs>>): Prisma__BillingPlanQuotaClient<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more BillingPlanQuotas.
     * @param {BillingPlanQuotaDeleteManyArgs} args - Arguments to filter BillingPlanQuotas to delete.
     * @example
     * // Delete a few BillingPlanQuotas
     * const { count } = await prisma.billingPlanQuota.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends BillingPlanQuotaDeleteManyArgs>(args?: SelectSubset<T, BillingPlanQuotaDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingPlanQuotas.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanQuotaUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many BillingPlanQuotas
     * const billingPlanQuota = await prisma.billingPlanQuota.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends BillingPlanQuotaUpdateManyArgs>(args: SelectSubset<T, BillingPlanQuotaUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingPlanQuotas and returns the data updated in the database.
     * @param {BillingPlanQuotaUpdateManyAndReturnArgs} args - Arguments to update many BillingPlanQuotas.
     * @example
     * // Update many BillingPlanQuotas
     * const billingPlanQuota = await prisma.billingPlanQuota.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more BillingPlanQuotas and only return the `id`
     * const billingPlanQuotaWithIdOnly = await prisma.billingPlanQuota.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends BillingPlanQuotaUpdateManyAndReturnArgs>(args: SelectSubset<T, BillingPlanQuotaUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one BillingPlanQuota.
     * @param {BillingPlanQuotaUpsertArgs} args - Arguments to update or create a BillingPlanQuota.
     * @example
     * // Update or create a BillingPlanQuota
     * const billingPlanQuota = await prisma.billingPlanQuota.upsert({
     *   create: {
     *     // ... data to create a BillingPlanQuota
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the BillingPlanQuota we want to update
     *   }
     * })
     */
    upsert<T extends BillingPlanQuotaUpsertArgs>(args: SelectSubset<T, BillingPlanQuotaUpsertArgs<ExtArgs>>): Prisma__BillingPlanQuotaClient<$Result.GetResult<Prisma.$BillingPlanQuotaPayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of BillingPlanQuotas.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanQuotaCountArgs} args - Arguments to filter BillingPlanQuotas to count.
     * @example
     * // Count the number of BillingPlanQuotas
     * const count = await prisma.billingPlanQuota.count({
     *   where: {
     *     // ... the filter for the BillingPlanQuotas we want to count
     *   }
     * })
    **/
    count<T extends BillingPlanQuotaCountArgs>(
      args?: Subset<T, BillingPlanQuotaCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], BillingPlanQuotaCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a BillingPlanQuota.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanQuotaAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends BillingPlanQuotaAggregateArgs>(args: Subset<T, BillingPlanQuotaAggregateArgs>): Prisma.PrismaPromise<GetBillingPlanQuotaAggregateType<T>>

    /**
     * Group by BillingPlanQuota.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPlanQuotaGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends BillingPlanQuotaGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: BillingPlanQuotaGroupByArgs['orderBy'] }
        : { orderBy?: BillingPlanQuotaGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, BillingPlanQuotaGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetBillingPlanQuotaGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the BillingPlanQuota model
   */
  readonly fields: BillingPlanQuotaFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for BillingPlanQuota.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__BillingPlanQuotaClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    plan<T extends BillingPlanDefaultArgs<ExtArgs> = {}>(args?: Subset<T, BillingPlanDefaultArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions> | Null, Null, ExtArgs, GlobalOmitOptions>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the BillingPlanQuota model
   */
  interface BillingPlanQuotaFieldRefs {
    readonly id: FieldRef<"BillingPlanQuota", 'String'>
    readonly planId: FieldRef<"BillingPlanQuota", 'String'>
    readonly action: FieldRef<"BillingPlanQuota", 'String'>
    readonly limit: FieldRef<"BillingPlanQuota", 'BigInt'>
    readonly createdAt: FieldRef<"BillingPlanQuota", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * BillingPlanQuota findUnique
   */
  export type BillingPlanQuotaFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlanQuota to fetch.
     */
    where: BillingPlanQuotaWhereUniqueInput
  }

  /**
   * BillingPlanQuota findUniqueOrThrow
   */
  export type BillingPlanQuotaFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlanQuota to fetch.
     */
    where: BillingPlanQuotaWhereUniqueInput
  }

  /**
   * BillingPlanQuota findFirst
   */
  export type BillingPlanQuotaFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlanQuota to fetch.
     */
    where?: BillingPlanQuotaWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPlanQuotas to fetch.
     */
    orderBy?: BillingPlanQuotaOrderByWithRelationInput | BillingPlanQuotaOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingPlanQuotas.
     */
    cursor?: BillingPlanQuotaWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPlanQuotas from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPlanQuotas.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPlanQuotas.
     */
    distinct?: BillingPlanQuotaScalarFieldEnum | BillingPlanQuotaScalarFieldEnum[]
  }

  /**
   * BillingPlanQuota findFirstOrThrow
   */
  export type BillingPlanQuotaFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlanQuota to fetch.
     */
    where?: BillingPlanQuotaWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPlanQuotas to fetch.
     */
    orderBy?: BillingPlanQuotaOrderByWithRelationInput | BillingPlanQuotaOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingPlanQuotas.
     */
    cursor?: BillingPlanQuotaWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPlanQuotas from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPlanQuotas.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPlanQuotas.
     */
    distinct?: BillingPlanQuotaScalarFieldEnum | BillingPlanQuotaScalarFieldEnum[]
  }

  /**
   * BillingPlanQuota findMany
   */
  export type BillingPlanQuotaFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * Filter, which BillingPlanQuotas to fetch.
     */
    where?: BillingPlanQuotaWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPlanQuotas to fetch.
     */
    orderBy?: BillingPlanQuotaOrderByWithRelationInput | BillingPlanQuotaOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing BillingPlanQuotas.
     */
    cursor?: BillingPlanQuotaWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPlanQuotas from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPlanQuotas.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPlanQuotas.
     */
    distinct?: BillingPlanQuotaScalarFieldEnum | BillingPlanQuotaScalarFieldEnum[]
  }

  /**
   * BillingPlanQuota create
   */
  export type BillingPlanQuotaCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * The data needed to create a BillingPlanQuota.
     */
    data: XOR<BillingPlanQuotaCreateInput, BillingPlanQuotaUncheckedCreateInput>
  }

  /**
   * BillingPlanQuota createMany
   */
  export type BillingPlanQuotaCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many BillingPlanQuotas.
     */
    data: BillingPlanQuotaCreateManyInput | BillingPlanQuotaCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingPlanQuota createManyAndReturn
   */
  export type BillingPlanQuotaCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * The data used to create many BillingPlanQuotas.
     */
    data: BillingPlanQuotaCreateManyInput | BillingPlanQuotaCreateManyInput[]
    skipDuplicates?: boolean
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaIncludeCreateManyAndReturn<ExtArgs> | null
  }

  /**
   * BillingPlanQuota update
   */
  export type BillingPlanQuotaUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * The data needed to update a BillingPlanQuota.
     */
    data: XOR<BillingPlanQuotaUpdateInput, BillingPlanQuotaUncheckedUpdateInput>
    /**
     * Choose, which BillingPlanQuota to update.
     */
    where: BillingPlanQuotaWhereUniqueInput
  }

  /**
   * BillingPlanQuota updateMany
   */
  export type BillingPlanQuotaUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update BillingPlanQuotas.
     */
    data: XOR<BillingPlanQuotaUpdateManyMutationInput, BillingPlanQuotaUncheckedUpdateManyInput>
    /**
     * Filter which BillingPlanQuotas to update
     */
    where?: BillingPlanQuotaWhereInput
    /**
     * Limit how many BillingPlanQuotas to update.
     */
    limit?: number
  }

  /**
   * BillingPlanQuota updateManyAndReturn
   */
  export type BillingPlanQuotaUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * The data used to update BillingPlanQuotas.
     */
    data: XOR<BillingPlanQuotaUpdateManyMutationInput, BillingPlanQuotaUncheckedUpdateManyInput>
    /**
     * Filter which BillingPlanQuotas to update
     */
    where?: BillingPlanQuotaWhereInput
    /**
     * Limit how many BillingPlanQuotas to update.
     */
    limit?: number
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaIncludeUpdateManyAndReturn<ExtArgs> | null
  }

  /**
   * BillingPlanQuota upsert
   */
  export type BillingPlanQuotaUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * The filter to search for the BillingPlanQuota to update in case it exists.
     */
    where: BillingPlanQuotaWhereUniqueInput
    /**
     * In case the BillingPlanQuota found by the `where` argument doesn't exist, create a new BillingPlanQuota with this data.
     */
    create: XOR<BillingPlanQuotaCreateInput, BillingPlanQuotaUncheckedCreateInput>
    /**
     * In case the BillingPlanQuota was found with the provided `where` argument, update it with this data.
     */
    update: XOR<BillingPlanQuotaUpdateInput, BillingPlanQuotaUncheckedUpdateInput>
  }

  /**
   * BillingPlanQuota delete
   */
  export type BillingPlanQuotaDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
    /**
     * Filter which BillingPlanQuota to delete.
     */
    where: BillingPlanQuotaWhereUniqueInput
  }

  /**
   * BillingPlanQuota deleteMany
   */
  export type BillingPlanQuotaDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingPlanQuotas to delete
     */
    where?: BillingPlanQuotaWhereInput
    /**
     * Limit how many BillingPlanQuotas to delete.
     */
    limit?: number
  }

  /**
   * BillingPlanQuota without action
   */
  export type BillingPlanQuotaDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPlanQuota
     */
    select?: BillingPlanQuotaSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPlanQuota
     */
    omit?: BillingPlanQuotaOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPlanQuotaInclude<ExtArgs> | null
  }


  /**
   * Model BillingSubscription
   */

  export type AggregateBillingSubscription = {
    _count: BillingSubscriptionCountAggregateOutputType | null
    _min: BillingSubscriptionMinAggregateOutputType | null
    _max: BillingSubscriptionMaxAggregateOutputType | null
  }

  export type BillingSubscriptionMinAggregateOutputType = {
    id: string | null
    projectId: string | null
    planId: string | null
    status: string | null
    currentPeriodStart: Date | null
    currentPeriodEnd: Date | null
    createdAt: Date | null
    updatedAt: Date | null
  }

  export type BillingSubscriptionMaxAggregateOutputType = {
    id: string | null
    projectId: string | null
    planId: string | null
    status: string | null
    currentPeriodStart: Date | null
    currentPeriodEnd: Date | null
    createdAt: Date | null
    updatedAt: Date | null
  }

  export type BillingSubscriptionCountAggregateOutputType = {
    id: number
    projectId: number
    planId: number
    status: number
    currentPeriodStart: number
    currentPeriodEnd: number
    createdAt: number
    updatedAt: number
    _all: number
  }


  export type BillingSubscriptionMinAggregateInputType = {
    id?: true
    projectId?: true
    planId?: true
    status?: true
    currentPeriodStart?: true
    currentPeriodEnd?: true
    createdAt?: true
    updatedAt?: true
  }

  export type BillingSubscriptionMaxAggregateInputType = {
    id?: true
    projectId?: true
    planId?: true
    status?: true
    currentPeriodStart?: true
    currentPeriodEnd?: true
    createdAt?: true
    updatedAt?: true
  }

  export type BillingSubscriptionCountAggregateInputType = {
    id?: true
    projectId?: true
    planId?: true
    status?: true
    currentPeriodStart?: true
    currentPeriodEnd?: true
    createdAt?: true
    updatedAt?: true
    _all?: true
  }

  export type BillingSubscriptionAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingSubscription to aggregate.
     */
    where?: BillingSubscriptionWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingSubscriptions to fetch.
     */
    orderBy?: BillingSubscriptionOrderByWithRelationInput | BillingSubscriptionOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: BillingSubscriptionWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingSubscriptions from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingSubscriptions.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned BillingSubscriptions
    **/
    _count?: true | BillingSubscriptionCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: BillingSubscriptionMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: BillingSubscriptionMaxAggregateInputType
  }

  export type GetBillingSubscriptionAggregateType<T extends BillingSubscriptionAggregateArgs> = {
        [P in keyof T & keyof AggregateBillingSubscription]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateBillingSubscription[P]>
      : GetScalarType<T[P], AggregateBillingSubscription[P]>
  }




  export type BillingSubscriptionGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingSubscriptionWhereInput
    orderBy?: BillingSubscriptionOrderByWithAggregationInput | BillingSubscriptionOrderByWithAggregationInput[]
    by: BillingSubscriptionScalarFieldEnum[] | BillingSubscriptionScalarFieldEnum
    having?: BillingSubscriptionScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: BillingSubscriptionCountAggregateInputType | true
    _min?: BillingSubscriptionMinAggregateInputType
    _max?: BillingSubscriptionMaxAggregateInputType
  }

  export type BillingSubscriptionGroupByOutputType = {
    id: string
    projectId: string
    planId: string
    status: string
    currentPeriodStart: Date
    currentPeriodEnd: Date
    createdAt: Date
    updatedAt: Date
    _count: BillingSubscriptionCountAggregateOutputType | null
    _min: BillingSubscriptionMinAggregateOutputType | null
    _max: BillingSubscriptionMaxAggregateOutputType | null
  }

  type GetBillingSubscriptionGroupByPayload<T extends BillingSubscriptionGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<BillingSubscriptionGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof BillingSubscriptionGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], BillingSubscriptionGroupByOutputType[P]>
            : GetScalarType<T[P], BillingSubscriptionGroupByOutputType[P]>
        }
      >
    >


  export type BillingSubscriptionSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    planId?: boolean
    status?: boolean
    currentPeriodStart?: boolean
    currentPeriodEnd?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
    payments?: boolean | BillingSubscription$paymentsArgs<ExtArgs>
    invoices?: boolean | BillingSubscription$invoicesArgs<ExtArgs>
    _count?: boolean | BillingSubscriptionCountOutputTypeDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingSubscription"]>

  export type BillingSubscriptionSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    planId?: boolean
    status?: boolean
    currentPeriodStart?: boolean
    currentPeriodEnd?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingSubscription"]>

  export type BillingSubscriptionSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    planId?: boolean
    status?: boolean
    currentPeriodStart?: boolean
    currentPeriodEnd?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingSubscription"]>

  export type BillingSubscriptionSelectScalar = {
    id?: boolean
    projectId?: boolean
    planId?: boolean
    status?: boolean
    currentPeriodStart?: boolean
    currentPeriodEnd?: boolean
    createdAt?: boolean
    updatedAt?: boolean
  }

  export type BillingSubscriptionOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"id" | "projectId" | "planId" | "status" | "currentPeriodStart" | "currentPeriodEnd" | "createdAt" | "updatedAt", ExtArgs["result"]["billingSubscription"]>
  export type BillingSubscriptionInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
    payments?: boolean | BillingSubscription$paymentsArgs<ExtArgs>
    invoices?: boolean | BillingSubscription$invoicesArgs<ExtArgs>
    _count?: boolean | BillingSubscriptionCountOutputTypeDefaultArgs<ExtArgs>
  }
  export type BillingSubscriptionIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }
  export type BillingSubscriptionIncludeUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    plan?: boolean | BillingPlanDefaultArgs<ExtArgs>
  }

  export type $BillingSubscriptionPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "BillingSubscription"
    objects: {
      plan: Prisma.$BillingPlanPayload<ExtArgs>
      payments: Prisma.$BillingPaymentPayload<ExtArgs>[]
      invoices: Prisma.$BillingInvoicePayload<ExtArgs>[]
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      projectId: string
      planId: string
      status: string
      currentPeriodStart: Date
      currentPeriodEnd: Date
      createdAt: Date
      updatedAt: Date
    }, ExtArgs["result"]["billingSubscription"]>
    composites: {}
  }

  type BillingSubscriptionGetPayload<S extends boolean | null | undefined | BillingSubscriptionDefaultArgs> = $Result.GetResult<Prisma.$BillingSubscriptionPayload, S>

  type BillingSubscriptionCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<BillingSubscriptionFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: BillingSubscriptionCountAggregateInputType | true
    }

  export interface BillingSubscriptionDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['BillingSubscription'], meta: { name: 'BillingSubscription' } }
    /**
     * Find zero or one BillingSubscription that matches the filter.
     * @param {BillingSubscriptionFindUniqueArgs} args - Arguments to find a BillingSubscription
     * @example
     * // Get one BillingSubscription
     * const billingSubscription = await prisma.billingSubscription.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends BillingSubscriptionFindUniqueArgs>(args: SelectSubset<T, BillingSubscriptionFindUniqueArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one BillingSubscription that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {BillingSubscriptionFindUniqueOrThrowArgs} args - Arguments to find a BillingSubscription
     * @example
     * // Get one BillingSubscription
     * const billingSubscription = await prisma.billingSubscription.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends BillingSubscriptionFindUniqueOrThrowArgs>(args: SelectSubset<T, BillingSubscriptionFindUniqueOrThrowArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingSubscription that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingSubscriptionFindFirstArgs} args - Arguments to find a BillingSubscription
     * @example
     * // Get one BillingSubscription
     * const billingSubscription = await prisma.billingSubscription.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends BillingSubscriptionFindFirstArgs>(args?: SelectSubset<T, BillingSubscriptionFindFirstArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingSubscription that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingSubscriptionFindFirstOrThrowArgs} args - Arguments to find a BillingSubscription
     * @example
     * // Get one BillingSubscription
     * const billingSubscription = await prisma.billingSubscription.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends BillingSubscriptionFindFirstOrThrowArgs>(args?: SelectSubset<T, BillingSubscriptionFindFirstOrThrowArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more BillingSubscriptions that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingSubscriptionFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all BillingSubscriptions
     * const billingSubscriptions = await prisma.billingSubscription.findMany()
     * 
     * // Get first 10 BillingSubscriptions
     * const billingSubscriptions = await prisma.billingSubscription.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const billingSubscriptionWithIdOnly = await prisma.billingSubscription.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends BillingSubscriptionFindManyArgs>(args?: SelectSubset<T, BillingSubscriptionFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a BillingSubscription.
     * @param {BillingSubscriptionCreateArgs} args - Arguments to create a BillingSubscription.
     * @example
     * // Create one BillingSubscription
     * const BillingSubscription = await prisma.billingSubscription.create({
     *   data: {
     *     // ... data to create a BillingSubscription
     *   }
     * })
     * 
     */
    create<T extends BillingSubscriptionCreateArgs>(args: SelectSubset<T, BillingSubscriptionCreateArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many BillingSubscriptions.
     * @param {BillingSubscriptionCreateManyArgs} args - Arguments to create many BillingSubscriptions.
     * @example
     * // Create many BillingSubscriptions
     * const billingSubscription = await prisma.billingSubscription.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends BillingSubscriptionCreateManyArgs>(args?: SelectSubset<T, BillingSubscriptionCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many BillingSubscriptions and returns the data saved in the database.
     * @param {BillingSubscriptionCreateManyAndReturnArgs} args - Arguments to create many BillingSubscriptions.
     * @example
     * // Create many BillingSubscriptions
     * const billingSubscription = await prisma.billingSubscription.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many BillingSubscriptions and only return the `id`
     * const billingSubscriptionWithIdOnly = await prisma.billingSubscription.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends BillingSubscriptionCreateManyAndReturnArgs>(args?: SelectSubset<T, BillingSubscriptionCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a BillingSubscription.
     * @param {BillingSubscriptionDeleteArgs} args - Arguments to delete one BillingSubscription.
     * @example
     * // Delete one BillingSubscription
     * const BillingSubscription = await prisma.billingSubscription.delete({
     *   where: {
     *     // ... filter to delete one BillingSubscription
     *   }
     * })
     * 
     */
    delete<T extends BillingSubscriptionDeleteArgs>(args: SelectSubset<T, BillingSubscriptionDeleteArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one BillingSubscription.
     * @param {BillingSubscriptionUpdateArgs} args - Arguments to update one BillingSubscription.
     * @example
     * // Update one BillingSubscription
     * const billingSubscription = await prisma.billingSubscription.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends BillingSubscriptionUpdateArgs>(args: SelectSubset<T, BillingSubscriptionUpdateArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more BillingSubscriptions.
     * @param {BillingSubscriptionDeleteManyArgs} args - Arguments to filter BillingSubscriptions to delete.
     * @example
     * // Delete a few BillingSubscriptions
     * const { count } = await prisma.billingSubscription.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends BillingSubscriptionDeleteManyArgs>(args?: SelectSubset<T, BillingSubscriptionDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingSubscriptions.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingSubscriptionUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many BillingSubscriptions
     * const billingSubscription = await prisma.billingSubscription.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends BillingSubscriptionUpdateManyArgs>(args: SelectSubset<T, BillingSubscriptionUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingSubscriptions and returns the data updated in the database.
     * @param {BillingSubscriptionUpdateManyAndReturnArgs} args - Arguments to update many BillingSubscriptions.
     * @example
     * // Update many BillingSubscriptions
     * const billingSubscription = await prisma.billingSubscription.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more BillingSubscriptions and only return the `id`
     * const billingSubscriptionWithIdOnly = await prisma.billingSubscription.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends BillingSubscriptionUpdateManyAndReturnArgs>(args: SelectSubset<T, BillingSubscriptionUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one BillingSubscription.
     * @param {BillingSubscriptionUpsertArgs} args - Arguments to update or create a BillingSubscription.
     * @example
     * // Update or create a BillingSubscription
     * const billingSubscription = await prisma.billingSubscription.upsert({
     *   create: {
     *     // ... data to create a BillingSubscription
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the BillingSubscription we want to update
     *   }
     * })
     */
    upsert<T extends BillingSubscriptionUpsertArgs>(args: SelectSubset<T, BillingSubscriptionUpsertArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of BillingSubscriptions.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingSubscriptionCountArgs} args - Arguments to filter BillingSubscriptions to count.
     * @example
     * // Count the number of BillingSubscriptions
     * const count = await prisma.billingSubscription.count({
     *   where: {
     *     // ... the filter for the BillingSubscriptions we want to count
     *   }
     * })
    **/
    count<T extends BillingSubscriptionCountArgs>(
      args?: Subset<T, BillingSubscriptionCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], BillingSubscriptionCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a BillingSubscription.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingSubscriptionAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends BillingSubscriptionAggregateArgs>(args: Subset<T, BillingSubscriptionAggregateArgs>): Prisma.PrismaPromise<GetBillingSubscriptionAggregateType<T>>

    /**
     * Group by BillingSubscription.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingSubscriptionGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends BillingSubscriptionGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: BillingSubscriptionGroupByArgs['orderBy'] }
        : { orderBy?: BillingSubscriptionGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, BillingSubscriptionGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetBillingSubscriptionGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the BillingSubscription model
   */
  readonly fields: BillingSubscriptionFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for BillingSubscription.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__BillingSubscriptionClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    plan<T extends BillingPlanDefaultArgs<ExtArgs> = {}>(args?: Subset<T, BillingPlanDefaultArgs<ExtArgs>>): Prisma__BillingPlanClient<$Result.GetResult<Prisma.$BillingPlanPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions> | Null, Null, ExtArgs, GlobalOmitOptions>
    payments<T extends BillingSubscription$paymentsArgs<ExtArgs> = {}>(args?: Subset<T, BillingSubscription$paymentsArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "findMany", GlobalOmitOptions> | Null>
    invoices<T extends BillingSubscription$invoicesArgs<ExtArgs> = {}>(args?: Subset<T, BillingSubscription$invoicesArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "findMany", GlobalOmitOptions> | Null>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the BillingSubscription model
   */
  interface BillingSubscriptionFieldRefs {
    readonly id: FieldRef<"BillingSubscription", 'String'>
    readonly projectId: FieldRef<"BillingSubscription", 'String'>
    readonly planId: FieldRef<"BillingSubscription", 'String'>
    readonly status: FieldRef<"BillingSubscription", 'String'>
    readonly currentPeriodStart: FieldRef<"BillingSubscription", 'DateTime'>
    readonly currentPeriodEnd: FieldRef<"BillingSubscription", 'DateTime'>
    readonly createdAt: FieldRef<"BillingSubscription", 'DateTime'>
    readonly updatedAt: FieldRef<"BillingSubscription", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * BillingSubscription findUnique
   */
  export type BillingSubscriptionFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * Filter, which BillingSubscription to fetch.
     */
    where: BillingSubscriptionWhereUniqueInput
  }

  /**
   * BillingSubscription findUniqueOrThrow
   */
  export type BillingSubscriptionFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * Filter, which BillingSubscription to fetch.
     */
    where: BillingSubscriptionWhereUniqueInput
  }

  /**
   * BillingSubscription findFirst
   */
  export type BillingSubscriptionFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * Filter, which BillingSubscription to fetch.
     */
    where?: BillingSubscriptionWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingSubscriptions to fetch.
     */
    orderBy?: BillingSubscriptionOrderByWithRelationInput | BillingSubscriptionOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingSubscriptions.
     */
    cursor?: BillingSubscriptionWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingSubscriptions from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingSubscriptions.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingSubscriptions.
     */
    distinct?: BillingSubscriptionScalarFieldEnum | BillingSubscriptionScalarFieldEnum[]
  }

  /**
   * BillingSubscription findFirstOrThrow
   */
  export type BillingSubscriptionFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * Filter, which BillingSubscription to fetch.
     */
    where?: BillingSubscriptionWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingSubscriptions to fetch.
     */
    orderBy?: BillingSubscriptionOrderByWithRelationInput | BillingSubscriptionOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingSubscriptions.
     */
    cursor?: BillingSubscriptionWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingSubscriptions from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingSubscriptions.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingSubscriptions.
     */
    distinct?: BillingSubscriptionScalarFieldEnum | BillingSubscriptionScalarFieldEnum[]
  }

  /**
   * BillingSubscription findMany
   */
  export type BillingSubscriptionFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * Filter, which BillingSubscriptions to fetch.
     */
    where?: BillingSubscriptionWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingSubscriptions to fetch.
     */
    orderBy?: BillingSubscriptionOrderByWithRelationInput | BillingSubscriptionOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing BillingSubscriptions.
     */
    cursor?: BillingSubscriptionWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingSubscriptions from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingSubscriptions.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingSubscriptions.
     */
    distinct?: BillingSubscriptionScalarFieldEnum | BillingSubscriptionScalarFieldEnum[]
  }

  /**
   * BillingSubscription create
   */
  export type BillingSubscriptionCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * The data needed to create a BillingSubscription.
     */
    data: XOR<BillingSubscriptionCreateInput, BillingSubscriptionUncheckedCreateInput>
  }

  /**
   * BillingSubscription createMany
   */
  export type BillingSubscriptionCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many BillingSubscriptions.
     */
    data: BillingSubscriptionCreateManyInput | BillingSubscriptionCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingSubscription createManyAndReturn
   */
  export type BillingSubscriptionCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * The data used to create many BillingSubscriptions.
     */
    data: BillingSubscriptionCreateManyInput | BillingSubscriptionCreateManyInput[]
    skipDuplicates?: boolean
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionIncludeCreateManyAndReturn<ExtArgs> | null
  }

  /**
   * BillingSubscription update
   */
  export type BillingSubscriptionUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * The data needed to update a BillingSubscription.
     */
    data: XOR<BillingSubscriptionUpdateInput, BillingSubscriptionUncheckedUpdateInput>
    /**
     * Choose, which BillingSubscription to update.
     */
    where: BillingSubscriptionWhereUniqueInput
  }

  /**
   * BillingSubscription updateMany
   */
  export type BillingSubscriptionUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update BillingSubscriptions.
     */
    data: XOR<BillingSubscriptionUpdateManyMutationInput, BillingSubscriptionUncheckedUpdateManyInput>
    /**
     * Filter which BillingSubscriptions to update
     */
    where?: BillingSubscriptionWhereInput
    /**
     * Limit how many BillingSubscriptions to update.
     */
    limit?: number
  }

  /**
   * BillingSubscription updateManyAndReturn
   */
  export type BillingSubscriptionUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * The data used to update BillingSubscriptions.
     */
    data: XOR<BillingSubscriptionUpdateManyMutationInput, BillingSubscriptionUncheckedUpdateManyInput>
    /**
     * Filter which BillingSubscriptions to update
     */
    where?: BillingSubscriptionWhereInput
    /**
     * Limit how many BillingSubscriptions to update.
     */
    limit?: number
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionIncludeUpdateManyAndReturn<ExtArgs> | null
  }

  /**
   * BillingSubscription upsert
   */
  export type BillingSubscriptionUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * The filter to search for the BillingSubscription to update in case it exists.
     */
    where: BillingSubscriptionWhereUniqueInput
    /**
     * In case the BillingSubscription found by the `where` argument doesn't exist, create a new BillingSubscription with this data.
     */
    create: XOR<BillingSubscriptionCreateInput, BillingSubscriptionUncheckedCreateInput>
    /**
     * In case the BillingSubscription was found with the provided `where` argument, update it with this data.
     */
    update: XOR<BillingSubscriptionUpdateInput, BillingSubscriptionUncheckedUpdateInput>
  }

  /**
   * BillingSubscription delete
   */
  export type BillingSubscriptionDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
    /**
     * Filter which BillingSubscription to delete.
     */
    where: BillingSubscriptionWhereUniqueInput
  }

  /**
   * BillingSubscription deleteMany
   */
  export type BillingSubscriptionDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingSubscriptions to delete
     */
    where?: BillingSubscriptionWhereInput
    /**
     * Limit how many BillingSubscriptions to delete.
     */
    limit?: number
  }

  /**
   * BillingSubscription.payments
   */
  export type BillingSubscription$paymentsArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    where?: BillingPaymentWhereInput
    orderBy?: BillingPaymentOrderByWithRelationInput | BillingPaymentOrderByWithRelationInput[]
    cursor?: BillingPaymentWhereUniqueInput
    take?: number
    skip?: number
    distinct?: BillingPaymentScalarFieldEnum | BillingPaymentScalarFieldEnum[]
  }

  /**
   * BillingSubscription.invoices
   */
  export type BillingSubscription$invoicesArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    where?: BillingInvoiceWhereInput
    orderBy?: BillingInvoiceOrderByWithRelationInput | BillingInvoiceOrderByWithRelationInput[]
    cursor?: BillingInvoiceWhereUniqueInput
    take?: number
    skip?: number
    distinct?: BillingInvoiceScalarFieldEnum | BillingInvoiceScalarFieldEnum[]
  }

  /**
   * BillingSubscription without action
   */
  export type BillingSubscriptionDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingSubscription
     */
    select?: BillingSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingSubscription
     */
    omit?: BillingSubscriptionOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingSubscriptionInclude<ExtArgs> | null
  }


  /**
   * Model BillingPayment
   */

  export type AggregateBillingPayment = {
    _count: BillingPaymentCountAggregateOutputType | null
    _avg: BillingPaymentAvgAggregateOutputType | null
    _sum: BillingPaymentSumAggregateOutputType | null
    _min: BillingPaymentMinAggregateOutputType | null
    _max: BillingPaymentMaxAggregateOutputType | null
  }

  export type BillingPaymentAvgAggregateOutputType = {
    amountMinor: number | null
  }

  export type BillingPaymentSumAggregateOutputType = {
    amountMinor: bigint | null
  }

  export type BillingPaymentMinAggregateOutputType = {
    id: string | null
    projectId: string | null
    subscriptionId: string | null
    amountMinor: bigint | null
    currency: string | null
    status: string | null
    provider: string | null
    providerPaymentId: string | null
    paidAt: Date | null
    createdAt: Date | null
  }

  export type BillingPaymentMaxAggregateOutputType = {
    id: string | null
    projectId: string | null
    subscriptionId: string | null
    amountMinor: bigint | null
    currency: string | null
    status: string | null
    provider: string | null
    providerPaymentId: string | null
    paidAt: Date | null
    createdAt: Date | null
  }

  export type BillingPaymentCountAggregateOutputType = {
    id: number
    projectId: number
    subscriptionId: number
    amountMinor: number
    currency: number
    status: number
    provider: number
    providerPaymentId: number
    paidAt: number
    createdAt: number
    _all: number
  }


  export type BillingPaymentAvgAggregateInputType = {
    amountMinor?: true
  }

  export type BillingPaymentSumAggregateInputType = {
    amountMinor?: true
  }

  export type BillingPaymentMinAggregateInputType = {
    id?: true
    projectId?: true
    subscriptionId?: true
    amountMinor?: true
    currency?: true
    status?: true
    provider?: true
    providerPaymentId?: true
    paidAt?: true
    createdAt?: true
  }

  export type BillingPaymentMaxAggregateInputType = {
    id?: true
    projectId?: true
    subscriptionId?: true
    amountMinor?: true
    currency?: true
    status?: true
    provider?: true
    providerPaymentId?: true
    paidAt?: true
    createdAt?: true
  }

  export type BillingPaymentCountAggregateInputType = {
    id?: true
    projectId?: true
    subscriptionId?: true
    amountMinor?: true
    currency?: true
    status?: true
    provider?: true
    providerPaymentId?: true
    paidAt?: true
    createdAt?: true
    _all?: true
  }

  export type BillingPaymentAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingPayment to aggregate.
     */
    where?: BillingPaymentWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPayments to fetch.
     */
    orderBy?: BillingPaymentOrderByWithRelationInput | BillingPaymentOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: BillingPaymentWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPayments from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPayments.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned BillingPayments
    **/
    _count?: true | BillingPaymentCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: BillingPaymentAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: BillingPaymentSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: BillingPaymentMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: BillingPaymentMaxAggregateInputType
  }

  export type GetBillingPaymentAggregateType<T extends BillingPaymentAggregateArgs> = {
        [P in keyof T & keyof AggregateBillingPayment]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateBillingPayment[P]>
      : GetScalarType<T[P], AggregateBillingPayment[P]>
  }




  export type BillingPaymentGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingPaymentWhereInput
    orderBy?: BillingPaymentOrderByWithAggregationInput | BillingPaymentOrderByWithAggregationInput[]
    by: BillingPaymentScalarFieldEnum[] | BillingPaymentScalarFieldEnum
    having?: BillingPaymentScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: BillingPaymentCountAggregateInputType | true
    _avg?: BillingPaymentAvgAggregateInputType
    _sum?: BillingPaymentSumAggregateInputType
    _min?: BillingPaymentMinAggregateInputType
    _max?: BillingPaymentMaxAggregateInputType
  }

  export type BillingPaymentGroupByOutputType = {
    id: string
    projectId: string
    subscriptionId: string
    amountMinor: bigint
    currency: string
    status: string
    provider: string
    providerPaymentId: string | null
    paidAt: Date | null
    createdAt: Date
    _count: BillingPaymentCountAggregateOutputType | null
    _avg: BillingPaymentAvgAggregateOutputType | null
    _sum: BillingPaymentSumAggregateOutputType | null
    _min: BillingPaymentMinAggregateOutputType | null
    _max: BillingPaymentMaxAggregateOutputType | null
  }

  type GetBillingPaymentGroupByPayload<T extends BillingPaymentGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<BillingPaymentGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof BillingPaymentGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], BillingPaymentGroupByOutputType[P]>
            : GetScalarType<T[P], BillingPaymentGroupByOutputType[P]>
        }
      >
    >


  export type BillingPaymentSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    subscriptionId?: boolean
    amountMinor?: boolean
    currency?: boolean
    status?: boolean
    provider?: boolean
    providerPaymentId?: boolean
    paidAt?: boolean
    createdAt?: boolean
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingPayment"]>

  export type BillingPaymentSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    subscriptionId?: boolean
    amountMinor?: boolean
    currency?: boolean
    status?: boolean
    provider?: boolean
    providerPaymentId?: boolean
    paidAt?: boolean
    createdAt?: boolean
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingPayment"]>

  export type BillingPaymentSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    subscriptionId?: boolean
    amountMinor?: boolean
    currency?: boolean
    status?: boolean
    provider?: boolean
    providerPaymentId?: boolean
    paidAt?: boolean
    createdAt?: boolean
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingPayment"]>

  export type BillingPaymentSelectScalar = {
    id?: boolean
    projectId?: boolean
    subscriptionId?: boolean
    amountMinor?: boolean
    currency?: boolean
    status?: boolean
    provider?: boolean
    providerPaymentId?: boolean
    paidAt?: boolean
    createdAt?: boolean
  }

  export type BillingPaymentOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"id" | "projectId" | "subscriptionId" | "amountMinor" | "currency" | "status" | "provider" | "providerPaymentId" | "paidAt" | "createdAt", ExtArgs["result"]["billingPayment"]>
  export type BillingPaymentInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }
  export type BillingPaymentIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }
  export type BillingPaymentIncludeUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }

  export type $BillingPaymentPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "BillingPayment"
    objects: {
      subscription: Prisma.$BillingSubscriptionPayload<ExtArgs>
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      projectId: string
      subscriptionId: string
      amountMinor: bigint
      currency: string
      status: string
      provider: string
      providerPaymentId: string | null
      paidAt: Date | null
      createdAt: Date
    }, ExtArgs["result"]["billingPayment"]>
    composites: {}
  }

  type BillingPaymentGetPayload<S extends boolean | null | undefined | BillingPaymentDefaultArgs> = $Result.GetResult<Prisma.$BillingPaymentPayload, S>

  type BillingPaymentCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<BillingPaymentFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: BillingPaymentCountAggregateInputType | true
    }

  export interface BillingPaymentDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['BillingPayment'], meta: { name: 'BillingPayment' } }
    /**
     * Find zero or one BillingPayment that matches the filter.
     * @param {BillingPaymentFindUniqueArgs} args - Arguments to find a BillingPayment
     * @example
     * // Get one BillingPayment
     * const billingPayment = await prisma.billingPayment.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends BillingPaymentFindUniqueArgs>(args: SelectSubset<T, BillingPaymentFindUniqueArgs<ExtArgs>>): Prisma__BillingPaymentClient<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one BillingPayment that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {BillingPaymentFindUniqueOrThrowArgs} args - Arguments to find a BillingPayment
     * @example
     * // Get one BillingPayment
     * const billingPayment = await prisma.billingPayment.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends BillingPaymentFindUniqueOrThrowArgs>(args: SelectSubset<T, BillingPaymentFindUniqueOrThrowArgs<ExtArgs>>): Prisma__BillingPaymentClient<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingPayment that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPaymentFindFirstArgs} args - Arguments to find a BillingPayment
     * @example
     * // Get one BillingPayment
     * const billingPayment = await prisma.billingPayment.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends BillingPaymentFindFirstArgs>(args?: SelectSubset<T, BillingPaymentFindFirstArgs<ExtArgs>>): Prisma__BillingPaymentClient<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingPayment that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPaymentFindFirstOrThrowArgs} args - Arguments to find a BillingPayment
     * @example
     * // Get one BillingPayment
     * const billingPayment = await prisma.billingPayment.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends BillingPaymentFindFirstOrThrowArgs>(args?: SelectSubset<T, BillingPaymentFindFirstOrThrowArgs<ExtArgs>>): Prisma__BillingPaymentClient<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more BillingPayments that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPaymentFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all BillingPayments
     * const billingPayments = await prisma.billingPayment.findMany()
     * 
     * // Get first 10 BillingPayments
     * const billingPayments = await prisma.billingPayment.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const billingPaymentWithIdOnly = await prisma.billingPayment.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends BillingPaymentFindManyArgs>(args?: SelectSubset<T, BillingPaymentFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a BillingPayment.
     * @param {BillingPaymentCreateArgs} args - Arguments to create a BillingPayment.
     * @example
     * // Create one BillingPayment
     * const BillingPayment = await prisma.billingPayment.create({
     *   data: {
     *     // ... data to create a BillingPayment
     *   }
     * })
     * 
     */
    create<T extends BillingPaymentCreateArgs>(args: SelectSubset<T, BillingPaymentCreateArgs<ExtArgs>>): Prisma__BillingPaymentClient<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many BillingPayments.
     * @param {BillingPaymentCreateManyArgs} args - Arguments to create many BillingPayments.
     * @example
     * // Create many BillingPayments
     * const billingPayment = await prisma.billingPayment.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends BillingPaymentCreateManyArgs>(args?: SelectSubset<T, BillingPaymentCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many BillingPayments and returns the data saved in the database.
     * @param {BillingPaymentCreateManyAndReturnArgs} args - Arguments to create many BillingPayments.
     * @example
     * // Create many BillingPayments
     * const billingPayment = await prisma.billingPayment.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many BillingPayments and only return the `id`
     * const billingPaymentWithIdOnly = await prisma.billingPayment.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends BillingPaymentCreateManyAndReturnArgs>(args?: SelectSubset<T, BillingPaymentCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a BillingPayment.
     * @param {BillingPaymentDeleteArgs} args - Arguments to delete one BillingPayment.
     * @example
     * // Delete one BillingPayment
     * const BillingPayment = await prisma.billingPayment.delete({
     *   where: {
     *     // ... filter to delete one BillingPayment
     *   }
     * })
     * 
     */
    delete<T extends BillingPaymentDeleteArgs>(args: SelectSubset<T, BillingPaymentDeleteArgs<ExtArgs>>): Prisma__BillingPaymentClient<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one BillingPayment.
     * @param {BillingPaymentUpdateArgs} args - Arguments to update one BillingPayment.
     * @example
     * // Update one BillingPayment
     * const billingPayment = await prisma.billingPayment.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends BillingPaymentUpdateArgs>(args: SelectSubset<T, BillingPaymentUpdateArgs<ExtArgs>>): Prisma__BillingPaymentClient<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more BillingPayments.
     * @param {BillingPaymentDeleteManyArgs} args - Arguments to filter BillingPayments to delete.
     * @example
     * // Delete a few BillingPayments
     * const { count } = await prisma.billingPayment.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends BillingPaymentDeleteManyArgs>(args?: SelectSubset<T, BillingPaymentDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingPayments.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPaymentUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many BillingPayments
     * const billingPayment = await prisma.billingPayment.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends BillingPaymentUpdateManyArgs>(args: SelectSubset<T, BillingPaymentUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingPayments and returns the data updated in the database.
     * @param {BillingPaymentUpdateManyAndReturnArgs} args - Arguments to update many BillingPayments.
     * @example
     * // Update many BillingPayments
     * const billingPayment = await prisma.billingPayment.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more BillingPayments and only return the `id`
     * const billingPaymentWithIdOnly = await prisma.billingPayment.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends BillingPaymentUpdateManyAndReturnArgs>(args: SelectSubset<T, BillingPaymentUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one BillingPayment.
     * @param {BillingPaymentUpsertArgs} args - Arguments to update or create a BillingPayment.
     * @example
     * // Update or create a BillingPayment
     * const billingPayment = await prisma.billingPayment.upsert({
     *   create: {
     *     // ... data to create a BillingPayment
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the BillingPayment we want to update
     *   }
     * })
     */
    upsert<T extends BillingPaymentUpsertArgs>(args: SelectSubset<T, BillingPaymentUpsertArgs<ExtArgs>>): Prisma__BillingPaymentClient<$Result.GetResult<Prisma.$BillingPaymentPayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of BillingPayments.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPaymentCountArgs} args - Arguments to filter BillingPayments to count.
     * @example
     * // Count the number of BillingPayments
     * const count = await prisma.billingPayment.count({
     *   where: {
     *     // ... the filter for the BillingPayments we want to count
     *   }
     * })
    **/
    count<T extends BillingPaymentCountArgs>(
      args?: Subset<T, BillingPaymentCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], BillingPaymentCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a BillingPayment.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPaymentAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends BillingPaymentAggregateArgs>(args: Subset<T, BillingPaymentAggregateArgs>): Prisma.PrismaPromise<GetBillingPaymentAggregateType<T>>

    /**
     * Group by BillingPayment.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingPaymentGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends BillingPaymentGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: BillingPaymentGroupByArgs['orderBy'] }
        : { orderBy?: BillingPaymentGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, BillingPaymentGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetBillingPaymentGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the BillingPayment model
   */
  readonly fields: BillingPaymentFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for BillingPayment.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__BillingPaymentClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    subscription<T extends BillingSubscriptionDefaultArgs<ExtArgs> = {}>(args?: Subset<T, BillingSubscriptionDefaultArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions> | Null, Null, ExtArgs, GlobalOmitOptions>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the BillingPayment model
   */
  interface BillingPaymentFieldRefs {
    readonly id: FieldRef<"BillingPayment", 'String'>
    readonly projectId: FieldRef<"BillingPayment", 'String'>
    readonly subscriptionId: FieldRef<"BillingPayment", 'String'>
    readonly amountMinor: FieldRef<"BillingPayment", 'BigInt'>
    readonly currency: FieldRef<"BillingPayment", 'String'>
    readonly status: FieldRef<"BillingPayment", 'String'>
    readonly provider: FieldRef<"BillingPayment", 'String'>
    readonly providerPaymentId: FieldRef<"BillingPayment", 'String'>
    readonly paidAt: FieldRef<"BillingPayment", 'DateTime'>
    readonly createdAt: FieldRef<"BillingPayment", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * BillingPayment findUnique
   */
  export type BillingPaymentFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * Filter, which BillingPayment to fetch.
     */
    where: BillingPaymentWhereUniqueInput
  }

  /**
   * BillingPayment findUniqueOrThrow
   */
  export type BillingPaymentFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * Filter, which BillingPayment to fetch.
     */
    where: BillingPaymentWhereUniqueInput
  }

  /**
   * BillingPayment findFirst
   */
  export type BillingPaymentFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * Filter, which BillingPayment to fetch.
     */
    where?: BillingPaymentWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPayments to fetch.
     */
    orderBy?: BillingPaymentOrderByWithRelationInput | BillingPaymentOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingPayments.
     */
    cursor?: BillingPaymentWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPayments from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPayments.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPayments.
     */
    distinct?: BillingPaymentScalarFieldEnum | BillingPaymentScalarFieldEnum[]
  }

  /**
   * BillingPayment findFirstOrThrow
   */
  export type BillingPaymentFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * Filter, which BillingPayment to fetch.
     */
    where?: BillingPaymentWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPayments to fetch.
     */
    orderBy?: BillingPaymentOrderByWithRelationInput | BillingPaymentOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingPayments.
     */
    cursor?: BillingPaymentWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPayments from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPayments.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPayments.
     */
    distinct?: BillingPaymentScalarFieldEnum | BillingPaymentScalarFieldEnum[]
  }

  /**
   * BillingPayment findMany
   */
  export type BillingPaymentFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * Filter, which BillingPayments to fetch.
     */
    where?: BillingPaymentWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingPayments to fetch.
     */
    orderBy?: BillingPaymentOrderByWithRelationInput | BillingPaymentOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing BillingPayments.
     */
    cursor?: BillingPaymentWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingPayments from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingPayments.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingPayments.
     */
    distinct?: BillingPaymentScalarFieldEnum | BillingPaymentScalarFieldEnum[]
  }

  /**
   * BillingPayment create
   */
  export type BillingPaymentCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * The data needed to create a BillingPayment.
     */
    data: XOR<BillingPaymentCreateInput, BillingPaymentUncheckedCreateInput>
  }

  /**
   * BillingPayment createMany
   */
  export type BillingPaymentCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many BillingPayments.
     */
    data: BillingPaymentCreateManyInput | BillingPaymentCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingPayment createManyAndReturn
   */
  export type BillingPaymentCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * The data used to create many BillingPayments.
     */
    data: BillingPaymentCreateManyInput | BillingPaymentCreateManyInput[]
    skipDuplicates?: boolean
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentIncludeCreateManyAndReturn<ExtArgs> | null
  }

  /**
   * BillingPayment update
   */
  export type BillingPaymentUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * The data needed to update a BillingPayment.
     */
    data: XOR<BillingPaymentUpdateInput, BillingPaymentUncheckedUpdateInput>
    /**
     * Choose, which BillingPayment to update.
     */
    where: BillingPaymentWhereUniqueInput
  }

  /**
   * BillingPayment updateMany
   */
  export type BillingPaymentUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update BillingPayments.
     */
    data: XOR<BillingPaymentUpdateManyMutationInput, BillingPaymentUncheckedUpdateManyInput>
    /**
     * Filter which BillingPayments to update
     */
    where?: BillingPaymentWhereInput
    /**
     * Limit how many BillingPayments to update.
     */
    limit?: number
  }

  /**
   * BillingPayment updateManyAndReturn
   */
  export type BillingPaymentUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * The data used to update BillingPayments.
     */
    data: XOR<BillingPaymentUpdateManyMutationInput, BillingPaymentUncheckedUpdateManyInput>
    /**
     * Filter which BillingPayments to update
     */
    where?: BillingPaymentWhereInput
    /**
     * Limit how many BillingPayments to update.
     */
    limit?: number
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentIncludeUpdateManyAndReturn<ExtArgs> | null
  }

  /**
   * BillingPayment upsert
   */
  export type BillingPaymentUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * The filter to search for the BillingPayment to update in case it exists.
     */
    where: BillingPaymentWhereUniqueInput
    /**
     * In case the BillingPayment found by the `where` argument doesn't exist, create a new BillingPayment with this data.
     */
    create: XOR<BillingPaymentCreateInput, BillingPaymentUncheckedCreateInput>
    /**
     * In case the BillingPayment was found with the provided `where` argument, update it with this data.
     */
    update: XOR<BillingPaymentUpdateInput, BillingPaymentUncheckedUpdateInput>
  }

  /**
   * BillingPayment delete
   */
  export type BillingPaymentDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
    /**
     * Filter which BillingPayment to delete.
     */
    where: BillingPaymentWhereUniqueInput
  }

  /**
   * BillingPayment deleteMany
   */
  export type BillingPaymentDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingPayments to delete
     */
    where?: BillingPaymentWhereInput
    /**
     * Limit how many BillingPayments to delete.
     */
    limit?: number
  }

  /**
   * BillingPayment without action
   */
  export type BillingPaymentDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingPayment
     */
    select?: BillingPaymentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingPayment
     */
    omit?: BillingPaymentOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingPaymentInclude<ExtArgs> | null
  }


  /**
   * Model BillingInvoice
   */

  export type AggregateBillingInvoice = {
    _count: BillingInvoiceCountAggregateOutputType | null
    _avg: BillingInvoiceAvgAggregateOutputType | null
    _sum: BillingInvoiceSumAggregateOutputType | null
    _min: BillingInvoiceMinAggregateOutputType | null
    _max: BillingInvoiceMaxAggregateOutputType | null
  }

  export type BillingInvoiceAvgAggregateOutputType = {
    amountMinor: number | null
  }

  export type BillingInvoiceSumAggregateOutputType = {
    amountMinor: bigint | null
  }

  export type BillingInvoiceMinAggregateOutputType = {
    id: string | null
    projectId: string | null
    subscriptionId: string | null
    number: string | null
    amountMinor: bigint | null
    currency: string | null
    status: string | null
    issuedAt: Date | null
    dueAt: Date | null
    paidAt: Date | null
    createdAt: Date | null
  }

  export type BillingInvoiceMaxAggregateOutputType = {
    id: string | null
    projectId: string | null
    subscriptionId: string | null
    number: string | null
    amountMinor: bigint | null
    currency: string | null
    status: string | null
    issuedAt: Date | null
    dueAt: Date | null
    paidAt: Date | null
    createdAt: Date | null
  }

  export type BillingInvoiceCountAggregateOutputType = {
    id: number
    projectId: number
    subscriptionId: number
    number: number
    amountMinor: number
    currency: number
    status: number
    issuedAt: number
    dueAt: number
    paidAt: number
    createdAt: number
    _all: number
  }


  export type BillingInvoiceAvgAggregateInputType = {
    amountMinor?: true
  }

  export type BillingInvoiceSumAggregateInputType = {
    amountMinor?: true
  }

  export type BillingInvoiceMinAggregateInputType = {
    id?: true
    projectId?: true
    subscriptionId?: true
    number?: true
    amountMinor?: true
    currency?: true
    status?: true
    issuedAt?: true
    dueAt?: true
    paidAt?: true
    createdAt?: true
  }

  export type BillingInvoiceMaxAggregateInputType = {
    id?: true
    projectId?: true
    subscriptionId?: true
    number?: true
    amountMinor?: true
    currency?: true
    status?: true
    issuedAt?: true
    dueAt?: true
    paidAt?: true
    createdAt?: true
  }

  export type BillingInvoiceCountAggregateInputType = {
    id?: true
    projectId?: true
    subscriptionId?: true
    number?: true
    amountMinor?: true
    currency?: true
    status?: true
    issuedAt?: true
    dueAt?: true
    paidAt?: true
    createdAt?: true
    _all?: true
  }

  export type BillingInvoiceAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingInvoice to aggregate.
     */
    where?: BillingInvoiceWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingInvoices to fetch.
     */
    orderBy?: BillingInvoiceOrderByWithRelationInput | BillingInvoiceOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: BillingInvoiceWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingInvoices from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingInvoices.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned BillingInvoices
    **/
    _count?: true | BillingInvoiceCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: BillingInvoiceAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: BillingInvoiceSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: BillingInvoiceMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: BillingInvoiceMaxAggregateInputType
  }

  export type GetBillingInvoiceAggregateType<T extends BillingInvoiceAggregateArgs> = {
        [P in keyof T & keyof AggregateBillingInvoice]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateBillingInvoice[P]>
      : GetScalarType<T[P], AggregateBillingInvoice[P]>
  }




  export type BillingInvoiceGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingInvoiceWhereInput
    orderBy?: BillingInvoiceOrderByWithAggregationInput | BillingInvoiceOrderByWithAggregationInput[]
    by: BillingInvoiceScalarFieldEnum[] | BillingInvoiceScalarFieldEnum
    having?: BillingInvoiceScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: BillingInvoiceCountAggregateInputType | true
    _avg?: BillingInvoiceAvgAggregateInputType
    _sum?: BillingInvoiceSumAggregateInputType
    _min?: BillingInvoiceMinAggregateInputType
    _max?: BillingInvoiceMaxAggregateInputType
  }

  export type BillingInvoiceGroupByOutputType = {
    id: string
    projectId: string
    subscriptionId: string
    number: string
    amountMinor: bigint
    currency: string
    status: string
    issuedAt: Date
    dueAt: Date
    paidAt: Date | null
    createdAt: Date
    _count: BillingInvoiceCountAggregateOutputType | null
    _avg: BillingInvoiceAvgAggregateOutputType | null
    _sum: BillingInvoiceSumAggregateOutputType | null
    _min: BillingInvoiceMinAggregateOutputType | null
    _max: BillingInvoiceMaxAggregateOutputType | null
  }

  type GetBillingInvoiceGroupByPayload<T extends BillingInvoiceGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<BillingInvoiceGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof BillingInvoiceGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], BillingInvoiceGroupByOutputType[P]>
            : GetScalarType<T[P], BillingInvoiceGroupByOutputType[P]>
        }
      >
    >


  export type BillingInvoiceSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    subscriptionId?: boolean
    number?: boolean
    amountMinor?: boolean
    currency?: boolean
    status?: boolean
    issuedAt?: boolean
    dueAt?: boolean
    paidAt?: boolean
    createdAt?: boolean
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingInvoice"]>

  export type BillingInvoiceSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    subscriptionId?: boolean
    number?: boolean
    amountMinor?: boolean
    currency?: boolean
    status?: boolean
    issuedAt?: boolean
    dueAt?: boolean
    paidAt?: boolean
    createdAt?: boolean
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingInvoice"]>

  export type BillingInvoiceSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    subscriptionId?: boolean
    number?: boolean
    amountMinor?: boolean
    currency?: boolean
    status?: boolean
    issuedAt?: boolean
    dueAt?: boolean
    paidAt?: boolean
    createdAt?: boolean
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }, ExtArgs["result"]["billingInvoice"]>

  export type BillingInvoiceSelectScalar = {
    id?: boolean
    projectId?: boolean
    subscriptionId?: boolean
    number?: boolean
    amountMinor?: boolean
    currency?: boolean
    status?: boolean
    issuedAt?: boolean
    dueAt?: boolean
    paidAt?: boolean
    createdAt?: boolean
  }

  export type BillingInvoiceOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"id" | "projectId" | "subscriptionId" | "number" | "amountMinor" | "currency" | "status" | "issuedAt" | "dueAt" | "paidAt" | "createdAt", ExtArgs["result"]["billingInvoice"]>
  export type BillingInvoiceInclude<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }
  export type BillingInvoiceIncludeCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }
  export type BillingInvoiceIncludeUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    subscription?: boolean | BillingSubscriptionDefaultArgs<ExtArgs>
  }

  export type $BillingInvoicePayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "BillingInvoice"
    objects: {
      subscription: Prisma.$BillingSubscriptionPayload<ExtArgs>
    }
    scalars: $Extensions.GetPayloadResult<{
      id: string
      projectId: string
      subscriptionId: string
      number: string
      amountMinor: bigint
      currency: string
      status: string
      issuedAt: Date
      dueAt: Date
      paidAt: Date | null
      createdAt: Date
    }, ExtArgs["result"]["billingInvoice"]>
    composites: {}
  }

  type BillingInvoiceGetPayload<S extends boolean | null | undefined | BillingInvoiceDefaultArgs> = $Result.GetResult<Prisma.$BillingInvoicePayload, S>

  type BillingInvoiceCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<BillingInvoiceFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: BillingInvoiceCountAggregateInputType | true
    }

  export interface BillingInvoiceDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['BillingInvoice'], meta: { name: 'BillingInvoice' } }
    /**
     * Find zero or one BillingInvoice that matches the filter.
     * @param {BillingInvoiceFindUniqueArgs} args - Arguments to find a BillingInvoice
     * @example
     * // Get one BillingInvoice
     * const billingInvoice = await prisma.billingInvoice.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends BillingInvoiceFindUniqueArgs>(args: SelectSubset<T, BillingInvoiceFindUniqueArgs<ExtArgs>>): Prisma__BillingInvoiceClient<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one BillingInvoice that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {BillingInvoiceFindUniqueOrThrowArgs} args - Arguments to find a BillingInvoice
     * @example
     * // Get one BillingInvoice
     * const billingInvoice = await prisma.billingInvoice.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends BillingInvoiceFindUniqueOrThrowArgs>(args: SelectSubset<T, BillingInvoiceFindUniqueOrThrowArgs<ExtArgs>>): Prisma__BillingInvoiceClient<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingInvoice that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingInvoiceFindFirstArgs} args - Arguments to find a BillingInvoice
     * @example
     * // Get one BillingInvoice
     * const billingInvoice = await prisma.billingInvoice.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends BillingInvoiceFindFirstArgs>(args?: SelectSubset<T, BillingInvoiceFindFirstArgs<ExtArgs>>): Prisma__BillingInvoiceClient<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingInvoice that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingInvoiceFindFirstOrThrowArgs} args - Arguments to find a BillingInvoice
     * @example
     * // Get one BillingInvoice
     * const billingInvoice = await prisma.billingInvoice.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends BillingInvoiceFindFirstOrThrowArgs>(args?: SelectSubset<T, BillingInvoiceFindFirstOrThrowArgs<ExtArgs>>): Prisma__BillingInvoiceClient<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more BillingInvoices that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingInvoiceFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all BillingInvoices
     * const billingInvoices = await prisma.billingInvoice.findMany()
     * 
     * // Get first 10 BillingInvoices
     * const billingInvoices = await prisma.billingInvoice.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const billingInvoiceWithIdOnly = await prisma.billingInvoice.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends BillingInvoiceFindManyArgs>(args?: SelectSubset<T, BillingInvoiceFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a BillingInvoice.
     * @param {BillingInvoiceCreateArgs} args - Arguments to create a BillingInvoice.
     * @example
     * // Create one BillingInvoice
     * const BillingInvoice = await prisma.billingInvoice.create({
     *   data: {
     *     // ... data to create a BillingInvoice
     *   }
     * })
     * 
     */
    create<T extends BillingInvoiceCreateArgs>(args: SelectSubset<T, BillingInvoiceCreateArgs<ExtArgs>>): Prisma__BillingInvoiceClient<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many BillingInvoices.
     * @param {BillingInvoiceCreateManyArgs} args - Arguments to create many BillingInvoices.
     * @example
     * // Create many BillingInvoices
     * const billingInvoice = await prisma.billingInvoice.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends BillingInvoiceCreateManyArgs>(args?: SelectSubset<T, BillingInvoiceCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many BillingInvoices and returns the data saved in the database.
     * @param {BillingInvoiceCreateManyAndReturnArgs} args - Arguments to create many BillingInvoices.
     * @example
     * // Create many BillingInvoices
     * const billingInvoice = await prisma.billingInvoice.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many BillingInvoices and only return the `id`
     * const billingInvoiceWithIdOnly = await prisma.billingInvoice.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends BillingInvoiceCreateManyAndReturnArgs>(args?: SelectSubset<T, BillingInvoiceCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a BillingInvoice.
     * @param {BillingInvoiceDeleteArgs} args - Arguments to delete one BillingInvoice.
     * @example
     * // Delete one BillingInvoice
     * const BillingInvoice = await prisma.billingInvoice.delete({
     *   where: {
     *     // ... filter to delete one BillingInvoice
     *   }
     * })
     * 
     */
    delete<T extends BillingInvoiceDeleteArgs>(args: SelectSubset<T, BillingInvoiceDeleteArgs<ExtArgs>>): Prisma__BillingInvoiceClient<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one BillingInvoice.
     * @param {BillingInvoiceUpdateArgs} args - Arguments to update one BillingInvoice.
     * @example
     * // Update one BillingInvoice
     * const billingInvoice = await prisma.billingInvoice.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends BillingInvoiceUpdateArgs>(args: SelectSubset<T, BillingInvoiceUpdateArgs<ExtArgs>>): Prisma__BillingInvoiceClient<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more BillingInvoices.
     * @param {BillingInvoiceDeleteManyArgs} args - Arguments to filter BillingInvoices to delete.
     * @example
     * // Delete a few BillingInvoices
     * const { count } = await prisma.billingInvoice.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends BillingInvoiceDeleteManyArgs>(args?: SelectSubset<T, BillingInvoiceDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingInvoices.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingInvoiceUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many BillingInvoices
     * const billingInvoice = await prisma.billingInvoice.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends BillingInvoiceUpdateManyArgs>(args: SelectSubset<T, BillingInvoiceUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingInvoices and returns the data updated in the database.
     * @param {BillingInvoiceUpdateManyAndReturnArgs} args - Arguments to update many BillingInvoices.
     * @example
     * // Update many BillingInvoices
     * const billingInvoice = await prisma.billingInvoice.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more BillingInvoices and only return the `id`
     * const billingInvoiceWithIdOnly = await prisma.billingInvoice.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends BillingInvoiceUpdateManyAndReturnArgs>(args: SelectSubset<T, BillingInvoiceUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one BillingInvoice.
     * @param {BillingInvoiceUpsertArgs} args - Arguments to update or create a BillingInvoice.
     * @example
     * // Update or create a BillingInvoice
     * const billingInvoice = await prisma.billingInvoice.upsert({
     *   create: {
     *     // ... data to create a BillingInvoice
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the BillingInvoice we want to update
     *   }
     * })
     */
    upsert<T extends BillingInvoiceUpsertArgs>(args: SelectSubset<T, BillingInvoiceUpsertArgs<ExtArgs>>): Prisma__BillingInvoiceClient<$Result.GetResult<Prisma.$BillingInvoicePayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of BillingInvoices.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingInvoiceCountArgs} args - Arguments to filter BillingInvoices to count.
     * @example
     * // Count the number of BillingInvoices
     * const count = await prisma.billingInvoice.count({
     *   where: {
     *     // ... the filter for the BillingInvoices we want to count
     *   }
     * })
    **/
    count<T extends BillingInvoiceCountArgs>(
      args?: Subset<T, BillingInvoiceCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], BillingInvoiceCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a BillingInvoice.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingInvoiceAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends BillingInvoiceAggregateArgs>(args: Subset<T, BillingInvoiceAggregateArgs>): Prisma.PrismaPromise<GetBillingInvoiceAggregateType<T>>

    /**
     * Group by BillingInvoice.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingInvoiceGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends BillingInvoiceGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: BillingInvoiceGroupByArgs['orderBy'] }
        : { orderBy?: BillingInvoiceGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, BillingInvoiceGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetBillingInvoiceGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the BillingInvoice model
   */
  readonly fields: BillingInvoiceFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for BillingInvoice.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__BillingInvoiceClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    subscription<T extends BillingSubscriptionDefaultArgs<ExtArgs> = {}>(args?: Subset<T, BillingSubscriptionDefaultArgs<ExtArgs>>): Prisma__BillingSubscriptionClient<$Result.GetResult<Prisma.$BillingSubscriptionPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions> | Null, Null, ExtArgs, GlobalOmitOptions>
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the BillingInvoice model
   */
  interface BillingInvoiceFieldRefs {
    readonly id: FieldRef<"BillingInvoice", 'String'>
    readonly projectId: FieldRef<"BillingInvoice", 'String'>
    readonly subscriptionId: FieldRef<"BillingInvoice", 'String'>
    readonly number: FieldRef<"BillingInvoice", 'String'>
    readonly amountMinor: FieldRef<"BillingInvoice", 'BigInt'>
    readonly currency: FieldRef<"BillingInvoice", 'String'>
    readonly status: FieldRef<"BillingInvoice", 'String'>
    readonly issuedAt: FieldRef<"BillingInvoice", 'DateTime'>
    readonly dueAt: FieldRef<"BillingInvoice", 'DateTime'>
    readonly paidAt: FieldRef<"BillingInvoice", 'DateTime'>
    readonly createdAt: FieldRef<"BillingInvoice", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * BillingInvoice findUnique
   */
  export type BillingInvoiceFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * Filter, which BillingInvoice to fetch.
     */
    where: BillingInvoiceWhereUniqueInput
  }

  /**
   * BillingInvoice findUniqueOrThrow
   */
  export type BillingInvoiceFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * Filter, which BillingInvoice to fetch.
     */
    where: BillingInvoiceWhereUniqueInput
  }

  /**
   * BillingInvoice findFirst
   */
  export type BillingInvoiceFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * Filter, which BillingInvoice to fetch.
     */
    where?: BillingInvoiceWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingInvoices to fetch.
     */
    orderBy?: BillingInvoiceOrderByWithRelationInput | BillingInvoiceOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingInvoices.
     */
    cursor?: BillingInvoiceWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingInvoices from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingInvoices.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingInvoices.
     */
    distinct?: BillingInvoiceScalarFieldEnum | BillingInvoiceScalarFieldEnum[]
  }

  /**
   * BillingInvoice findFirstOrThrow
   */
  export type BillingInvoiceFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * Filter, which BillingInvoice to fetch.
     */
    where?: BillingInvoiceWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingInvoices to fetch.
     */
    orderBy?: BillingInvoiceOrderByWithRelationInput | BillingInvoiceOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingInvoices.
     */
    cursor?: BillingInvoiceWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingInvoices from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingInvoices.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingInvoices.
     */
    distinct?: BillingInvoiceScalarFieldEnum | BillingInvoiceScalarFieldEnum[]
  }

  /**
   * BillingInvoice findMany
   */
  export type BillingInvoiceFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * Filter, which BillingInvoices to fetch.
     */
    where?: BillingInvoiceWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingInvoices to fetch.
     */
    orderBy?: BillingInvoiceOrderByWithRelationInput | BillingInvoiceOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing BillingInvoices.
     */
    cursor?: BillingInvoiceWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingInvoices from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingInvoices.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingInvoices.
     */
    distinct?: BillingInvoiceScalarFieldEnum | BillingInvoiceScalarFieldEnum[]
  }

  /**
   * BillingInvoice create
   */
  export type BillingInvoiceCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * The data needed to create a BillingInvoice.
     */
    data: XOR<BillingInvoiceCreateInput, BillingInvoiceUncheckedCreateInput>
  }

  /**
   * BillingInvoice createMany
   */
  export type BillingInvoiceCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many BillingInvoices.
     */
    data: BillingInvoiceCreateManyInput | BillingInvoiceCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingInvoice createManyAndReturn
   */
  export type BillingInvoiceCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * The data used to create many BillingInvoices.
     */
    data: BillingInvoiceCreateManyInput | BillingInvoiceCreateManyInput[]
    skipDuplicates?: boolean
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceIncludeCreateManyAndReturn<ExtArgs> | null
  }

  /**
   * BillingInvoice update
   */
  export type BillingInvoiceUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * The data needed to update a BillingInvoice.
     */
    data: XOR<BillingInvoiceUpdateInput, BillingInvoiceUncheckedUpdateInput>
    /**
     * Choose, which BillingInvoice to update.
     */
    where: BillingInvoiceWhereUniqueInput
  }

  /**
   * BillingInvoice updateMany
   */
  export type BillingInvoiceUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update BillingInvoices.
     */
    data: XOR<BillingInvoiceUpdateManyMutationInput, BillingInvoiceUncheckedUpdateManyInput>
    /**
     * Filter which BillingInvoices to update
     */
    where?: BillingInvoiceWhereInput
    /**
     * Limit how many BillingInvoices to update.
     */
    limit?: number
  }

  /**
   * BillingInvoice updateManyAndReturn
   */
  export type BillingInvoiceUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * The data used to update BillingInvoices.
     */
    data: XOR<BillingInvoiceUpdateManyMutationInput, BillingInvoiceUncheckedUpdateManyInput>
    /**
     * Filter which BillingInvoices to update
     */
    where?: BillingInvoiceWhereInput
    /**
     * Limit how many BillingInvoices to update.
     */
    limit?: number
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceIncludeUpdateManyAndReturn<ExtArgs> | null
  }

  /**
   * BillingInvoice upsert
   */
  export type BillingInvoiceUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * The filter to search for the BillingInvoice to update in case it exists.
     */
    where: BillingInvoiceWhereUniqueInput
    /**
     * In case the BillingInvoice found by the `where` argument doesn't exist, create a new BillingInvoice with this data.
     */
    create: XOR<BillingInvoiceCreateInput, BillingInvoiceUncheckedCreateInput>
    /**
     * In case the BillingInvoice was found with the provided `where` argument, update it with this data.
     */
    update: XOR<BillingInvoiceUpdateInput, BillingInvoiceUncheckedUpdateInput>
  }

  /**
   * BillingInvoice delete
   */
  export type BillingInvoiceDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
    /**
     * Filter which BillingInvoice to delete.
     */
    where: BillingInvoiceWhereUniqueInput
  }

  /**
   * BillingInvoice deleteMany
   */
  export type BillingInvoiceDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingInvoices to delete
     */
    where?: BillingInvoiceWhereInput
    /**
     * Limit how many BillingInvoices to delete.
     */
    limit?: number
  }

  /**
   * BillingInvoice without action
   */
  export type BillingInvoiceDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingInvoice
     */
    select?: BillingInvoiceSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingInvoice
     */
    omit?: BillingInvoiceOmit<ExtArgs> | null
    /**
     * Choose, which related nodes to fetch as well
     */
    include?: BillingInvoiceInclude<ExtArgs> | null
  }


  /**
   * Model BillingQuotaUsage
   */

  export type AggregateBillingQuotaUsage = {
    _count: BillingQuotaUsageCountAggregateOutputType | null
    _avg: BillingQuotaUsageAvgAggregateOutputType | null
    _sum: BillingQuotaUsageSumAggregateOutputType | null
    _min: BillingQuotaUsageMinAggregateOutputType | null
    _max: BillingQuotaUsageMaxAggregateOutputType | null
  }

  export type BillingQuotaUsageAvgAggregateOutputType = {
    used: number | null
  }

  export type BillingQuotaUsageSumAggregateOutputType = {
    used: bigint | null
  }

  export type BillingQuotaUsageMinAggregateOutputType = {
    id: string | null
    projectId: string | null
    action: string | null
    periodKey: string | null
    used: bigint | null
    updatedAt: Date | null
    createdAt: Date | null
  }

  export type BillingQuotaUsageMaxAggregateOutputType = {
    id: string | null
    projectId: string | null
    action: string | null
    periodKey: string | null
    used: bigint | null
    updatedAt: Date | null
    createdAt: Date | null
  }

  export type BillingQuotaUsageCountAggregateOutputType = {
    id: number
    projectId: number
    action: number
    periodKey: number
    used: number
    updatedAt: number
    createdAt: number
    _all: number
  }


  export type BillingQuotaUsageAvgAggregateInputType = {
    used?: true
  }

  export type BillingQuotaUsageSumAggregateInputType = {
    used?: true
  }

  export type BillingQuotaUsageMinAggregateInputType = {
    id?: true
    projectId?: true
    action?: true
    periodKey?: true
    used?: true
    updatedAt?: true
    createdAt?: true
  }

  export type BillingQuotaUsageMaxAggregateInputType = {
    id?: true
    projectId?: true
    action?: true
    periodKey?: true
    used?: true
    updatedAt?: true
    createdAt?: true
  }

  export type BillingQuotaUsageCountAggregateInputType = {
    id?: true
    projectId?: true
    action?: true
    periodKey?: true
    used?: true
    updatedAt?: true
    createdAt?: true
    _all?: true
  }

  export type BillingQuotaUsageAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingQuotaUsage to aggregate.
     */
    where?: BillingQuotaUsageWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingQuotaUsages to fetch.
     */
    orderBy?: BillingQuotaUsageOrderByWithRelationInput | BillingQuotaUsageOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: BillingQuotaUsageWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingQuotaUsages from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingQuotaUsages.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned BillingQuotaUsages
    **/
    _count?: true | BillingQuotaUsageCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: BillingQuotaUsageAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: BillingQuotaUsageSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: BillingQuotaUsageMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: BillingQuotaUsageMaxAggregateInputType
  }

  export type GetBillingQuotaUsageAggregateType<T extends BillingQuotaUsageAggregateArgs> = {
        [P in keyof T & keyof AggregateBillingQuotaUsage]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateBillingQuotaUsage[P]>
      : GetScalarType<T[P], AggregateBillingQuotaUsage[P]>
  }




  export type BillingQuotaUsageGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingQuotaUsageWhereInput
    orderBy?: BillingQuotaUsageOrderByWithAggregationInput | BillingQuotaUsageOrderByWithAggregationInput[]
    by: BillingQuotaUsageScalarFieldEnum[] | BillingQuotaUsageScalarFieldEnum
    having?: BillingQuotaUsageScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: BillingQuotaUsageCountAggregateInputType | true
    _avg?: BillingQuotaUsageAvgAggregateInputType
    _sum?: BillingQuotaUsageSumAggregateInputType
    _min?: BillingQuotaUsageMinAggregateInputType
    _max?: BillingQuotaUsageMaxAggregateInputType
  }

  export type BillingQuotaUsageGroupByOutputType = {
    id: string
    projectId: string
    action: string
    periodKey: string
    used: bigint
    updatedAt: Date
    createdAt: Date
    _count: BillingQuotaUsageCountAggregateOutputType | null
    _avg: BillingQuotaUsageAvgAggregateOutputType | null
    _sum: BillingQuotaUsageSumAggregateOutputType | null
    _min: BillingQuotaUsageMinAggregateOutputType | null
    _max: BillingQuotaUsageMaxAggregateOutputType | null
  }

  type GetBillingQuotaUsageGroupByPayload<T extends BillingQuotaUsageGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<BillingQuotaUsageGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof BillingQuotaUsageGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], BillingQuotaUsageGroupByOutputType[P]>
            : GetScalarType<T[P], BillingQuotaUsageGroupByOutputType[P]>
        }
      >
    >


  export type BillingQuotaUsageSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    action?: boolean
    periodKey?: boolean
    used?: boolean
    updatedAt?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["billingQuotaUsage"]>

  export type BillingQuotaUsageSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    action?: boolean
    periodKey?: boolean
    used?: boolean
    updatedAt?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["billingQuotaUsage"]>

  export type BillingQuotaUsageSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    action?: boolean
    periodKey?: boolean
    used?: boolean
    updatedAt?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["billingQuotaUsage"]>

  export type BillingQuotaUsageSelectScalar = {
    id?: boolean
    projectId?: boolean
    action?: boolean
    periodKey?: boolean
    used?: boolean
    updatedAt?: boolean
    createdAt?: boolean
  }

  export type BillingQuotaUsageOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"id" | "projectId" | "action" | "periodKey" | "used" | "updatedAt" | "createdAt", ExtArgs["result"]["billingQuotaUsage"]>

  export type $BillingQuotaUsagePayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "BillingQuotaUsage"
    objects: {}
    scalars: $Extensions.GetPayloadResult<{
      id: string
      projectId: string
      action: string
      periodKey: string
      used: bigint
      updatedAt: Date
      createdAt: Date
    }, ExtArgs["result"]["billingQuotaUsage"]>
    composites: {}
  }

  type BillingQuotaUsageGetPayload<S extends boolean | null | undefined | BillingQuotaUsageDefaultArgs> = $Result.GetResult<Prisma.$BillingQuotaUsagePayload, S>

  type BillingQuotaUsageCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<BillingQuotaUsageFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: BillingQuotaUsageCountAggregateInputType | true
    }

  export interface BillingQuotaUsageDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['BillingQuotaUsage'], meta: { name: 'BillingQuotaUsage' } }
    /**
     * Find zero or one BillingQuotaUsage that matches the filter.
     * @param {BillingQuotaUsageFindUniqueArgs} args - Arguments to find a BillingQuotaUsage
     * @example
     * // Get one BillingQuotaUsage
     * const billingQuotaUsage = await prisma.billingQuotaUsage.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends BillingQuotaUsageFindUniqueArgs>(args: SelectSubset<T, BillingQuotaUsageFindUniqueArgs<ExtArgs>>): Prisma__BillingQuotaUsageClient<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one BillingQuotaUsage that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {BillingQuotaUsageFindUniqueOrThrowArgs} args - Arguments to find a BillingQuotaUsage
     * @example
     * // Get one BillingQuotaUsage
     * const billingQuotaUsage = await prisma.billingQuotaUsage.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends BillingQuotaUsageFindUniqueOrThrowArgs>(args: SelectSubset<T, BillingQuotaUsageFindUniqueOrThrowArgs<ExtArgs>>): Prisma__BillingQuotaUsageClient<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingQuotaUsage that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingQuotaUsageFindFirstArgs} args - Arguments to find a BillingQuotaUsage
     * @example
     * // Get one BillingQuotaUsage
     * const billingQuotaUsage = await prisma.billingQuotaUsage.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends BillingQuotaUsageFindFirstArgs>(args?: SelectSubset<T, BillingQuotaUsageFindFirstArgs<ExtArgs>>): Prisma__BillingQuotaUsageClient<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingQuotaUsage that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingQuotaUsageFindFirstOrThrowArgs} args - Arguments to find a BillingQuotaUsage
     * @example
     * // Get one BillingQuotaUsage
     * const billingQuotaUsage = await prisma.billingQuotaUsage.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends BillingQuotaUsageFindFirstOrThrowArgs>(args?: SelectSubset<T, BillingQuotaUsageFindFirstOrThrowArgs<ExtArgs>>): Prisma__BillingQuotaUsageClient<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more BillingQuotaUsages that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingQuotaUsageFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all BillingQuotaUsages
     * const billingQuotaUsages = await prisma.billingQuotaUsage.findMany()
     * 
     * // Get first 10 BillingQuotaUsages
     * const billingQuotaUsages = await prisma.billingQuotaUsage.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const billingQuotaUsageWithIdOnly = await prisma.billingQuotaUsage.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends BillingQuotaUsageFindManyArgs>(args?: SelectSubset<T, BillingQuotaUsageFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a BillingQuotaUsage.
     * @param {BillingQuotaUsageCreateArgs} args - Arguments to create a BillingQuotaUsage.
     * @example
     * // Create one BillingQuotaUsage
     * const BillingQuotaUsage = await prisma.billingQuotaUsage.create({
     *   data: {
     *     // ... data to create a BillingQuotaUsage
     *   }
     * })
     * 
     */
    create<T extends BillingQuotaUsageCreateArgs>(args: SelectSubset<T, BillingQuotaUsageCreateArgs<ExtArgs>>): Prisma__BillingQuotaUsageClient<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many BillingQuotaUsages.
     * @param {BillingQuotaUsageCreateManyArgs} args - Arguments to create many BillingQuotaUsages.
     * @example
     * // Create many BillingQuotaUsages
     * const billingQuotaUsage = await prisma.billingQuotaUsage.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends BillingQuotaUsageCreateManyArgs>(args?: SelectSubset<T, BillingQuotaUsageCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many BillingQuotaUsages and returns the data saved in the database.
     * @param {BillingQuotaUsageCreateManyAndReturnArgs} args - Arguments to create many BillingQuotaUsages.
     * @example
     * // Create many BillingQuotaUsages
     * const billingQuotaUsage = await prisma.billingQuotaUsage.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many BillingQuotaUsages and only return the `id`
     * const billingQuotaUsageWithIdOnly = await prisma.billingQuotaUsage.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends BillingQuotaUsageCreateManyAndReturnArgs>(args?: SelectSubset<T, BillingQuotaUsageCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a BillingQuotaUsage.
     * @param {BillingQuotaUsageDeleteArgs} args - Arguments to delete one BillingQuotaUsage.
     * @example
     * // Delete one BillingQuotaUsage
     * const BillingQuotaUsage = await prisma.billingQuotaUsage.delete({
     *   where: {
     *     // ... filter to delete one BillingQuotaUsage
     *   }
     * })
     * 
     */
    delete<T extends BillingQuotaUsageDeleteArgs>(args: SelectSubset<T, BillingQuotaUsageDeleteArgs<ExtArgs>>): Prisma__BillingQuotaUsageClient<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one BillingQuotaUsage.
     * @param {BillingQuotaUsageUpdateArgs} args - Arguments to update one BillingQuotaUsage.
     * @example
     * // Update one BillingQuotaUsage
     * const billingQuotaUsage = await prisma.billingQuotaUsage.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends BillingQuotaUsageUpdateArgs>(args: SelectSubset<T, BillingQuotaUsageUpdateArgs<ExtArgs>>): Prisma__BillingQuotaUsageClient<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more BillingQuotaUsages.
     * @param {BillingQuotaUsageDeleteManyArgs} args - Arguments to filter BillingQuotaUsages to delete.
     * @example
     * // Delete a few BillingQuotaUsages
     * const { count } = await prisma.billingQuotaUsage.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends BillingQuotaUsageDeleteManyArgs>(args?: SelectSubset<T, BillingQuotaUsageDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingQuotaUsages.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingQuotaUsageUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many BillingQuotaUsages
     * const billingQuotaUsage = await prisma.billingQuotaUsage.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends BillingQuotaUsageUpdateManyArgs>(args: SelectSubset<T, BillingQuotaUsageUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingQuotaUsages and returns the data updated in the database.
     * @param {BillingQuotaUsageUpdateManyAndReturnArgs} args - Arguments to update many BillingQuotaUsages.
     * @example
     * // Update many BillingQuotaUsages
     * const billingQuotaUsage = await prisma.billingQuotaUsage.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more BillingQuotaUsages and only return the `id`
     * const billingQuotaUsageWithIdOnly = await prisma.billingQuotaUsage.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends BillingQuotaUsageUpdateManyAndReturnArgs>(args: SelectSubset<T, BillingQuotaUsageUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one BillingQuotaUsage.
     * @param {BillingQuotaUsageUpsertArgs} args - Arguments to update or create a BillingQuotaUsage.
     * @example
     * // Update or create a BillingQuotaUsage
     * const billingQuotaUsage = await prisma.billingQuotaUsage.upsert({
     *   create: {
     *     // ... data to create a BillingQuotaUsage
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the BillingQuotaUsage we want to update
     *   }
     * })
     */
    upsert<T extends BillingQuotaUsageUpsertArgs>(args: SelectSubset<T, BillingQuotaUsageUpsertArgs<ExtArgs>>): Prisma__BillingQuotaUsageClient<$Result.GetResult<Prisma.$BillingQuotaUsagePayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of BillingQuotaUsages.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingQuotaUsageCountArgs} args - Arguments to filter BillingQuotaUsages to count.
     * @example
     * // Count the number of BillingQuotaUsages
     * const count = await prisma.billingQuotaUsage.count({
     *   where: {
     *     // ... the filter for the BillingQuotaUsages we want to count
     *   }
     * })
    **/
    count<T extends BillingQuotaUsageCountArgs>(
      args?: Subset<T, BillingQuotaUsageCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], BillingQuotaUsageCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a BillingQuotaUsage.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingQuotaUsageAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends BillingQuotaUsageAggregateArgs>(args: Subset<T, BillingQuotaUsageAggregateArgs>): Prisma.PrismaPromise<GetBillingQuotaUsageAggregateType<T>>

    /**
     * Group by BillingQuotaUsage.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingQuotaUsageGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends BillingQuotaUsageGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: BillingQuotaUsageGroupByArgs['orderBy'] }
        : { orderBy?: BillingQuotaUsageGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, BillingQuotaUsageGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetBillingQuotaUsageGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the BillingQuotaUsage model
   */
  readonly fields: BillingQuotaUsageFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for BillingQuotaUsage.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__BillingQuotaUsageClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the BillingQuotaUsage model
   */
  interface BillingQuotaUsageFieldRefs {
    readonly id: FieldRef<"BillingQuotaUsage", 'String'>
    readonly projectId: FieldRef<"BillingQuotaUsage", 'String'>
    readonly action: FieldRef<"BillingQuotaUsage", 'String'>
    readonly periodKey: FieldRef<"BillingQuotaUsage", 'String'>
    readonly used: FieldRef<"BillingQuotaUsage", 'BigInt'>
    readonly updatedAt: FieldRef<"BillingQuotaUsage", 'DateTime'>
    readonly createdAt: FieldRef<"BillingQuotaUsage", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * BillingQuotaUsage findUnique
   */
  export type BillingQuotaUsageFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * Filter, which BillingQuotaUsage to fetch.
     */
    where: BillingQuotaUsageWhereUniqueInput
  }

  /**
   * BillingQuotaUsage findUniqueOrThrow
   */
  export type BillingQuotaUsageFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * Filter, which BillingQuotaUsage to fetch.
     */
    where: BillingQuotaUsageWhereUniqueInput
  }

  /**
   * BillingQuotaUsage findFirst
   */
  export type BillingQuotaUsageFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * Filter, which BillingQuotaUsage to fetch.
     */
    where?: BillingQuotaUsageWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingQuotaUsages to fetch.
     */
    orderBy?: BillingQuotaUsageOrderByWithRelationInput | BillingQuotaUsageOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingQuotaUsages.
     */
    cursor?: BillingQuotaUsageWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingQuotaUsages from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingQuotaUsages.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingQuotaUsages.
     */
    distinct?: BillingQuotaUsageScalarFieldEnum | BillingQuotaUsageScalarFieldEnum[]
  }

  /**
   * BillingQuotaUsage findFirstOrThrow
   */
  export type BillingQuotaUsageFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * Filter, which BillingQuotaUsage to fetch.
     */
    where?: BillingQuotaUsageWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingQuotaUsages to fetch.
     */
    orderBy?: BillingQuotaUsageOrderByWithRelationInput | BillingQuotaUsageOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingQuotaUsages.
     */
    cursor?: BillingQuotaUsageWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingQuotaUsages from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingQuotaUsages.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingQuotaUsages.
     */
    distinct?: BillingQuotaUsageScalarFieldEnum | BillingQuotaUsageScalarFieldEnum[]
  }

  /**
   * BillingQuotaUsage findMany
   */
  export type BillingQuotaUsageFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * Filter, which BillingQuotaUsages to fetch.
     */
    where?: BillingQuotaUsageWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingQuotaUsages to fetch.
     */
    orderBy?: BillingQuotaUsageOrderByWithRelationInput | BillingQuotaUsageOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing BillingQuotaUsages.
     */
    cursor?: BillingQuotaUsageWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingQuotaUsages from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingQuotaUsages.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingQuotaUsages.
     */
    distinct?: BillingQuotaUsageScalarFieldEnum | BillingQuotaUsageScalarFieldEnum[]
  }

  /**
   * BillingQuotaUsage create
   */
  export type BillingQuotaUsageCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * The data needed to create a BillingQuotaUsage.
     */
    data: XOR<BillingQuotaUsageCreateInput, BillingQuotaUsageUncheckedCreateInput>
  }

  /**
   * BillingQuotaUsage createMany
   */
  export type BillingQuotaUsageCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many BillingQuotaUsages.
     */
    data: BillingQuotaUsageCreateManyInput | BillingQuotaUsageCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingQuotaUsage createManyAndReturn
   */
  export type BillingQuotaUsageCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * The data used to create many BillingQuotaUsages.
     */
    data: BillingQuotaUsageCreateManyInput | BillingQuotaUsageCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingQuotaUsage update
   */
  export type BillingQuotaUsageUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * The data needed to update a BillingQuotaUsage.
     */
    data: XOR<BillingQuotaUsageUpdateInput, BillingQuotaUsageUncheckedUpdateInput>
    /**
     * Choose, which BillingQuotaUsage to update.
     */
    where: BillingQuotaUsageWhereUniqueInput
  }

  /**
   * BillingQuotaUsage updateMany
   */
  export type BillingQuotaUsageUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update BillingQuotaUsages.
     */
    data: XOR<BillingQuotaUsageUpdateManyMutationInput, BillingQuotaUsageUncheckedUpdateManyInput>
    /**
     * Filter which BillingQuotaUsages to update
     */
    where?: BillingQuotaUsageWhereInput
    /**
     * Limit how many BillingQuotaUsages to update.
     */
    limit?: number
  }

  /**
   * BillingQuotaUsage updateManyAndReturn
   */
  export type BillingQuotaUsageUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * The data used to update BillingQuotaUsages.
     */
    data: XOR<BillingQuotaUsageUpdateManyMutationInput, BillingQuotaUsageUncheckedUpdateManyInput>
    /**
     * Filter which BillingQuotaUsages to update
     */
    where?: BillingQuotaUsageWhereInput
    /**
     * Limit how many BillingQuotaUsages to update.
     */
    limit?: number
  }

  /**
   * BillingQuotaUsage upsert
   */
  export type BillingQuotaUsageUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * The filter to search for the BillingQuotaUsage to update in case it exists.
     */
    where: BillingQuotaUsageWhereUniqueInput
    /**
     * In case the BillingQuotaUsage found by the `where` argument doesn't exist, create a new BillingQuotaUsage with this data.
     */
    create: XOR<BillingQuotaUsageCreateInput, BillingQuotaUsageUncheckedCreateInput>
    /**
     * In case the BillingQuotaUsage was found with the provided `where` argument, update it with this data.
     */
    update: XOR<BillingQuotaUsageUpdateInput, BillingQuotaUsageUncheckedUpdateInput>
  }

  /**
   * BillingQuotaUsage delete
   */
  export type BillingQuotaUsageDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
    /**
     * Filter which BillingQuotaUsage to delete.
     */
    where: BillingQuotaUsageWhereUniqueInput
  }

  /**
   * BillingQuotaUsage deleteMany
   */
  export type BillingQuotaUsageDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingQuotaUsages to delete
     */
    where?: BillingQuotaUsageWhereInput
    /**
     * Limit how many BillingQuotaUsages to delete.
     */
    limit?: number
  }

  /**
   * BillingQuotaUsage without action
   */
  export type BillingQuotaUsageDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingQuotaUsage
     */
    select?: BillingQuotaUsageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingQuotaUsage
     */
    omit?: BillingQuotaUsageOmit<ExtArgs> | null
  }


  /**
   * Model ModuleSubscription
   */

  export type AggregateModuleSubscription = {
    _count: ModuleSubscriptionCountAggregateOutputType | null
    _avg: ModuleSubscriptionAvgAggregateOutputType | null
    _sum: ModuleSubscriptionSumAggregateOutputType | null
    _min: ModuleSubscriptionMinAggregateOutputType | null
    _max: ModuleSubscriptionMaxAggregateOutputType | null
  }

  export type ModuleSubscriptionAvgAggregateOutputType = {
    unitPriceMinor: number | null
    revenueShareBps: number | null
  }

  export type ModuleSubscriptionSumAggregateOutputType = {
    unitPriceMinor: bigint | null
    revenueShareBps: number | null
  }

  export type ModuleSubscriptionMinAggregateOutputType = {
    id: string | null
    projectId: string | null
    moduleId: string | null
    priceModel: string | null
    unitPriceMinor: bigint | null
    currency: string | null
    state: string | null
    revenueShareBps: number | null
    partnerId: string | null
    trialEndsAt: Date | null
    gracePeriodEnd: Date | null
    currentPeriodStart: Date | null
    currentPeriodEnd: Date | null
    createdAt: Date | null
    updatedAt: Date | null
  }

  export type ModuleSubscriptionMaxAggregateOutputType = {
    id: string | null
    projectId: string | null
    moduleId: string | null
    priceModel: string | null
    unitPriceMinor: bigint | null
    currency: string | null
    state: string | null
    revenueShareBps: number | null
    partnerId: string | null
    trialEndsAt: Date | null
    gracePeriodEnd: Date | null
    currentPeriodStart: Date | null
    currentPeriodEnd: Date | null
    createdAt: Date | null
    updatedAt: Date | null
  }

  export type ModuleSubscriptionCountAggregateOutputType = {
    id: number
    projectId: number
    moduleId: number
    priceModel: number
    unitPriceMinor: number
    currency: number
    state: number
    revenueShareBps: number
    partnerId: number
    trialEndsAt: number
    gracePeriodEnd: number
    currentPeriodStart: number
    currentPeriodEnd: number
    createdAt: number
    updatedAt: number
    _all: number
  }


  export type ModuleSubscriptionAvgAggregateInputType = {
    unitPriceMinor?: true
    revenueShareBps?: true
  }

  export type ModuleSubscriptionSumAggregateInputType = {
    unitPriceMinor?: true
    revenueShareBps?: true
  }

  export type ModuleSubscriptionMinAggregateInputType = {
    id?: true
    projectId?: true
    moduleId?: true
    priceModel?: true
    unitPriceMinor?: true
    currency?: true
    state?: true
    revenueShareBps?: true
    partnerId?: true
    trialEndsAt?: true
    gracePeriodEnd?: true
    currentPeriodStart?: true
    currentPeriodEnd?: true
    createdAt?: true
    updatedAt?: true
  }

  export type ModuleSubscriptionMaxAggregateInputType = {
    id?: true
    projectId?: true
    moduleId?: true
    priceModel?: true
    unitPriceMinor?: true
    currency?: true
    state?: true
    revenueShareBps?: true
    partnerId?: true
    trialEndsAt?: true
    gracePeriodEnd?: true
    currentPeriodStart?: true
    currentPeriodEnd?: true
    createdAt?: true
    updatedAt?: true
  }

  export type ModuleSubscriptionCountAggregateInputType = {
    id?: true
    projectId?: true
    moduleId?: true
    priceModel?: true
    unitPriceMinor?: true
    currency?: true
    state?: true
    revenueShareBps?: true
    partnerId?: true
    trialEndsAt?: true
    gracePeriodEnd?: true
    currentPeriodStart?: true
    currentPeriodEnd?: true
    createdAt?: true
    updatedAt?: true
    _all?: true
  }

  export type ModuleSubscriptionAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which ModuleSubscription to aggregate.
     */
    where?: ModuleSubscriptionWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of ModuleSubscriptions to fetch.
     */
    orderBy?: ModuleSubscriptionOrderByWithRelationInput | ModuleSubscriptionOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: ModuleSubscriptionWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` ModuleSubscriptions from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` ModuleSubscriptions.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned ModuleSubscriptions
    **/
    _count?: true | ModuleSubscriptionCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: ModuleSubscriptionAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: ModuleSubscriptionSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: ModuleSubscriptionMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: ModuleSubscriptionMaxAggregateInputType
  }

  export type GetModuleSubscriptionAggregateType<T extends ModuleSubscriptionAggregateArgs> = {
        [P in keyof T & keyof AggregateModuleSubscription]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateModuleSubscription[P]>
      : GetScalarType<T[P], AggregateModuleSubscription[P]>
  }




  export type ModuleSubscriptionGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: ModuleSubscriptionWhereInput
    orderBy?: ModuleSubscriptionOrderByWithAggregationInput | ModuleSubscriptionOrderByWithAggregationInput[]
    by: ModuleSubscriptionScalarFieldEnum[] | ModuleSubscriptionScalarFieldEnum
    having?: ModuleSubscriptionScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: ModuleSubscriptionCountAggregateInputType | true
    _avg?: ModuleSubscriptionAvgAggregateInputType
    _sum?: ModuleSubscriptionSumAggregateInputType
    _min?: ModuleSubscriptionMinAggregateInputType
    _max?: ModuleSubscriptionMaxAggregateInputType
  }

  export type ModuleSubscriptionGroupByOutputType = {
    id: string
    projectId: string
    moduleId: string
    priceModel: string
    unitPriceMinor: bigint
    currency: string
    state: string
    revenueShareBps: number
    partnerId: string | null
    trialEndsAt: Date | null
    gracePeriodEnd: Date | null
    currentPeriodStart: Date
    currentPeriodEnd: Date
    createdAt: Date
    updatedAt: Date
    _count: ModuleSubscriptionCountAggregateOutputType | null
    _avg: ModuleSubscriptionAvgAggregateOutputType | null
    _sum: ModuleSubscriptionSumAggregateOutputType | null
    _min: ModuleSubscriptionMinAggregateOutputType | null
    _max: ModuleSubscriptionMaxAggregateOutputType | null
  }

  type GetModuleSubscriptionGroupByPayload<T extends ModuleSubscriptionGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<ModuleSubscriptionGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof ModuleSubscriptionGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], ModuleSubscriptionGroupByOutputType[P]>
            : GetScalarType<T[P], ModuleSubscriptionGroupByOutputType[P]>
        }
      >
    >


  export type ModuleSubscriptionSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    moduleId?: boolean
    priceModel?: boolean
    unitPriceMinor?: boolean
    currency?: boolean
    state?: boolean
    revenueShareBps?: boolean
    partnerId?: boolean
    trialEndsAt?: boolean
    gracePeriodEnd?: boolean
    currentPeriodStart?: boolean
    currentPeriodEnd?: boolean
    createdAt?: boolean
    updatedAt?: boolean
  }, ExtArgs["result"]["moduleSubscription"]>

  export type ModuleSubscriptionSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    moduleId?: boolean
    priceModel?: boolean
    unitPriceMinor?: boolean
    currency?: boolean
    state?: boolean
    revenueShareBps?: boolean
    partnerId?: boolean
    trialEndsAt?: boolean
    gracePeriodEnd?: boolean
    currentPeriodStart?: boolean
    currentPeriodEnd?: boolean
    createdAt?: boolean
    updatedAt?: boolean
  }, ExtArgs["result"]["moduleSubscription"]>

  export type ModuleSubscriptionSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    moduleId?: boolean
    priceModel?: boolean
    unitPriceMinor?: boolean
    currency?: boolean
    state?: boolean
    revenueShareBps?: boolean
    partnerId?: boolean
    trialEndsAt?: boolean
    gracePeriodEnd?: boolean
    currentPeriodStart?: boolean
    currentPeriodEnd?: boolean
    createdAt?: boolean
    updatedAt?: boolean
  }, ExtArgs["result"]["moduleSubscription"]>

  export type ModuleSubscriptionSelectScalar = {
    id?: boolean
    projectId?: boolean
    moduleId?: boolean
    priceModel?: boolean
    unitPriceMinor?: boolean
    currency?: boolean
    state?: boolean
    revenueShareBps?: boolean
    partnerId?: boolean
    trialEndsAt?: boolean
    gracePeriodEnd?: boolean
    currentPeriodStart?: boolean
    currentPeriodEnd?: boolean
    createdAt?: boolean
    updatedAt?: boolean
  }

  export type ModuleSubscriptionOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"id" | "projectId" | "moduleId" | "priceModel" | "unitPriceMinor" | "currency" | "state" | "revenueShareBps" | "partnerId" | "trialEndsAt" | "gracePeriodEnd" | "currentPeriodStart" | "currentPeriodEnd" | "createdAt" | "updatedAt", ExtArgs["result"]["moduleSubscription"]>

  export type $ModuleSubscriptionPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "ModuleSubscription"
    objects: {}
    scalars: $Extensions.GetPayloadResult<{
      id: string
      projectId: string
      moduleId: string
      priceModel: string
      unitPriceMinor: bigint
      currency: string
      state: string
      revenueShareBps: number
      partnerId: string | null
      trialEndsAt: Date | null
      gracePeriodEnd: Date | null
      currentPeriodStart: Date
      currentPeriodEnd: Date
      createdAt: Date
      updatedAt: Date
    }, ExtArgs["result"]["moduleSubscription"]>
    composites: {}
  }

  type ModuleSubscriptionGetPayload<S extends boolean | null | undefined | ModuleSubscriptionDefaultArgs> = $Result.GetResult<Prisma.$ModuleSubscriptionPayload, S>

  type ModuleSubscriptionCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<ModuleSubscriptionFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: ModuleSubscriptionCountAggregateInputType | true
    }

  export interface ModuleSubscriptionDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['ModuleSubscription'], meta: { name: 'ModuleSubscription' } }
    /**
     * Find zero or one ModuleSubscription that matches the filter.
     * @param {ModuleSubscriptionFindUniqueArgs} args - Arguments to find a ModuleSubscription
     * @example
     * // Get one ModuleSubscription
     * const moduleSubscription = await prisma.moduleSubscription.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends ModuleSubscriptionFindUniqueArgs>(args: SelectSubset<T, ModuleSubscriptionFindUniqueArgs<ExtArgs>>): Prisma__ModuleSubscriptionClient<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one ModuleSubscription that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {ModuleSubscriptionFindUniqueOrThrowArgs} args - Arguments to find a ModuleSubscription
     * @example
     * // Get one ModuleSubscription
     * const moduleSubscription = await prisma.moduleSubscription.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends ModuleSubscriptionFindUniqueOrThrowArgs>(args: SelectSubset<T, ModuleSubscriptionFindUniqueOrThrowArgs<ExtArgs>>): Prisma__ModuleSubscriptionClient<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first ModuleSubscription that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ModuleSubscriptionFindFirstArgs} args - Arguments to find a ModuleSubscription
     * @example
     * // Get one ModuleSubscription
     * const moduleSubscription = await prisma.moduleSubscription.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends ModuleSubscriptionFindFirstArgs>(args?: SelectSubset<T, ModuleSubscriptionFindFirstArgs<ExtArgs>>): Prisma__ModuleSubscriptionClient<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first ModuleSubscription that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ModuleSubscriptionFindFirstOrThrowArgs} args - Arguments to find a ModuleSubscription
     * @example
     * // Get one ModuleSubscription
     * const moduleSubscription = await prisma.moduleSubscription.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends ModuleSubscriptionFindFirstOrThrowArgs>(args?: SelectSubset<T, ModuleSubscriptionFindFirstOrThrowArgs<ExtArgs>>): Prisma__ModuleSubscriptionClient<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more ModuleSubscriptions that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ModuleSubscriptionFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all ModuleSubscriptions
     * const moduleSubscriptions = await prisma.moduleSubscription.findMany()
     * 
     * // Get first 10 ModuleSubscriptions
     * const moduleSubscriptions = await prisma.moduleSubscription.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const moduleSubscriptionWithIdOnly = await prisma.moduleSubscription.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends ModuleSubscriptionFindManyArgs>(args?: SelectSubset<T, ModuleSubscriptionFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a ModuleSubscription.
     * @param {ModuleSubscriptionCreateArgs} args - Arguments to create a ModuleSubscription.
     * @example
     * // Create one ModuleSubscription
     * const ModuleSubscription = await prisma.moduleSubscription.create({
     *   data: {
     *     // ... data to create a ModuleSubscription
     *   }
     * })
     * 
     */
    create<T extends ModuleSubscriptionCreateArgs>(args: SelectSubset<T, ModuleSubscriptionCreateArgs<ExtArgs>>): Prisma__ModuleSubscriptionClient<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many ModuleSubscriptions.
     * @param {ModuleSubscriptionCreateManyArgs} args - Arguments to create many ModuleSubscriptions.
     * @example
     * // Create many ModuleSubscriptions
     * const moduleSubscription = await prisma.moduleSubscription.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends ModuleSubscriptionCreateManyArgs>(args?: SelectSubset<T, ModuleSubscriptionCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many ModuleSubscriptions and returns the data saved in the database.
     * @param {ModuleSubscriptionCreateManyAndReturnArgs} args - Arguments to create many ModuleSubscriptions.
     * @example
     * // Create many ModuleSubscriptions
     * const moduleSubscription = await prisma.moduleSubscription.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many ModuleSubscriptions and only return the `id`
     * const moduleSubscriptionWithIdOnly = await prisma.moduleSubscription.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends ModuleSubscriptionCreateManyAndReturnArgs>(args?: SelectSubset<T, ModuleSubscriptionCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a ModuleSubscription.
     * @param {ModuleSubscriptionDeleteArgs} args - Arguments to delete one ModuleSubscription.
     * @example
     * // Delete one ModuleSubscription
     * const ModuleSubscription = await prisma.moduleSubscription.delete({
     *   where: {
     *     // ... filter to delete one ModuleSubscription
     *   }
     * })
     * 
     */
    delete<T extends ModuleSubscriptionDeleteArgs>(args: SelectSubset<T, ModuleSubscriptionDeleteArgs<ExtArgs>>): Prisma__ModuleSubscriptionClient<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one ModuleSubscription.
     * @param {ModuleSubscriptionUpdateArgs} args - Arguments to update one ModuleSubscription.
     * @example
     * // Update one ModuleSubscription
     * const moduleSubscription = await prisma.moduleSubscription.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends ModuleSubscriptionUpdateArgs>(args: SelectSubset<T, ModuleSubscriptionUpdateArgs<ExtArgs>>): Prisma__ModuleSubscriptionClient<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more ModuleSubscriptions.
     * @param {ModuleSubscriptionDeleteManyArgs} args - Arguments to filter ModuleSubscriptions to delete.
     * @example
     * // Delete a few ModuleSubscriptions
     * const { count } = await prisma.moduleSubscription.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends ModuleSubscriptionDeleteManyArgs>(args?: SelectSubset<T, ModuleSubscriptionDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more ModuleSubscriptions.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ModuleSubscriptionUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many ModuleSubscriptions
     * const moduleSubscription = await prisma.moduleSubscription.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends ModuleSubscriptionUpdateManyArgs>(args: SelectSubset<T, ModuleSubscriptionUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more ModuleSubscriptions and returns the data updated in the database.
     * @param {ModuleSubscriptionUpdateManyAndReturnArgs} args - Arguments to update many ModuleSubscriptions.
     * @example
     * // Update many ModuleSubscriptions
     * const moduleSubscription = await prisma.moduleSubscription.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more ModuleSubscriptions and only return the `id`
     * const moduleSubscriptionWithIdOnly = await prisma.moduleSubscription.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends ModuleSubscriptionUpdateManyAndReturnArgs>(args: SelectSubset<T, ModuleSubscriptionUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one ModuleSubscription.
     * @param {ModuleSubscriptionUpsertArgs} args - Arguments to update or create a ModuleSubscription.
     * @example
     * // Update or create a ModuleSubscription
     * const moduleSubscription = await prisma.moduleSubscription.upsert({
     *   create: {
     *     // ... data to create a ModuleSubscription
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the ModuleSubscription we want to update
     *   }
     * })
     */
    upsert<T extends ModuleSubscriptionUpsertArgs>(args: SelectSubset<T, ModuleSubscriptionUpsertArgs<ExtArgs>>): Prisma__ModuleSubscriptionClient<$Result.GetResult<Prisma.$ModuleSubscriptionPayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of ModuleSubscriptions.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ModuleSubscriptionCountArgs} args - Arguments to filter ModuleSubscriptions to count.
     * @example
     * // Count the number of ModuleSubscriptions
     * const count = await prisma.moduleSubscription.count({
     *   where: {
     *     // ... the filter for the ModuleSubscriptions we want to count
     *   }
     * })
    **/
    count<T extends ModuleSubscriptionCountArgs>(
      args?: Subset<T, ModuleSubscriptionCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], ModuleSubscriptionCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a ModuleSubscription.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ModuleSubscriptionAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends ModuleSubscriptionAggregateArgs>(args: Subset<T, ModuleSubscriptionAggregateArgs>): Prisma.PrismaPromise<GetModuleSubscriptionAggregateType<T>>

    /**
     * Group by ModuleSubscription.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {ModuleSubscriptionGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends ModuleSubscriptionGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: ModuleSubscriptionGroupByArgs['orderBy'] }
        : { orderBy?: ModuleSubscriptionGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, ModuleSubscriptionGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetModuleSubscriptionGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the ModuleSubscription model
   */
  readonly fields: ModuleSubscriptionFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for ModuleSubscription.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__ModuleSubscriptionClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the ModuleSubscription model
   */
  interface ModuleSubscriptionFieldRefs {
    readonly id: FieldRef<"ModuleSubscription", 'String'>
    readonly projectId: FieldRef<"ModuleSubscription", 'String'>
    readonly moduleId: FieldRef<"ModuleSubscription", 'String'>
    readonly priceModel: FieldRef<"ModuleSubscription", 'String'>
    readonly unitPriceMinor: FieldRef<"ModuleSubscription", 'BigInt'>
    readonly currency: FieldRef<"ModuleSubscription", 'String'>
    readonly state: FieldRef<"ModuleSubscription", 'String'>
    readonly revenueShareBps: FieldRef<"ModuleSubscription", 'Int'>
    readonly partnerId: FieldRef<"ModuleSubscription", 'String'>
    readonly trialEndsAt: FieldRef<"ModuleSubscription", 'DateTime'>
    readonly gracePeriodEnd: FieldRef<"ModuleSubscription", 'DateTime'>
    readonly currentPeriodStart: FieldRef<"ModuleSubscription", 'DateTime'>
    readonly currentPeriodEnd: FieldRef<"ModuleSubscription", 'DateTime'>
    readonly createdAt: FieldRef<"ModuleSubscription", 'DateTime'>
    readonly updatedAt: FieldRef<"ModuleSubscription", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * ModuleSubscription findUnique
   */
  export type ModuleSubscriptionFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * Filter, which ModuleSubscription to fetch.
     */
    where: ModuleSubscriptionWhereUniqueInput
  }

  /**
   * ModuleSubscription findUniqueOrThrow
   */
  export type ModuleSubscriptionFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * Filter, which ModuleSubscription to fetch.
     */
    where: ModuleSubscriptionWhereUniqueInput
  }

  /**
   * ModuleSubscription findFirst
   */
  export type ModuleSubscriptionFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * Filter, which ModuleSubscription to fetch.
     */
    where?: ModuleSubscriptionWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of ModuleSubscriptions to fetch.
     */
    orderBy?: ModuleSubscriptionOrderByWithRelationInput | ModuleSubscriptionOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for ModuleSubscriptions.
     */
    cursor?: ModuleSubscriptionWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` ModuleSubscriptions from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` ModuleSubscriptions.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of ModuleSubscriptions.
     */
    distinct?: ModuleSubscriptionScalarFieldEnum | ModuleSubscriptionScalarFieldEnum[]
  }

  /**
   * ModuleSubscription findFirstOrThrow
   */
  export type ModuleSubscriptionFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * Filter, which ModuleSubscription to fetch.
     */
    where?: ModuleSubscriptionWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of ModuleSubscriptions to fetch.
     */
    orderBy?: ModuleSubscriptionOrderByWithRelationInput | ModuleSubscriptionOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for ModuleSubscriptions.
     */
    cursor?: ModuleSubscriptionWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` ModuleSubscriptions from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` ModuleSubscriptions.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of ModuleSubscriptions.
     */
    distinct?: ModuleSubscriptionScalarFieldEnum | ModuleSubscriptionScalarFieldEnum[]
  }

  /**
   * ModuleSubscription findMany
   */
  export type ModuleSubscriptionFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * Filter, which ModuleSubscriptions to fetch.
     */
    where?: ModuleSubscriptionWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of ModuleSubscriptions to fetch.
     */
    orderBy?: ModuleSubscriptionOrderByWithRelationInput | ModuleSubscriptionOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing ModuleSubscriptions.
     */
    cursor?: ModuleSubscriptionWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` ModuleSubscriptions from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` ModuleSubscriptions.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of ModuleSubscriptions.
     */
    distinct?: ModuleSubscriptionScalarFieldEnum | ModuleSubscriptionScalarFieldEnum[]
  }

  /**
   * ModuleSubscription create
   */
  export type ModuleSubscriptionCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * The data needed to create a ModuleSubscription.
     */
    data: XOR<ModuleSubscriptionCreateInput, ModuleSubscriptionUncheckedCreateInput>
  }

  /**
   * ModuleSubscription createMany
   */
  export type ModuleSubscriptionCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many ModuleSubscriptions.
     */
    data: ModuleSubscriptionCreateManyInput | ModuleSubscriptionCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * ModuleSubscription createManyAndReturn
   */
  export type ModuleSubscriptionCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * The data used to create many ModuleSubscriptions.
     */
    data: ModuleSubscriptionCreateManyInput | ModuleSubscriptionCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * ModuleSubscription update
   */
  export type ModuleSubscriptionUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * The data needed to update a ModuleSubscription.
     */
    data: XOR<ModuleSubscriptionUpdateInput, ModuleSubscriptionUncheckedUpdateInput>
    /**
     * Choose, which ModuleSubscription to update.
     */
    where: ModuleSubscriptionWhereUniqueInput
  }

  /**
   * ModuleSubscription updateMany
   */
  export type ModuleSubscriptionUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update ModuleSubscriptions.
     */
    data: XOR<ModuleSubscriptionUpdateManyMutationInput, ModuleSubscriptionUncheckedUpdateManyInput>
    /**
     * Filter which ModuleSubscriptions to update
     */
    where?: ModuleSubscriptionWhereInput
    /**
     * Limit how many ModuleSubscriptions to update.
     */
    limit?: number
  }

  /**
   * ModuleSubscription updateManyAndReturn
   */
  export type ModuleSubscriptionUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * The data used to update ModuleSubscriptions.
     */
    data: XOR<ModuleSubscriptionUpdateManyMutationInput, ModuleSubscriptionUncheckedUpdateManyInput>
    /**
     * Filter which ModuleSubscriptions to update
     */
    where?: ModuleSubscriptionWhereInput
    /**
     * Limit how many ModuleSubscriptions to update.
     */
    limit?: number
  }

  /**
   * ModuleSubscription upsert
   */
  export type ModuleSubscriptionUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * The filter to search for the ModuleSubscription to update in case it exists.
     */
    where: ModuleSubscriptionWhereUniqueInput
    /**
     * In case the ModuleSubscription found by the `where` argument doesn't exist, create a new ModuleSubscription with this data.
     */
    create: XOR<ModuleSubscriptionCreateInput, ModuleSubscriptionUncheckedCreateInput>
    /**
     * In case the ModuleSubscription was found with the provided `where` argument, update it with this data.
     */
    update: XOR<ModuleSubscriptionUpdateInput, ModuleSubscriptionUncheckedUpdateInput>
  }

  /**
   * ModuleSubscription delete
   */
  export type ModuleSubscriptionDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
    /**
     * Filter which ModuleSubscription to delete.
     */
    where: ModuleSubscriptionWhereUniqueInput
  }

  /**
   * ModuleSubscription deleteMany
   */
  export type ModuleSubscriptionDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which ModuleSubscriptions to delete
     */
    where?: ModuleSubscriptionWhereInput
    /**
     * Limit how many ModuleSubscriptions to delete.
     */
    limit?: number
  }

  /**
   * ModuleSubscription without action
   */
  export type ModuleSubscriptionDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the ModuleSubscription
     */
    select?: ModuleSubscriptionSelect<ExtArgs> | null
    /**
     * Omit specific fields from the ModuleSubscription
     */
    omit?: ModuleSubscriptionOmit<ExtArgs> | null
  }


  /**
   * Model AccountStateChange
   */

  export type AggregateAccountStateChange = {
    _count: AccountStateChangeCountAggregateOutputType | null
    _min: AccountStateChangeMinAggregateOutputType | null
    _max: AccountStateChangeMaxAggregateOutputType | null
  }

  export type AccountStateChangeMinAggregateOutputType = {
    id: string | null
    projectId: string | null
    scope: string | null
    moduleId: string | null
    fromState: string | null
    toState: string | null
    reason: string | null
    occurredAt: Date | null
  }

  export type AccountStateChangeMaxAggregateOutputType = {
    id: string | null
    projectId: string | null
    scope: string | null
    moduleId: string | null
    fromState: string | null
    toState: string | null
    reason: string | null
    occurredAt: Date | null
  }

  export type AccountStateChangeCountAggregateOutputType = {
    id: number
    projectId: number
    scope: number
    moduleId: number
    fromState: number
    toState: number
    reason: number
    occurredAt: number
    _all: number
  }


  export type AccountStateChangeMinAggregateInputType = {
    id?: true
    projectId?: true
    scope?: true
    moduleId?: true
    fromState?: true
    toState?: true
    reason?: true
    occurredAt?: true
  }

  export type AccountStateChangeMaxAggregateInputType = {
    id?: true
    projectId?: true
    scope?: true
    moduleId?: true
    fromState?: true
    toState?: true
    reason?: true
    occurredAt?: true
  }

  export type AccountStateChangeCountAggregateInputType = {
    id?: true
    projectId?: true
    scope?: true
    moduleId?: true
    fromState?: true
    toState?: true
    reason?: true
    occurredAt?: true
    _all?: true
  }

  export type AccountStateChangeAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which AccountStateChange to aggregate.
     */
    where?: AccountStateChangeWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of AccountStateChanges to fetch.
     */
    orderBy?: AccountStateChangeOrderByWithRelationInput | AccountStateChangeOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: AccountStateChangeWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` AccountStateChanges from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` AccountStateChanges.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned AccountStateChanges
    **/
    _count?: true | AccountStateChangeCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: AccountStateChangeMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: AccountStateChangeMaxAggregateInputType
  }

  export type GetAccountStateChangeAggregateType<T extends AccountStateChangeAggregateArgs> = {
        [P in keyof T & keyof AggregateAccountStateChange]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateAccountStateChange[P]>
      : GetScalarType<T[P], AggregateAccountStateChange[P]>
  }




  export type AccountStateChangeGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: AccountStateChangeWhereInput
    orderBy?: AccountStateChangeOrderByWithAggregationInput | AccountStateChangeOrderByWithAggregationInput[]
    by: AccountStateChangeScalarFieldEnum[] | AccountStateChangeScalarFieldEnum
    having?: AccountStateChangeScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: AccountStateChangeCountAggregateInputType | true
    _min?: AccountStateChangeMinAggregateInputType
    _max?: AccountStateChangeMaxAggregateInputType
  }

  export type AccountStateChangeGroupByOutputType = {
    id: string
    projectId: string
    scope: string
    moduleId: string | null
    fromState: string
    toState: string
    reason: string
    occurredAt: Date
    _count: AccountStateChangeCountAggregateOutputType | null
    _min: AccountStateChangeMinAggregateOutputType | null
    _max: AccountStateChangeMaxAggregateOutputType | null
  }

  type GetAccountStateChangeGroupByPayload<T extends AccountStateChangeGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<AccountStateChangeGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof AccountStateChangeGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], AccountStateChangeGroupByOutputType[P]>
            : GetScalarType<T[P], AccountStateChangeGroupByOutputType[P]>
        }
      >
    >


  export type AccountStateChangeSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    scope?: boolean
    moduleId?: boolean
    fromState?: boolean
    toState?: boolean
    reason?: boolean
    occurredAt?: boolean
  }, ExtArgs["result"]["accountStateChange"]>

  export type AccountStateChangeSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    scope?: boolean
    moduleId?: boolean
    fromState?: boolean
    toState?: boolean
    reason?: boolean
    occurredAt?: boolean
  }, ExtArgs["result"]["accountStateChange"]>

  export type AccountStateChangeSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    id?: boolean
    projectId?: boolean
    scope?: boolean
    moduleId?: boolean
    fromState?: boolean
    toState?: boolean
    reason?: boolean
    occurredAt?: boolean
  }, ExtArgs["result"]["accountStateChange"]>

  export type AccountStateChangeSelectScalar = {
    id?: boolean
    projectId?: boolean
    scope?: boolean
    moduleId?: boolean
    fromState?: boolean
    toState?: boolean
    reason?: boolean
    occurredAt?: boolean
  }

  export type AccountStateChangeOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"id" | "projectId" | "scope" | "moduleId" | "fromState" | "toState" | "reason" | "occurredAt", ExtArgs["result"]["accountStateChange"]>

  export type $AccountStateChangePayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "AccountStateChange"
    objects: {}
    scalars: $Extensions.GetPayloadResult<{
      id: string
      projectId: string
      scope: string
      moduleId: string | null
      fromState: string
      toState: string
      reason: string
      occurredAt: Date
    }, ExtArgs["result"]["accountStateChange"]>
    composites: {}
  }

  type AccountStateChangeGetPayload<S extends boolean | null | undefined | AccountStateChangeDefaultArgs> = $Result.GetResult<Prisma.$AccountStateChangePayload, S>

  type AccountStateChangeCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<AccountStateChangeFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: AccountStateChangeCountAggregateInputType | true
    }

  export interface AccountStateChangeDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['AccountStateChange'], meta: { name: 'AccountStateChange' } }
    /**
     * Find zero or one AccountStateChange that matches the filter.
     * @param {AccountStateChangeFindUniqueArgs} args - Arguments to find a AccountStateChange
     * @example
     * // Get one AccountStateChange
     * const accountStateChange = await prisma.accountStateChange.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends AccountStateChangeFindUniqueArgs>(args: SelectSubset<T, AccountStateChangeFindUniqueArgs<ExtArgs>>): Prisma__AccountStateChangeClient<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one AccountStateChange that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {AccountStateChangeFindUniqueOrThrowArgs} args - Arguments to find a AccountStateChange
     * @example
     * // Get one AccountStateChange
     * const accountStateChange = await prisma.accountStateChange.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends AccountStateChangeFindUniqueOrThrowArgs>(args: SelectSubset<T, AccountStateChangeFindUniqueOrThrowArgs<ExtArgs>>): Prisma__AccountStateChangeClient<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first AccountStateChange that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {AccountStateChangeFindFirstArgs} args - Arguments to find a AccountStateChange
     * @example
     * // Get one AccountStateChange
     * const accountStateChange = await prisma.accountStateChange.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends AccountStateChangeFindFirstArgs>(args?: SelectSubset<T, AccountStateChangeFindFirstArgs<ExtArgs>>): Prisma__AccountStateChangeClient<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first AccountStateChange that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {AccountStateChangeFindFirstOrThrowArgs} args - Arguments to find a AccountStateChange
     * @example
     * // Get one AccountStateChange
     * const accountStateChange = await prisma.accountStateChange.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends AccountStateChangeFindFirstOrThrowArgs>(args?: SelectSubset<T, AccountStateChangeFindFirstOrThrowArgs<ExtArgs>>): Prisma__AccountStateChangeClient<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more AccountStateChanges that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {AccountStateChangeFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all AccountStateChanges
     * const accountStateChanges = await prisma.accountStateChange.findMany()
     * 
     * // Get first 10 AccountStateChanges
     * const accountStateChanges = await prisma.accountStateChange.findMany({ take: 10 })
     * 
     * // Only select the `id`
     * const accountStateChangeWithIdOnly = await prisma.accountStateChange.findMany({ select: { id: true } })
     * 
     */
    findMany<T extends AccountStateChangeFindManyArgs>(args?: SelectSubset<T, AccountStateChangeFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a AccountStateChange.
     * @param {AccountStateChangeCreateArgs} args - Arguments to create a AccountStateChange.
     * @example
     * // Create one AccountStateChange
     * const AccountStateChange = await prisma.accountStateChange.create({
     *   data: {
     *     // ... data to create a AccountStateChange
     *   }
     * })
     * 
     */
    create<T extends AccountStateChangeCreateArgs>(args: SelectSubset<T, AccountStateChangeCreateArgs<ExtArgs>>): Prisma__AccountStateChangeClient<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many AccountStateChanges.
     * @param {AccountStateChangeCreateManyArgs} args - Arguments to create many AccountStateChanges.
     * @example
     * // Create many AccountStateChanges
     * const accountStateChange = await prisma.accountStateChange.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends AccountStateChangeCreateManyArgs>(args?: SelectSubset<T, AccountStateChangeCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many AccountStateChanges and returns the data saved in the database.
     * @param {AccountStateChangeCreateManyAndReturnArgs} args - Arguments to create many AccountStateChanges.
     * @example
     * // Create many AccountStateChanges
     * const accountStateChange = await prisma.accountStateChange.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many AccountStateChanges and only return the `id`
     * const accountStateChangeWithIdOnly = await prisma.accountStateChange.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends AccountStateChangeCreateManyAndReturnArgs>(args?: SelectSubset<T, AccountStateChangeCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a AccountStateChange.
     * @param {AccountStateChangeDeleteArgs} args - Arguments to delete one AccountStateChange.
     * @example
     * // Delete one AccountStateChange
     * const AccountStateChange = await prisma.accountStateChange.delete({
     *   where: {
     *     // ... filter to delete one AccountStateChange
     *   }
     * })
     * 
     */
    delete<T extends AccountStateChangeDeleteArgs>(args: SelectSubset<T, AccountStateChangeDeleteArgs<ExtArgs>>): Prisma__AccountStateChangeClient<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one AccountStateChange.
     * @param {AccountStateChangeUpdateArgs} args - Arguments to update one AccountStateChange.
     * @example
     * // Update one AccountStateChange
     * const accountStateChange = await prisma.accountStateChange.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends AccountStateChangeUpdateArgs>(args: SelectSubset<T, AccountStateChangeUpdateArgs<ExtArgs>>): Prisma__AccountStateChangeClient<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more AccountStateChanges.
     * @param {AccountStateChangeDeleteManyArgs} args - Arguments to filter AccountStateChanges to delete.
     * @example
     * // Delete a few AccountStateChanges
     * const { count } = await prisma.accountStateChange.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends AccountStateChangeDeleteManyArgs>(args?: SelectSubset<T, AccountStateChangeDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more AccountStateChanges.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {AccountStateChangeUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many AccountStateChanges
     * const accountStateChange = await prisma.accountStateChange.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends AccountStateChangeUpdateManyArgs>(args: SelectSubset<T, AccountStateChangeUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more AccountStateChanges and returns the data updated in the database.
     * @param {AccountStateChangeUpdateManyAndReturnArgs} args - Arguments to update many AccountStateChanges.
     * @example
     * // Update many AccountStateChanges
     * const accountStateChange = await prisma.accountStateChange.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more AccountStateChanges and only return the `id`
     * const accountStateChangeWithIdOnly = await prisma.accountStateChange.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends AccountStateChangeUpdateManyAndReturnArgs>(args: SelectSubset<T, AccountStateChangeUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one AccountStateChange.
     * @param {AccountStateChangeUpsertArgs} args - Arguments to update or create a AccountStateChange.
     * @example
     * // Update or create a AccountStateChange
     * const accountStateChange = await prisma.accountStateChange.upsert({
     *   create: {
     *     // ... data to create a AccountStateChange
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the AccountStateChange we want to update
     *   }
     * })
     */
    upsert<T extends AccountStateChangeUpsertArgs>(args: SelectSubset<T, AccountStateChangeUpsertArgs<ExtArgs>>): Prisma__AccountStateChangeClient<$Result.GetResult<Prisma.$AccountStateChangePayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of AccountStateChanges.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {AccountStateChangeCountArgs} args - Arguments to filter AccountStateChanges to count.
     * @example
     * // Count the number of AccountStateChanges
     * const count = await prisma.accountStateChange.count({
     *   where: {
     *     // ... the filter for the AccountStateChanges we want to count
     *   }
     * })
    **/
    count<T extends AccountStateChangeCountArgs>(
      args?: Subset<T, AccountStateChangeCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], AccountStateChangeCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a AccountStateChange.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {AccountStateChangeAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends AccountStateChangeAggregateArgs>(args: Subset<T, AccountStateChangeAggregateArgs>): Prisma.PrismaPromise<GetAccountStateChangeAggregateType<T>>

    /**
     * Group by AccountStateChange.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {AccountStateChangeGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends AccountStateChangeGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: AccountStateChangeGroupByArgs['orderBy'] }
        : { orderBy?: AccountStateChangeGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, AccountStateChangeGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetAccountStateChangeGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the AccountStateChange model
   */
  readonly fields: AccountStateChangeFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for AccountStateChange.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__AccountStateChangeClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the AccountStateChange model
   */
  interface AccountStateChangeFieldRefs {
    readonly id: FieldRef<"AccountStateChange", 'String'>
    readonly projectId: FieldRef<"AccountStateChange", 'String'>
    readonly scope: FieldRef<"AccountStateChange", 'String'>
    readonly moduleId: FieldRef<"AccountStateChange", 'String'>
    readonly fromState: FieldRef<"AccountStateChange", 'String'>
    readonly toState: FieldRef<"AccountStateChange", 'String'>
    readonly reason: FieldRef<"AccountStateChange", 'String'>
    readonly occurredAt: FieldRef<"AccountStateChange", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * AccountStateChange findUnique
   */
  export type AccountStateChangeFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * Filter, which AccountStateChange to fetch.
     */
    where: AccountStateChangeWhereUniqueInput
  }

  /**
   * AccountStateChange findUniqueOrThrow
   */
  export type AccountStateChangeFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * Filter, which AccountStateChange to fetch.
     */
    where: AccountStateChangeWhereUniqueInput
  }

  /**
   * AccountStateChange findFirst
   */
  export type AccountStateChangeFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * Filter, which AccountStateChange to fetch.
     */
    where?: AccountStateChangeWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of AccountStateChanges to fetch.
     */
    orderBy?: AccountStateChangeOrderByWithRelationInput | AccountStateChangeOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for AccountStateChanges.
     */
    cursor?: AccountStateChangeWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` AccountStateChanges from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` AccountStateChanges.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of AccountStateChanges.
     */
    distinct?: AccountStateChangeScalarFieldEnum | AccountStateChangeScalarFieldEnum[]
  }

  /**
   * AccountStateChange findFirstOrThrow
   */
  export type AccountStateChangeFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * Filter, which AccountStateChange to fetch.
     */
    where?: AccountStateChangeWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of AccountStateChanges to fetch.
     */
    orderBy?: AccountStateChangeOrderByWithRelationInput | AccountStateChangeOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for AccountStateChanges.
     */
    cursor?: AccountStateChangeWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` AccountStateChanges from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` AccountStateChanges.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of AccountStateChanges.
     */
    distinct?: AccountStateChangeScalarFieldEnum | AccountStateChangeScalarFieldEnum[]
  }

  /**
   * AccountStateChange findMany
   */
  export type AccountStateChangeFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * Filter, which AccountStateChanges to fetch.
     */
    where?: AccountStateChangeWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of AccountStateChanges to fetch.
     */
    orderBy?: AccountStateChangeOrderByWithRelationInput | AccountStateChangeOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing AccountStateChanges.
     */
    cursor?: AccountStateChangeWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` AccountStateChanges from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` AccountStateChanges.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of AccountStateChanges.
     */
    distinct?: AccountStateChangeScalarFieldEnum | AccountStateChangeScalarFieldEnum[]
  }

  /**
   * AccountStateChange create
   */
  export type AccountStateChangeCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * The data needed to create a AccountStateChange.
     */
    data: XOR<AccountStateChangeCreateInput, AccountStateChangeUncheckedCreateInput>
  }

  /**
   * AccountStateChange createMany
   */
  export type AccountStateChangeCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many AccountStateChanges.
     */
    data: AccountStateChangeCreateManyInput | AccountStateChangeCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * AccountStateChange createManyAndReturn
   */
  export type AccountStateChangeCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * The data used to create many AccountStateChanges.
     */
    data: AccountStateChangeCreateManyInput | AccountStateChangeCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * AccountStateChange update
   */
  export type AccountStateChangeUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * The data needed to update a AccountStateChange.
     */
    data: XOR<AccountStateChangeUpdateInput, AccountStateChangeUncheckedUpdateInput>
    /**
     * Choose, which AccountStateChange to update.
     */
    where: AccountStateChangeWhereUniqueInput
  }

  /**
   * AccountStateChange updateMany
   */
  export type AccountStateChangeUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update AccountStateChanges.
     */
    data: XOR<AccountStateChangeUpdateManyMutationInput, AccountStateChangeUncheckedUpdateManyInput>
    /**
     * Filter which AccountStateChanges to update
     */
    where?: AccountStateChangeWhereInput
    /**
     * Limit how many AccountStateChanges to update.
     */
    limit?: number
  }

  /**
   * AccountStateChange updateManyAndReturn
   */
  export type AccountStateChangeUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * The data used to update AccountStateChanges.
     */
    data: XOR<AccountStateChangeUpdateManyMutationInput, AccountStateChangeUncheckedUpdateManyInput>
    /**
     * Filter which AccountStateChanges to update
     */
    where?: AccountStateChangeWhereInput
    /**
     * Limit how many AccountStateChanges to update.
     */
    limit?: number
  }

  /**
   * AccountStateChange upsert
   */
  export type AccountStateChangeUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * The filter to search for the AccountStateChange to update in case it exists.
     */
    where: AccountStateChangeWhereUniqueInput
    /**
     * In case the AccountStateChange found by the `where` argument doesn't exist, create a new AccountStateChange with this data.
     */
    create: XOR<AccountStateChangeCreateInput, AccountStateChangeUncheckedCreateInput>
    /**
     * In case the AccountStateChange was found with the provided `where` argument, update it with this data.
     */
    update: XOR<AccountStateChangeUpdateInput, AccountStateChangeUncheckedUpdateInput>
  }

  /**
   * AccountStateChange delete
   */
  export type AccountStateChangeDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
    /**
     * Filter which AccountStateChange to delete.
     */
    where: AccountStateChangeWhereUniqueInput
  }

  /**
   * AccountStateChange deleteMany
   */
  export type AccountStateChangeDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which AccountStateChanges to delete
     */
    where?: AccountStateChangeWhereInput
    /**
     * Limit how many AccountStateChanges to delete.
     */
    limit?: number
  }

  /**
   * AccountStateChange without action
   */
  export type AccountStateChangeDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the AccountStateChange
     */
    select?: AccountStateChangeSelect<ExtArgs> | null
    /**
     * Omit specific fields from the AccountStateChange
     */
    omit?: AccountStateChangeOmit<ExtArgs> | null
  }


  /**
   * Model BillingProcessedMessage
   */

  export type AggregateBillingProcessedMessage = {
    _count: BillingProcessedMessageCountAggregateOutputType | null
    _min: BillingProcessedMessageMinAggregateOutputType | null
    _max: BillingProcessedMessageMaxAggregateOutputType | null
  }

  export type BillingProcessedMessageMinAggregateOutputType = {
    dedupKey: string | null
    routingKey: string | null
    processedAt: Date | null
  }

  export type BillingProcessedMessageMaxAggregateOutputType = {
    dedupKey: string | null
    routingKey: string | null
    processedAt: Date | null
  }

  export type BillingProcessedMessageCountAggregateOutputType = {
    dedupKey: number
    routingKey: number
    processedAt: number
    _all: number
  }


  export type BillingProcessedMessageMinAggregateInputType = {
    dedupKey?: true
    routingKey?: true
    processedAt?: true
  }

  export type BillingProcessedMessageMaxAggregateInputType = {
    dedupKey?: true
    routingKey?: true
    processedAt?: true
  }

  export type BillingProcessedMessageCountAggregateInputType = {
    dedupKey?: true
    routingKey?: true
    processedAt?: true
    _all?: true
  }

  export type BillingProcessedMessageAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingProcessedMessage to aggregate.
     */
    where?: BillingProcessedMessageWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingProcessedMessages to fetch.
     */
    orderBy?: BillingProcessedMessageOrderByWithRelationInput | BillingProcessedMessageOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: BillingProcessedMessageWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingProcessedMessages from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingProcessedMessages.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned BillingProcessedMessages
    **/
    _count?: true | BillingProcessedMessageCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: BillingProcessedMessageMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: BillingProcessedMessageMaxAggregateInputType
  }

  export type GetBillingProcessedMessageAggregateType<T extends BillingProcessedMessageAggregateArgs> = {
        [P in keyof T & keyof AggregateBillingProcessedMessage]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateBillingProcessedMessage[P]>
      : GetScalarType<T[P], AggregateBillingProcessedMessage[P]>
  }




  export type BillingProcessedMessageGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingProcessedMessageWhereInput
    orderBy?: BillingProcessedMessageOrderByWithAggregationInput | BillingProcessedMessageOrderByWithAggregationInput[]
    by: BillingProcessedMessageScalarFieldEnum[] | BillingProcessedMessageScalarFieldEnum
    having?: BillingProcessedMessageScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: BillingProcessedMessageCountAggregateInputType | true
    _min?: BillingProcessedMessageMinAggregateInputType
    _max?: BillingProcessedMessageMaxAggregateInputType
  }

  export type BillingProcessedMessageGroupByOutputType = {
    dedupKey: string
    routingKey: string
    processedAt: Date
    _count: BillingProcessedMessageCountAggregateOutputType | null
    _min: BillingProcessedMessageMinAggregateOutputType | null
    _max: BillingProcessedMessageMaxAggregateOutputType | null
  }

  type GetBillingProcessedMessageGroupByPayload<T extends BillingProcessedMessageGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<BillingProcessedMessageGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof BillingProcessedMessageGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], BillingProcessedMessageGroupByOutputType[P]>
            : GetScalarType<T[P], BillingProcessedMessageGroupByOutputType[P]>
        }
      >
    >


  export type BillingProcessedMessageSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    dedupKey?: boolean
    routingKey?: boolean
    processedAt?: boolean
  }, ExtArgs["result"]["billingProcessedMessage"]>

  export type BillingProcessedMessageSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    dedupKey?: boolean
    routingKey?: boolean
    processedAt?: boolean
  }, ExtArgs["result"]["billingProcessedMessage"]>

  export type BillingProcessedMessageSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    dedupKey?: boolean
    routingKey?: boolean
    processedAt?: boolean
  }, ExtArgs["result"]["billingProcessedMessage"]>

  export type BillingProcessedMessageSelectScalar = {
    dedupKey?: boolean
    routingKey?: boolean
    processedAt?: boolean
  }

  export type BillingProcessedMessageOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"dedupKey" | "routingKey" | "processedAt", ExtArgs["result"]["billingProcessedMessage"]>

  export type $BillingProcessedMessagePayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "BillingProcessedMessage"
    objects: {}
    scalars: $Extensions.GetPayloadResult<{
      dedupKey: string
      routingKey: string
      processedAt: Date
    }, ExtArgs["result"]["billingProcessedMessage"]>
    composites: {}
  }

  type BillingProcessedMessageGetPayload<S extends boolean | null | undefined | BillingProcessedMessageDefaultArgs> = $Result.GetResult<Prisma.$BillingProcessedMessagePayload, S>

  type BillingProcessedMessageCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<BillingProcessedMessageFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: BillingProcessedMessageCountAggregateInputType | true
    }

  export interface BillingProcessedMessageDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['BillingProcessedMessage'], meta: { name: 'BillingProcessedMessage' } }
    /**
     * Find zero or one BillingProcessedMessage that matches the filter.
     * @param {BillingProcessedMessageFindUniqueArgs} args - Arguments to find a BillingProcessedMessage
     * @example
     * // Get one BillingProcessedMessage
     * const billingProcessedMessage = await prisma.billingProcessedMessage.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends BillingProcessedMessageFindUniqueArgs>(args: SelectSubset<T, BillingProcessedMessageFindUniqueArgs<ExtArgs>>): Prisma__BillingProcessedMessageClient<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one BillingProcessedMessage that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {BillingProcessedMessageFindUniqueOrThrowArgs} args - Arguments to find a BillingProcessedMessage
     * @example
     * // Get one BillingProcessedMessage
     * const billingProcessedMessage = await prisma.billingProcessedMessage.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends BillingProcessedMessageFindUniqueOrThrowArgs>(args: SelectSubset<T, BillingProcessedMessageFindUniqueOrThrowArgs<ExtArgs>>): Prisma__BillingProcessedMessageClient<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingProcessedMessage that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingProcessedMessageFindFirstArgs} args - Arguments to find a BillingProcessedMessage
     * @example
     * // Get one BillingProcessedMessage
     * const billingProcessedMessage = await prisma.billingProcessedMessage.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends BillingProcessedMessageFindFirstArgs>(args?: SelectSubset<T, BillingProcessedMessageFindFirstArgs<ExtArgs>>): Prisma__BillingProcessedMessageClient<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingProcessedMessage that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingProcessedMessageFindFirstOrThrowArgs} args - Arguments to find a BillingProcessedMessage
     * @example
     * // Get one BillingProcessedMessage
     * const billingProcessedMessage = await prisma.billingProcessedMessage.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends BillingProcessedMessageFindFirstOrThrowArgs>(args?: SelectSubset<T, BillingProcessedMessageFindFirstOrThrowArgs<ExtArgs>>): Prisma__BillingProcessedMessageClient<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more BillingProcessedMessages that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingProcessedMessageFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all BillingProcessedMessages
     * const billingProcessedMessages = await prisma.billingProcessedMessage.findMany()
     * 
     * // Get first 10 BillingProcessedMessages
     * const billingProcessedMessages = await prisma.billingProcessedMessage.findMany({ take: 10 })
     * 
     * // Only select the `dedupKey`
     * const billingProcessedMessageWithDedupKeyOnly = await prisma.billingProcessedMessage.findMany({ select: { dedupKey: true } })
     * 
     */
    findMany<T extends BillingProcessedMessageFindManyArgs>(args?: SelectSubset<T, BillingProcessedMessageFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a BillingProcessedMessage.
     * @param {BillingProcessedMessageCreateArgs} args - Arguments to create a BillingProcessedMessage.
     * @example
     * // Create one BillingProcessedMessage
     * const BillingProcessedMessage = await prisma.billingProcessedMessage.create({
     *   data: {
     *     // ... data to create a BillingProcessedMessage
     *   }
     * })
     * 
     */
    create<T extends BillingProcessedMessageCreateArgs>(args: SelectSubset<T, BillingProcessedMessageCreateArgs<ExtArgs>>): Prisma__BillingProcessedMessageClient<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many BillingProcessedMessages.
     * @param {BillingProcessedMessageCreateManyArgs} args - Arguments to create many BillingProcessedMessages.
     * @example
     * // Create many BillingProcessedMessages
     * const billingProcessedMessage = await prisma.billingProcessedMessage.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends BillingProcessedMessageCreateManyArgs>(args?: SelectSubset<T, BillingProcessedMessageCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many BillingProcessedMessages and returns the data saved in the database.
     * @param {BillingProcessedMessageCreateManyAndReturnArgs} args - Arguments to create many BillingProcessedMessages.
     * @example
     * // Create many BillingProcessedMessages
     * const billingProcessedMessage = await prisma.billingProcessedMessage.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many BillingProcessedMessages and only return the `dedupKey`
     * const billingProcessedMessageWithDedupKeyOnly = await prisma.billingProcessedMessage.createManyAndReturn({
     *   select: { dedupKey: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends BillingProcessedMessageCreateManyAndReturnArgs>(args?: SelectSubset<T, BillingProcessedMessageCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a BillingProcessedMessage.
     * @param {BillingProcessedMessageDeleteArgs} args - Arguments to delete one BillingProcessedMessage.
     * @example
     * // Delete one BillingProcessedMessage
     * const BillingProcessedMessage = await prisma.billingProcessedMessage.delete({
     *   where: {
     *     // ... filter to delete one BillingProcessedMessage
     *   }
     * })
     * 
     */
    delete<T extends BillingProcessedMessageDeleteArgs>(args: SelectSubset<T, BillingProcessedMessageDeleteArgs<ExtArgs>>): Prisma__BillingProcessedMessageClient<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one BillingProcessedMessage.
     * @param {BillingProcessedMessageUpdateArgs} args - Arguments to update one BillingProcessedMessage.
     * @example
     * // Update one BillingProcessedMessage
     * const billingProcessedMessage = await prisma.billingProcessedMessage.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends BillingProcessedMessageUpdateArgs>(args: SelectSubset<T, BillingProcessedMessageUpdateArgs<ExtArgs>>): Prisma__BillingProcessedMessageClient<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more BillingProcessedMessages.
     * @param {BillingProcessedMessageDeleteManyArgs} args - Arguments to filter BillingProcessedMessages to delete.
     * @example
     * // Delete a few BillingProcessedMessages
     * const { count } = await prisma.billingProcessedMessage.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends BillingProcessedMessageDeleteManyArgs>(args?: SelectSubset<T, BillingProcessedMessageDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingProcessedMessages.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingProcessedMessageUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many BillingProcessedMessages
     * const billingProcessedMessage = await prisma.billingProcessedMessage.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends BillingProcessedMessageUpdateManyArgs>(args: SelectSubset<T, BillingProcessedMessageUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingProcessedMessages and returns the data updated in the database.
     * @param {BillingProcessedMessageUpdateManyAndReturnArgs} args - Arguments to update many BillingProcessedMessages.
     * @example
     * // Update many BillingProcessedMessages
     * const billingProcessedMessage = await prisma.billingProcessedMessage.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more BillingProcessedMessages and only return the `dedupKey`
     * const billingProcessedMessageWithDedupKeyOnly = await prisma.billingProcessedMessage.updateManyAndReturn({
     *   select: { dedupKey: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends BillingProcessedMessageUpdateManyAndReturnArgs>(args: SelectSubset<T, BillingProcessedMessageUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one BillingProcessedMessage.
     * @param {BillingProcessedMessageUpsertArgs} args - Arguments to update or create a BillingProcessedMessage.
     * @example
     * // Update or create a BillingProcessedMessage
     * const billingProcessedMessage = await prisma.billingProcessedMessage.upsert({
     *   create: {
     *     // ... data to create a BillingProcessedMessage
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the BillingProcessedMessage we want to update
     *   }
     * })
     */
    upsert<T extends BillingProcessedMessageUpsertArgs>(args: SelectSubset<T, BillingProcessedMessageUpsertArgs<ExtArgs>>): Prisma__BillingProcessedMessageClient<$Result.GetResult<Prisma.$BillingProcessedMessagePayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of BillingProcessedMessages.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingProcessedMessageCountArgs} args - Arguments to filter BillingProcessedMessages to count.
     * @example
     * // Count the number of BillingProcessedMessages
     * const count = await prisma.billingProcessedMessage.count({
     *   where: {
     *     // ... the filter for the BillingProcessedMessages we want to count
     *   }
     * })
    **/
    count<T extends BillingProcessedMessageCountArgs>(
      args?: Subset<T, BillingProcessedMessageCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], BillingProcessedMessageCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a BillingProcessedMessage.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingProcessedMessageAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends BillingProcessedMessageAggregateArgs>(args: Subset<T, BillingProcessedMessageAggregateArgs>): Prisma.PrismaPromise<GetBillingProcessedMessageAggregateType<T>>

    /**
     * Group by BillingProcessedMessage.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingProcessedMessageGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends BillingProcessedMessageGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: BillingProcessedMessageGroupByArgs['orderBy'] }
        : { orderBy?: BillingProcessedMessageGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, BillingProcessedMessageGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetBillingProcessedMessageGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the BillingProcessedMessage model
   */
  readonly fields: BillingProcessedMessageFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for BillingProcessedMessage.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__BillingProcessedMessageClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the BillingProcessedMessage model
   */
  interface BillingProcessedMessageFieldRefs {
    readonly dedupKey: FieldRef<"BillingProcessedMessage", 'String'>
    readonly routingKey: FieldRef<"BillingProcessedMessage", 'String'>
    readonly processedAt: FieldRef<"BillingProcessedMessage", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * BillingProcessedMessage findUnique
   */
  export type BillingProcessedMessageFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * Filter, which BillingProcessedMessage to fetch.
     */
    where: BillingProcessedMessageWhereUniqueInput
  }

  /**
   * BillingProcessedMessage findUniqueOrThrow
   */
  export type BillingProcessedMessageFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * Filter, which BillingProcessedMessage to fetch.
     */
    where: BillingProcessedMessageWhereUniqueInput
  }

  /**
   * BillingProcessedMessage findFirst
   */
  export type BillingProcessedMessageFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * Filter, which BillingProcessedMessage to fetch.
     */
    where?: BillingProcessedMessageWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingProcessedMessages to fetch.
     */
    orderBy?: BillingProcessedMessageOrderByWithRelationInput | BillingProcessedMessageOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingProcessedMessages.
     */
    cursor?: BillingProcessedMessageWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingProcessedMessages from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingProcessedMessages.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingProcessedMessages.
     */
    distinct?: BillingProcessedMessageScalarFieldEnum | BillingProcessedMessageScalarFieldEnum[]
  }

  /**
   * BillingProcessedMessage findFirstOrThrow
   */
  export type BillingProcessedMessageFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * Filter, which BillingProcessedMessage to fetch.
     */
    where?: BillingProcessedMessageWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingProcessedMessages to fetch.
     */
    orderBy?: BillingProcessedMessageOrderByWithRelationInput | BillingProcessedMessageOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingProcessedMessages.
     */
    cursor?: BillingProcessedMessageWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingProcessedMessages from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingProcessedMessages.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingProcessedMessages.
     */
    distinct?: BillingProcessedMessageScalarFieldEnum | BillingProcessedMessageScalarFieldEnum[]
  }

  /**
   * BillingProcessedMessage findMany
   */
  export type BillingProcessedMessageFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * Filter, which BillingProcessedMessages to fetch.
     */
    where?: BillingProcessedMessageWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingProcessedMessages to fetch.
     */
    orderBy?: BillingProcessedMessageOrderByWithRelationInput | BillingProcessedMessageOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing BillingProcessedMessages.
     */
    cursor?: BillingProcessedMessageWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingProcessedMessages from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingProcessedMessages.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingProcessedMessages.
     */
    distinct?: BillingProcessedMessageScalarFieldEnum | BillingProcessedMessageScalarFieldEnum[]
  }

  /**
   * BillingProcessedMessage create
   */
  export type BillingProcessedMessageCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * The data needed to create a BillingProcessedMessage.
     */
    data: XOR<BillingProcessedMessageCreateInput, BillingProcessedMessageUncheckedCreateInput>
  }

  /**
   * BillingProcessedMessage createMany
   */
  export type BillingProcessedMessageCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many BillingProcessedMessages.
     */
    data: BillingProcessedMessageCreateManyInput | BillingProcessedMessageCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingProcessedMessage createManyAndReturn
   */
  export type BillingProcessedMessageCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * The data used to create many BillingProcessedMessages.
     */
    data: BillingProcessedMessageCreateManyInput | BillingProcessedMessageCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingProcessedMessage update
   */
  export type BillingProcessedMessageUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * The data needed to update a BillingProcessedMessage.
     */
    data: XOR<BillingProcessedMessageUpdateInput, BillingProcessedMessageUncheckedUpdateInput>
    /**
     * Choose, which BillingProcessedMessage to update.
     */
    where: BillingProcessedMessageWhereUniqueInput
  }

  /**
   * BillingProcessedMessage updateMany
   */
  export type BillingProcessedMessageUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update BillingProcessedMessages.
     */
    data: XOR<BillingProcessedMessageUpdateManyMutationInput, BillingProcessedMessageUncheckedUpdateManyInput>
    /**
     * Filter which BillingProcessedMessages to update
     */
    where?: BillingProcessedMessageWhereInput
    /**
     * Limit how many BillingProcessedMessages to update.
     */
    limit?: number
  }

  /**
   * BillingProcessedMessage updateManyAndReturn
   */
  export type BillingProcessedMessageUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * The data used to update BillingProcessedMessages.
     */
    data: XOR<BillingProcessedMessageUpdateManyMutationInput, BillingProcessedMessageUncheckedUpdateManyInput>
    /**
     * Filter which BillingProcessedMessages to update
     */
    where?: BillingProcessedMessageWhereInput
    /**
     * Limit how many BillingProcessedMessages to update.
     */
    limit?: number
  }

  /**
   * BillingProcessedMessage upsert
   */
  export type BillingProcessedMessageUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * The filter to search for the BillingProcessedMessage to update in case it exists.
     */
    where: BillingProcessedMessageWhereUniqueInput
    /**
     * In case the BillingProcessedMessage found by the `where` argument doesn't exist, create a new BillingProcessedMessage with this data.
     */
    create: XOR<BillingProcessedMessageCreateInput, BillingProcessedMessageUncheckedCreateInput>
    /**
     * In case the BillingProcessedMessage was found with the provided `where` argument, update it with this data.
     */
    update: XOR<BillingProcessedMessageUpdateInput, BillingProcessedMessageUncheckedUpdateInput>
  }

  /**
   * BillingProcessedMessage delete
   */
  export type BillingProcessedMessageDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
    /**
     * Filter which BillingProcessedMessage to delete.
     */
    where: BillingProcessedMessageWhereUniqueInput
  }

  /**
   * BillingProcessedMessage deleteMany
   */
  export type BillingProcessedMessageDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingProcessedMessages to delete
     */
    where?: BillingProcessedMessageWhereInput
    /**
     * Limit how many BillingProcessedMessages to delete.
     */
    limit?: number
  }

  /**
   * BillingProcessedMessage without action
   */
  export type BillingProcessedMessageDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingProcessedMessage
     */
    select?: BillingProcessedMessageSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingProcessedMessage
     */
    omit?: BillingProcessedMessageOmit<ExtArgs> | null
  }


  /**
   * Model BillingEventOutbox
   */

  export type AggregateBillingEventOutbox = {
    _count: BillingEventOutboxCountAggregateOutputType | null
    _avg: BillingEventOutboxAvgAggregateOutputType | null
    _sum: BillingEventOutboxSumAggregateOutputType | null
    _min: BillingEventOutboxMinAggregateOutputType | null
    _max: BillingEventOutboxMaxAggregateOutputType | null
  }

  export type BillingEventOutboxAvgAggregateOutputType = {
    attempts: number | null
  }

  export type BillingEventOutboxSumAggregateOutputType = {
    attempts: number | null
  }

  export type BillingEventOutboxMinAggregateOutputType = {
    messageId: string | null
    routingKey: string | null
    projectId: string | null
    status: string | null
    attempts: number | null
    lastError: string | null
    createdAt: Date | null
    updatedAt: Date | null
    publishedAt: Date | null
  }

  export type BillingEventOutboxMaxAggregateOutputType = {
    messageId: string | null
    routingKey: string | null
    projectId: string | null
    status: string | null
    attempts: number | null
    lastError: string | null
    createdAt: Date | null
    updatedAt: Date | null
    publishedAt: Date | null
  }

  export type BillingEventOutboxCountAggregateOutputType = {
    messageId: number
    routingKey: number
    projectId: number
    status: number
    attempts: number
    envelope: number
    lastError: number
    createdAt: number
    updatedAt: number
    publishedAt: number
    _all: number
  }


  export type BillingEventOutboxAvgAggregateInputType = {
    attempts?: true
  }

  export type BillingEventOutboxSumAggregateInputType = {
    attempts?: true
  }

  export type BillingEventOutboxMinAggregateInputType = {
    messageId?: true
    routingKey?: true
    projectId?: true
    status?: true
    attempts?: true
    lastError?: true
    createdAt?: true
    updatedAt?: true
    publishedAt?: true
  }

  export type BillingEventOutboxMaxAggregateInputType = {
    messageId?: true
    routingKey?: true
    projectId?: true
    status?: true
    attempts?: true
    lastError?: true
    createdAt?: true
    updatedAt?: true
    publishedAt?: true
  }

  export type BillingEventOutboxCountAggregateInputType = {
    messageId?: true
    routingKey?: true
    projectId?: true
    status?: true
    attempts?: true
    envelope?: true
    lastError?: true
    createdAt?: true
    updatedAt?: true
    publishedAt?: true
    _all?: true
  }

  export type BillingEventOutboxAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingEventOutbox to aggregate.
     */
    where?: BillingEventOutboxWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingEventOutboxes to fetch.
     */
    orderBy?: BillingEventOutboxOrderByWithRelationInput | BillingEventOutboxOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: BillingEventOutboxWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingEventOutboxes from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingEventOutboxes.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned BillingEventOutboxes
    **/
    _count?: true | BillingEventOutboxCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: BillingEventOutboxAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: BillingEventOutboxSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: BillingEventOutboxMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: BillingEventOutboxMaxAggregateInputType
  }

  export type GetBillingEventOutboxAggregateType<T extends BillingEventOutboxAggregateArgs> = {
        [P in keyof T & keyof AggregateBillingEventOutbox]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateBillingEventOutbox[P]>
      : GetScalarType<T[P], AggregateBillingEventOutbox[P]>
  }




  export type BillingEventOutboxGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: BillingEventOutboxWhereInput
    orderBy?: BillingEventOutboxOrderByWithAggregationInput | BillingEventOutboxOrderByWithAggregationInput[]
    by: BillingEventOutboxScalarFieldEnum[] | BillingEventOutboxScalarFieldEnum
    having?: BillingEventOutboxScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: BillingEventOutboxCountAggregateInputType | true
    _avg?: BillingEventOutboxAvgAggregateInputType
    _sum?: BillingEventOutboxSumAggregateInputType
    _min?: BillingEventOutboxMinAggregateInputType
    _max?: BillingEventOutboxMaxAggregateInputType
  }

  export type BillingEventOutboxGroupByOutputType = {
    messageId: string
    routingKey: string
    projectId: string | null
    status: string
    attempts: number
    envelope: JsonValue
    lastError: string | null
    createdAt: Date
    updatedAt: Date
    publishedAt: Date | null
    _count: BillingEventOutboxCountAggregateOutputType | null
    _avg: BillingEventOutboxAvgAggregateOutputType | null
    _sum: BillingEventOutboxSumAggregateOutputType | null
    _min: BillingEventOutboxMinAggregateOutputType | null
    _max: BillingEventOutboxMaxAggregateOutputType | null
  }

  type GetBillingEventOutboxGroupByPayload<T extends BillingEventOutboxGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<BillingEventOutboxGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof BillingEventOutboxGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], BillingEventOutboxGroupByOutputType[P]>
            : GetScalarType<T[P], BillingEventOutboxGroupByOutputType[P]>
        }
      >
    >


  export type BillingEventOutboxSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    messageId?: boolean
    routingKey?: boolean
    projectId?: boolean
    status?: boolean
    attempts?: boolean
    envelope?: boolean
    lastError?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    publishedAt?: boolean
  }, ExtArgs["result"]["billingEventOutbox"]>

  export type BillingEventOutboxSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    messageId?: boolean
    routingKey?: boolean
    projectId?: boolean
    status?: boolean
    attempts?: boolean
    envelope?: boolean
    lastError?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    publishedAt?: boolean
  }, ExtArgs["result"]["billingEventOutbox"]>

  export type BillingEventOutboxSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    messageId?: boolean
    routingKey?: boolean
    projectId?: boolean
    status?: boolean
    attempts?: boolean
    envelope?: boolean
    lastError?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    publishedAt?: boolean
  }, ExtArgs["result"]["billingEventOutbox"]>

  export type BillingEventOutboxSelectScalar = {
    messageId?: boolean
    routingKey?: boolean
    projectId?: boolean
    status?: boolean
    attempts?: boolean
    envelope?: boolean
    lastError?: boolean
    createdAt?: boolean
    updatedAt?: boolean
    publishedAt?: boolean
  }

  export type BillingEventOutboxOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"messageId" | "routingKey" | "projectId" | "status" | "attempts" | "envelope" | "lastError" | "createdAt" | "updatedAt" | "publishedAt", ExtArgs["result"]["billingEventOutbox"]>

  export type $BillingEventOutboxPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "BillingEventOutbox"
    objects: {}
    scalars: $Extensions.GetPayloadResult<{
      messageId: string
      routingKey: string
      projectId: string | null
      status: string
      attempts: number
      envelope: Prisma.JsonValue
      lastError: string | null
      createdAt: Date
      updatedAt: Date
      publishedAt: Date | null
    }, ExtArgs["result"]["billingEventOutbox"]>
    composites: {}
  }

  type BillingEventOutboxGetPayload<S extends boolean | null | undefined | BillingEventOutboxDefaultArgs> = $Result.GetResult<Prisma.$BillingEventOutboxPayload, S>

  type BillingEventOutboxCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<BillingEventOutboxFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: BillingEventOutboxCountAggregateInputType | true
    }

  export interface BillingEventOutboxDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['BillingEventOutbox'], meta: { name: 'BillingEventOutbox' } }
    /**
     * Find zero or one BillingEventOutbox that matches the filter.
     * @param {BillingEventOutboxFindUniqueArgs} args - Arguments to find a BillingEventOutbox
     * @example
     * // Get one BillingEventOutbox
     * const billingEventOutbox = await prisma.billingEventOutbox.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends BillingEventOutboxFindUniqueArgs>(args: SelectSubset<T, BillingEventOutboxFindUniqueArgs<ExtArgs>>): Prisma__BillingEventOutboxClient<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one BillingEventOutbox that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {BillingEventOutboxFindUniqueOrThrowArgs} args - Arguments to find a BillingEventOutbox
     * @example
     * // Get one BillingEventOutbox
     * const billingEventOutbox = await prisma.billingEventOutbox.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends BillingEventOutboxFindUniqueOrThrowArgs>(args: SelectSubset<T, BillingEventOutboxFindUniqueOrThrowArgs<ExtArgs>>): Prisma__BillingEventOutboxClient<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingEventOutbox that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingEventOutboxFindFirstArgs} args - Arguments to find a BillingEventOutbox
     * @example
     * // Get one BillingEventOutbox
     * const billingEventOutbox = await prisma.billingEventOutbox.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends BillingEventOutboxFindFirstArgs>(args?: SelectSubset<T, BillingEventOutboxFindFirstArgs<ExtArgs>>): Prisma__BillingEventOutboxClient<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first BillingEventOutbox that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingEventOutboxFindFirstOrThrowArgs} args - Arguments to find a BillingEventOutbox
     * @example
     * // Get one BillingEventOutbox
     * const billingEventOutbox = await prisma.billingEventOutbox.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends BillingEventOutboxFindFirstOrThrowArgs>(args?: SelectSubset<T, BillingEventOutboxFindFirstOrThrowArgs<ExtArgs>>): Prisma__BillingEventOutboxClient<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more BillingEventOutboxes that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingEventOutboxFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all BillingEventOutboxes
     * const billingEventOutboxes = await prisma.billingEventOutbox.findMany()
     * 
     * // Get first 10 BillingEventOutboxes
     * const billingEventOutboxes = await prisma.billingEventOutbox.findMany({ take: 10 })
     * 
     * // Only select the `messageId`
     * const billingEventOutboxWithMessageIdOnly = await prisma.billingEventOutbox.findMany({ select: { messageId: true } })
     * 
     */
    findMany<T extends BillingEventOutboxFindManyArgs>(args?: SelectSubset<T, BillingEventOutboxFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a BillingEventOutbox.
     * @param {BillingEventOutboxCreateArgs} args - Arguments to create a BillingEventOutbox.
     * @example
     * // Create one BillingEventOutbox
     * const BillingEventOutbox = await prisma.billingEventOutbox.create({
     *   data: {
     *     // ... data to create a BillingEventOutbox
     *   }
     * })
     * 
     */
    create<T extends BillingEventOutboxCreateArgs>(args: SelectSubset<T, BillingEventOutboxCreateArgs<ExtArgs>>): Prisma__BillingEventOutboxClient<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many BillingEventOutboxes.
     * @param {BillingEventOutboxCreateManyArgs} args - Arguments to create many BillingEventOutboxes.
     * @example
     * // Create many BillingEventOutboxes
     * const billingEventOutbox = await prisma.billingEventOutbox.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends BillingEventOutboxCreateManyArgs>(args?: SelectSubset<T, BillingEventOutboxCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many BillingEventOutboxes and returns the data saved in the database.
     * @param {BillingEventOutboxCreateManyAndReturnArgs} args - Arguments to create many BillingEventOutboxes.
     * @example
     * // Create many BillingEventOutboxes
     * const billingEventOutbox = await prisma.billingEventOutbox.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many BillingEventOutboxes and only return the `messageId`
     * const billingEventOutboxWithMessageIdOnly = await prisma.billingEventOutbox.createManyAndReturn({
     *   select: { messageId: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends BillingEventOutboxCreateManyAndReturnArgs>(args?: SelectSubset<T, BillingEventOutboxCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a BillingEventOutbox.
     * @param {BillingEventOutboxDeleteArgs} args - Arguments to delete one BillingEventOutbox.
     * @example
     * // Delete one BillingEventOutbox
     * const BillingEventOutbox = await prisma.billingEventOutbox.delete({
     *   where: {
     *     // ... filter to delete one BillingEventOutbox
     *   }
     * })
     * 
     */
    delete<T extends BillingEventOutboxDeleteArgs>(args: SelectSubset<T, BillingEventOutboxDeleteArgs<ExtArgs>>): Prisma__BillingEventOutboxClient<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one BillingEventOutbox.
     * @param {BillingEventOutboxUpdateArgs} args - Arguments to update one BillingEventOutbox.
     * @example
     * // Update one BillingEventOutbox
     * const billingEventOutbox = await prisma.billingEventOutbox.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends BillingEventOutboxUpdateArgs>(args: SelectSubset<T, BillingEventOutboxUpdateArgs<ExtArgs>>): Prisma__BillingEventOutboxClient<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more BillingEventOutboxes.
     * @param {BillingEventOutboxDeleteManyArgs} args - Arguments to filter BillingEventOutboxes to delete.
     * @example
     * // Delete a few BillingEventOutboxes
     * const { count } = await prisma.billingEventOutbox.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends BillingEventOutboxDeleteManyArgs>(args?: SelectSubset<T, BillingEventOutboxDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingEventOutboxes.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingEventOutboxUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many BillingEventOutboxes
     * const billingEventOutbox = await prisma.billingEventOutbox.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends BillingEventOutboxUpdateManyArgs>(args: SelectSubset<T, BillingEventOutboxUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more BillingEventOutboxes and returns the data updated in the database.
     * @param {BillingEventOutboxUpdateManyAndReturnArgs} args - Arguments to update many BillingEventOutboxes.
     * @example
     * // Update many BillingEventOutboxes
     * const billingEventOutbox = await prisma.billingEventOutbox.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more BillingEventOutboxes and only return the `messageId`
     * const billingEventOutboxWithMessageIdOnly = await prisma.billingEventOutbox.updateManyAndReturn({
     *   select: { messageId: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends BillingEventOutboxUpdateManyAndReturnArgs>(args: SelectSubset<T, BillingEventOutboxUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one BillingEventOutbox.
     * @param {BillingEventOutboxUpsertArgs} args - Arguments to update or create a BillingEventOutbox.
     * @example
     * // Update or create a BillingEventOutbox
     * const billingEventOutbox = await prisma.billingEventOutbox.upsert({
     *   create: {
     *     // ... data to create a BillingEventOutbox
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the BillingEventOutbox we want to update
     *   }
     * })
     */
    upsert<T extends BillingEventOutboxUpsertArgs>(args: SelectSubset<T, BillingEventOutboxUpsertArgs<ExtArgs>>): Prisma__BillingEventOutboxClient<$Result.GetResult<Prisma.$BillingEventOutboxPayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of BillingEventOutboxes.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingEventOutboxCountArgs} args - Arguments to filter BillingEventOutboxes to count.
     * @example
     * // Count the number of BillingEventOutboxes
     * const count = await prisma.billingEventOutbox.count({
     *   where: {
     *     // ... the filter for the BillingEventOutboxes we want to count
     *   }
     * })
    **/
    count<T extends BillingEventOutboxCountArgs>(
      args?: Subset<T, BillingEventOutboxCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], BillingEventOutboxCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a BillingEventOutbox.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingEventOutboxAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends BillingEventOutboxAggregateArgs>(args: Subset<T, BillingEventOutboxAggregateArgs>): Prisma.PrismaPromise<GetBillingEventOutboxAggregateType<T>>

    /**
     * Group by BillingEventOutbox.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {BillingEventOutboxGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends BillingEventOutboxGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: BillingEventOutboxGroupByArgs['orderBy'] }
        : { orderBy?: BillingEventOutboxGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, BillingEventOutboxGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetBillingEventOutboxGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the BillingEventOutbox model
   */
  readonly fields: BillingEventOutboxFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for BillingEventOutbox.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__BillingEventOutboxClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the BillingEventOutbox model
   */
  interface BillingEventOutboxFieldRefs {
    readonly messageId: FieldRef<"BillingEventOutbox", 'String'>
    readonly routingKey: FieldRef<"BillingEventOutbox", 'String'>
    readonly projectId: FieldRef<"BillingEventOutbox", 'String'>
    readonly status: FieldRef<"BillingEventOutbox", 'String'>
    readonly attempts: FieldRef<"BillingEventOutbox", 'Int'>
    readonly envelope: FieldRef<"BillingEventOutbox", 'Json'>
    readonly lastError: FieldRef<"BillingEventOutbox", 'String'>
    readonly createdAt: FieldRef<"BillingEventOutbox", 'DateTime'>
    readonly updatedAt: FieldRef<"BillingEventOutbox", 'DateTime'>
    readonly publishedAt: FieldRef<"BillingEventOutbox", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * BillingEventOutbox findUnique
   */
  export type BillingEventOutboxFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * Filter, which BillingEventOutbox to fetch.
     */
    where: BillingEventOutboxWhereUniqueInput
  }

  /**
   * BillingEventOutbox findUniqueOrThrow
   */
  export type BillingEventOutboxFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * Filter, which BillingEventOutbox to fetch.
     */
    where: BillingEventOutboxWhereUniqueInput
  }

  /**
   * BillingEventOutbox findFirst
   */
  export type BillingEventOutboxFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * Filter, which BillingEventOutbox to fetch.
     */
    where?: BillingEventOutboxWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingEventOutboxes to fetch.
     */
    orderBy?: BillingEventOutboxOrderByWithRelationInput | BillingEventOutboxOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingEventOutboxes.
     */
    cursor?: BillingEventOutboxWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingEventOutboxes from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingEventOutboxes.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingEventOutboxes.
     */
    distinct?: BillingEventOutboxScalarFieldEnum | BillingEventOutboxScalarFieldEnum[]
  }

  /**
   * BillingEventOutbox findFirstOrThrow
   */
  export type BillingEventOutboxFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * Filter, which BillingEventOutbox to fetch.
     */
    where?: BillingEventOutboxWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingEventOutboxes to fetch.
     */
    orderBy?: BillingEventOutboxOrderByWithRelationInput | BillingEventOutboxOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for BillingEventOutboxes.
     */
    cursor?: BillingEventOutboxWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingEventOutboxes from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingEventOutboxes.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingEventOutboxes.
     */
    distinct?: BillingEventOutboxScalarFieldEnum | BillingEventOutboxScalarFieldEnum[]
  }

  /**
   * BillingEventOutbox findMany
   */
  export type BillingEventOutboxFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * Filter, which BillingEventOutboxes to fetch.
     */
    where?: BillingEventOutboxWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of BillingEventOutboxes to fetch.
     */
    orderBy?: BillingEventOutboxOrderByWithRelationInput | BillingEventOutboxOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing BillingEventOutboxes.
     */
    cursor?: BillingEventOutboxWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` BillingEventOutboxes from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` BillingEventOutboxes.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of BillingEventOutboxes.
     */
    distinct?: BillingEventOutboxScalarFieldEnum | BillingEventOutboxScalarFieldEnum[]
  }

  /**
   * BillingEventOutbox create
   */
  export type BillingEventOutboxCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * The data needed to create a BillingEventOutbox.
     */
    data: XOR<BillingEventOutboxCreateInput, BillingEventOutboxUncheckedCreateInput>
  }

  /**
   * BillingEventOutbox createMany
   */
  export type BillingEventOutboxCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many BillingEventOutboxes.
     */
    data: BillingEventOutboxCreateManyInput | BillingEventOutboxCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingEventOutbox createManyAndReturn
   */
  export type BillingEventOutboxCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * The data used to create many BillingEventOutboxes.
     */
    data: BillingEventOutboxCreateManyInput | BillingEventOutboxCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * BillingEventOutbox update
   */
  export type BillingEventOutboxUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * The data needed to update a BillingEventOutbox.
     */
    data: XOR<BillingEventOutboxUpdateInput, BillingEventOutboxUncheckedUpdateInput>
    /**
     * Choose, which BillingEventOutbox to update.
     */
    where: BillingEventOutboxWhereUniqueInput
  }

  /**
   * BillingEventOutbox updateMany
   */
  export type BillingEventOutboxUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update BillingEventOutboxes.
     */
    data: XOR<BillingEventOutboxUpdateManyMutationInput, BillingEventOutboxUncheckedUpdateManyInput>
    /**
     * Filter which BillingEventOutboxes to update
     */
    where?: BillingEventOutboxWhereInput
    /**
     * Limit how many BillingEventOutboxes to update.
     */
    limit?: number
  }

  /**
   * BillingEventOutbox updateManyAndReturn
   */
  export type BillingEventOutboxUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * The data used to update BillingEventOutboxes.
     */
    data: XOR<BillingEventOutboxUpdateManyMutationInput, BillingEventOutboxUncheckedUpdateManyInput>
    /**
     * Filter which BillingEventOutboxes to update
     */
    where?: BillingEventOutboxWhereInput
    /**
     * Limit how many BillingEventOutboxes to update.
     */
    limit?: number
  }

  /**
   * BillingEventOutbox upsert
   */
  export type BillingEventOutboxUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * The filter to search for the BillingEventOutbox to update in case it exists.
     */
    where: BillingEventOutboxWhereUniqueInput
    /**
     * In case the BillingEventOutbox found by the `where` argument doesn't exist, create a new BillingEventOutbox with this data.
     */
    create: XOR<BillingEventOutboxCreateInput, BillingEventOutboxUncheckedCreateInput>
    /**
     * In case the BillingEventOutbox was found with the provided `where` argument, update it with this data.
     */
    update: XOR<BillingEventOutboxUpdateInput, BillingEventOutboxUncheckedUpdateInput>
  }

  /**
   * BillingEventOutbox delete
   */
  export type BillingEventOutboxDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
    /**
     * Filter which BillingEventOutbox to delete.
     */
    where: BillingEventOutboxWhereUniqueInput
  }

  /**
   * BillingEventOutbox deleteMany
   */
  export type BillingEventOutboxDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which BillingEventOutboxes to delete
     */
    where?: BillingEventOutboxWhereInput
    /**
     * Limit how many BillingEventOutboxes to delete.
     */
    limit?: number
  }

  /**
   * BillingEventOutbox without action
   */
  export type BillingEventOutboxDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the BillingEventOutbox
     */
    select?: BillingEventOutboxSelect<ExtArgs> | null
    /**
     * Omit specific fields from the BillingEventOutbox
     */
    omit?: BillingEventOutboxOmit<ExtArgs> | null
  }


  /**
   * Enums
   */

  export const TransactionIsolationLevel: {
    ReadUncommitted: 'ReadUncommitted',
    ReadCommitted: 'ReadCommitted',
    RepeatableRead: 'RepeatableRead',
    Serializable: 'Serializable'
  };

  export type TransactionIsolationLevel = (typeof TransactionIsolationLevel)[keyof typeof TransactionIsolationLevel]


  export const BillingPlanScalarFieldEnum: {
    id: 'id',
    code: 'code',
    name: 'name',
    description: 'description',
    priceMinor: 'priceMinor',
    currency: 'currency',
    billingPeriod: 'billingPeriod',
    isActive: 'isActive',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  };

  export type BillingPlanScalarFieldEnum = (typeof BillingPlanScalarFieldEnum)[keyof typeof BillingPlanScalarFieldEnum]


  export const BillingPlanQuotaScalarFieldEnum: {
    id: 'id',
    planId: 'planId',
    action: 'action',
    limit: 'limit',
    createdAt: 'createdAt'
  };

  export type BillingPlanQuotaScalarFieldEnum = (typeof BillingPlanQuotaScalarFieldEnum)[keyof typeof BillingPlanQuotaScalarFieldEnum]


  export const BillingSubscriptionScalarFieldEnum: {
    id: 'id',
    projectId: 'projectId',
    planId: 'planId',
    status: 'status',
    currentPeriodStart: 'currentPeriodStart',
    currentPeriodEnd: 'currentPeriodEnd',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  };

  export type BillingSubscriptionScalarFieldEnum = (typeof BillingSubscriptionScalarFieldEnum)[keyof typeof BillingSubscriptionScalarFieldEnum]


  export const BillingPaymentScalarFieldEnum: {
    id: 'id',
    projectId: 'projectId',
    subscriptionId: 'subscriptionId',
    amountMinor: 'amountMinor',
    currency: 'currency',
    status: 'status',
    provider: 'provider',
    providerPaymentId: 'providerPaymentId',
    paidAt: 'paidAt',
    createdAt: 'createdAt'
  };

  export type BillingPaymentScalarFieldEnum = (typeof BillingPaymentScalarFieldEnum)[keyof typeof BillingPaymentScalarFieldEnum]


  export const BillingInvoiceScalarFieldEnum: {
    id: 'id',
    projectId: 'projectId',
    subscriptionId: 'subscriptionId',
    number: 'number',
    amountMinor: 'amountMinor',
    currency: 'currency',
    status: 'status',
    issuedAt: 'issuedAt',
    dueAt: 'dueAt',
    paidAt: 'paidAt',
    createdAt: 'createdAt'
  };

  export type BillingInvoiceScalarFieldEnum = (typeof BillingInvoiceScalarFieldEnum)[keyof typeof BillingInvoiceScalarFieldEnum]


  export const BillingQuotaUsageScalarFieldEnum: {
    id: 'id',
    projectId: 'projectId',
    action: 'action',
    periodKey: 'periodKey',
    used: 'used',
    updatedAt: 'updatedAt',
    createdAt: 'createdAt'
  };

  export type BillingQuotaUsageScalarFieldEnum = (typeof BillingQuotaUsageScalarFieldEnum)[keyof typeof BillingQuotaUsageScalarFieldEnum]


  export const ModuleSubscriptionScalarFieldEnum: {
    id: 'id',
    projectId: 'projectId',
    moduleId: 'moduleId',
    priceModel: 'priceModel',
    unitPriceMinor: 'unitPriceMinor',
    currency: 'currency',
    state: 'state',
    revenueShareBps: 'revenueShareBps',
    partnerId: 'partnerId',
    trialEndsAt: 'trialEndsAt',
    gracePeriodEnd: 'gracePeriodEnd',
    currentPeriodStart: 'currentPeriodStart',
    currentPeriodEnd: 'currentPeriodEnd',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  };

  export type ModuleSubscriptionScalarFieldEnum = (typeof ModuleSubscriptionScalarFieldEnum)[keyof typeof ModuleSubscriptionScalarFieldEnum]


  export const AccountStateChangeScalarFieldEnum: {
    id: 'id',
    projectId: 'projectId',
    scope: 'scope',
    moduleId: 'moduleId',
    fromState: 'fromState',
    toState: 'toState',
    reason: 'reason',
    occurredAt: 'occurredAt'
  };

  export type AccountStateChangeScalarFieldEnum = (typeof AccountStateChangeScalarFieldEnum)[keyof typeof AccountStateChangeScalarFieldEnum]


  export const BillingProcessedMessageScalarFieldEnum: {
    dedupKey: 'dedupKey',
    routingKey: 'routingKey',
    processedAt: 'processedAt'
  };

  export type BillingProcessedMessageScalarFieldEnum = (typeof BillingProcessedMessageScalarFieldEnum)[keyof typeof BillingProcessedMessageScalarFieldEnum]


  export const BillingEventOutboxScalarFieldEnum: {
    messageId: 'messageId',
    routingKey: 'routingKey',
    projectId: 'projectId',
    status: 'status',
    attempts: 'attempts',
    envelope: 'envelope',
    lastError: 'lastError',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    publishedAt: 'publishedAt'
  };

  export type BillingEventOutboxScalarFieldEnum = (typeof BillingEventOutboxScalarFieldEnum)[keyof typeof BillingEventOutboxScalarFieldEnum]


  export const SortOrder: {
    asc: 'asc',
    desc: 'desc'
  };

  export type SortOrder = (typeof SortOrder)[keyof typeof SortOrder]


  export const JsonNullValueInput: {
    JsonNull: typeof JsonNull
  };

  export type JsonNullValueInput = (typeof JsonNullValueInput)[keyof typeof JsonNullValueInput]


  export const QueryMode: {
    default: 'default',
    insensitive: 'insensitive'
  };

  export type QueryMode = (typeof QueryMode)[keyof typeof QueryMode]


  export const NullsOrder: {
    first: 'first',
    last: 'last'
  };

  export type NullsOrder = (typeof NullsOrder)[keyof typeof NullsOrder]


  export const JsonNullValueFilter: {
    DbNull: typeof DbNull,
    JsonNull: typeof JsonNull,
    AnyNull: typeof AnyNull
  };

  export type JsonNullValueFilter = (typeof JsonNullValueFilter)[keyof typeof JsonNullValueFilter]


  /**
   * Field references
   */


  /**
   * Reference to a field of type 'String'
   */
  export type StringFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'String'>
    


  /**
   * Reference to a field of type 'String[]'
   */
  export type ListStringFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'String[]'>
    


  /**
   * Reference to a field of type 'BigInt'
   */
  export type BigIntFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'BigInt'>
    


  /**
   * Reference to a field of type 'BigInt[]'
   */
  export type ListBigIntFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'BigInt[]'>
    


  /**
   * Reference to a field of type 'Boolean'
   */
  export type BooleanFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Boolean'>
    


  /**
   * Reference to a field of type 'DateTime'
   */
  export type DateTimeFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'DateTime'>
    


  /**
   * Reference to a field of type 'DateTime[]'
   */
  export type ListDateTimeFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'DateTime[]'>
    


  /**
   * Reference to a field of type 'Int'
   */
  export type IntFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Int'>
    


  /**
   * Reference to a field of type 'Int[]'
   */
  export type ListIntFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Int[]'>
    


  /**
   * Reference to a field of type 'Json'
   */
  export type JsonFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Json'>
    


  /**
   * Reference to a field of type 'QueryMode'
   */
  export type EnumQueryModeFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'QueryMode'>
    


  /**
   * Reference to a field of type 'Float'
   */
  export type FloatFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Float'>
    


  /**
   * Reference to a field of type 'Float[]'
   */
  export type ListFloatFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Float[]'>
    
  /**
   * Deep Input Types
   */


  export type BillingPlanWhereInput = {
    AND?: BillingPlanWhereInput | BillingPlanWhereInput[]
    OR?: BillingPlanWhereInput[]
    NOT?: BillingPlanWhereInput | BillingPlanWhereInput[]
    id?: StringFilter<"BillingPlan"> | string
    code?: StringFilter<"BillingPlan"> | string
    name?: StringFilter<"BillingPlan"> | string
    description?: StringNullableFilter<"BillingPlan"> | string | null
    priceMinor?: BigIntFilter<"BillingPlan"> | bigint | number
    currency?: StringFilter<"BillingPlan"> | string
    billingPeriod?: StringFilter<"BillingPlan"> | string
    isActive?: BoolFilter<"BillingPlan"> | boolean
    createdAt?: DateTimeFilter<"BillingPlan"> | Date | string
    updatedAt?: DateTimeFilter<"BillingPlan"> | Date | string
    quotas?: BillingPlanQuotaListRelationFilter
    subscriptions?: BillingSubscriptionListRelationFilter
  }

  export type BillingPlanOrderByWithRelationInput = {
    id?: SortOrder
    code?: SortOrder
    name?: SortOrder
    description?: SortOrderInput | SortOrder
    priceMinor?: SortOrder
    currency?: SortOrder
    billingPeriod?: SortOrder
    isActive?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    quotas?: BillingPlanQuotaOrderByRelationAggregateInput
    subscriptions?: BillingSubscriptionOrderByRelationAggregateInput
  }

  export type BillingPlanWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    code?: string
    AND?: BillingPlanWhereInput | BillingPlanWhereInput[]
    OR?: BillingPlanWhereInput[]
    NOT?: BillingPlanWhereInput | BillingPlanWhereInput[]
    name?: StringFilter<"BillingPlan"> | string
    description?: StringNullableFilter<"BillingPlan"> | string | null
    priceMinor?: BigIntFilter<"BillingPlan"> | bigint | number
    currency?: StringFilter<"BillingPlan"> | string
    billingPeriod?: StringFilter<"BillingPlan"> | string
    isActive?: BoolFilter<"BillingPlan"> | boolean
    createdAt?: DateTimeFilter<"BillingPlan"> | Date | string
    updatedAt?: DateTimeFilter<"BillingPlan"> | Date | string
    quotas?: BillingPlanQuotaListRelationFilter
    subscriptions?: BillingSubscriptionListRelationFilter
  }, "id" | "code">

  export type BillingPlanOrderByWithAggregationInput = {
    id?: SortOrder
    code?: SortOrder
    name?: SortOrder
    description?: SortOrderInput | SortOrder
    priceMinor?: SortOrder
    currency?: SortOrder
    billingPeriod?: SortOrder
    isActive?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    _count?: BillingPlanCountOrderByAggregateInput
    _avg?: BillingPlanAvgOrderByAggregateInput
    _max?: BillingPlanMaxOrderByAggregateInput
    _min?: BillingPlanMinOrderByAggregateInput
    _sum?: BillingPlanSumOrderByAggregateInput
  }

  export type BillingPlanScalarWhereWithAggregatesInput = {
    AND?: BillingPlanScalarWhereWithAggregatesInput | BillingPlanScalarWhereWithAggregatesInput[]
    OR?: BillingPlanScalarWhereWithAggregatesInput[]
    NOT?: BillingPlanScalarWhereWithAggregatesInput | BillingPlanScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"BillingPlan"> | string
    code?: StringWithAggregatesFilter<"BillingPlan"> | string
    name?: StringWithAggregatesFilter<"BillingPlan"> | string
    description?: StringNullableWithAggregatesFilter<"BillingPlan"> | string | null
    priceMinor?: BigIntWithAggregatesFilter<"BillingPlan"> | bigint | number
    currency?: StringWithAggregatesFilter<"BillingPlan"> | string
    billingPeriod?: StringWithAggregatesFilter<"BillingPlan"> | string
    isActive?: BoolWithAggregatesFilter<"BillingPlan"> | boolean
    createdAt?: DateTimeWithAggregatesFilter<"BillingPlan"> | Date | string
    updatedAt?: DateTimeWithAggregatesFilter<"BillingPlan"> | Date | string
  }

  export type BillingPlanQuotaWhereInput = {
    AND?: BillingPlanQuotaWhereInput | BillingPlanQuotaWhereInput[]
    OR?: BillingPlanQuotaWhereInput[]
    NOT?: BillingPlanQuotaWhereInput | BillingPlanQuotaWhereInput[]
    id?: StringFilter<"BillingPlanQuota"> | string
    planId?: StringFilter<"BillingPlanQuota"> | string
    action?: StringFilter<"BillingPlanQuota"> | string
    limit?: BigIntFilter<"BillingPlanQuota"> | bigint | number
    createdAt?: DateTimeFilter<"BillingPlanQuota"> | Date | string
    plan?: XOR<BillingPlanScalarRelationFilter, BillingPlanWhereInput>
  }

  export type BillingPlanQuotaOrderByWithRelationInput = {
    id?: SortOrder
    planId?: SortOrder
    action?: SortOrder
    limit?: SortOrder
    createdAt?: SortOrder
    plan?: BillingPlanOrderByWithRelationInput
  }

  export type BillingPlanQuotaWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    planId_action?: BillingPlanQuotaPlanIdActionCompoundUniqueInput
    AND?: BillingPlanQuotaWhereInput | BillingPlanQuotaWhereInput[]
    OR?: BillingPlanQuotaWhereInput[]
    NOT?: BillingPlanQuotaWhereInput | BillingPlanQuotaWhereInput[]
    planId?: StringFilter<"BillingPlanQuota"> | string
    action?: StringFilter<"BillingPlanQuota"> | string
    limit?: BigIntFilter<"BillingPlanQuota"> | bigint | number
    createdAt?: DateTimeFilter<"BillingPlanQuota"> | Date | string
    plan?: XOR<BillingPlanScalarRelationFilter, BillingPlanWhereInput>
  }, "id" | "planId_action">

  export type BillingPlanQuotaOrderByWithAggregationInput = {
    id?: SortOrder
    planId?: SortOrder
    action?: SortOrder
    limit?: SortOrder
    createdAt?: SortOrder
    _count?: BillingPlanQuotaCountOrderByAggregateInput
    _avg?: BillingPlanQuotaAvgOrderByAggregateInput
    _max?: BillingPlanQuotaMaxOrderByAggregateInput
    _min?: BillingPlanQuotaMinOrderByAggregateInput
    _sum?: BillingPlanQuotaSumOrderByAggregateInput
  }

  export type BillingPlanQuotaScalarWhereWithAggregatesInput = {
    AND?: BillingPlanQuotaScalarWhereWithAggregatesInput | BillingPlanQuotaScalarWhereWithAggregatesInput[]
    OR?: BillingPlanQuotaScalarWhereWithAggregatesInput[]
    NOT?: BillingPlanQuotaScalarWhereWithAggregatesInput | BillingPlanQuotaScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"BillingPlanQuota"> | string
    planId?: StringWithAggregatesFilter<"BillingPlanQuota"> | string
    action?: StringWithAggregatesFilter<"BillingPlanQuota"> | string
    limit?: BigIntWithAggregatesFilter<"BillingPlanQuota"> | bigint | number
    createdAt?: DateTimeWithAggregatesFilter<"BillingPlanQuota"> | Date | string
  }

  export type BillingSubscriptionWhereInput = {
    AND?: BillingSubscriptionWhereInput | BillingSubscriptionWhereInput[]
    OR?: BillingSubscriptionWhereInput[]
    NOT?: BillingSubscriptionWhereInput | BillingSubscriptionWhereInput[]
    id?: StringFilter<"BillingSubscription"> | string
    projectId?: StringFilter<"BillingSubscription"> | string
    planId?: StringFilter<"BillingSubscription"> | string
    status?: StringFilter<"BillingSubscription"> | string
    currentPeriodStart?: DateTimeFilter<"BillingSubscription"> | Date | string
    currentPeriodEnd?: DateTimeFilter<"BillingSubscription"> | Date | string
    createdAt?: DateTimeFilter<"BillingSubscription"> | Date | string
    updatedAt?: DateTimeFilter<"BillingSubscription"> | Date | string
    plan?: XOR<BillingPlanScalarRelationFilter, BillingPlanWhereInput>
    payments?: BillingPaymentListRelationFilter
    invoices?: BillingInvoiceListRelationFilter
  }

  export type BillingSubscriptionOrderByWithRelationInput = {
    id?: SortOrder
    projectId?: SortOrder
    planId?: SortOrder
    status?: SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    plan?: BillingPlanOrderByWithRelationInput
    payments?: BillingPaymentOrderByRelationAggregateInput
    invoices?: BillingInvoiceOrderByRelationAggregateInput
  }

  export type BillingSubscriptionWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    AND?: BillingSubscriptionWhereInput | BillingSubscriptionWhereInput[]
    OR?: BillingSubscriptionWhereInput[]
    NOT?: BillingSubscriptionWhereInput | BillingSubscriptionWhereInput[]
    projectId?: StringFilter<"BillingSubscription"> | string
    planId?: StringFilter<"BillingSubscription"> | string
    status?: StringFilter<"BillingSubscription"> | string
    currentPeriodStart?: DateTimeFilter<"BillingSubscription"> | Date | string
    currentPeriodEnd?: DateTimeFilter<"BillingSubscription"> | Date | string
    createdAt?: DateTimeFilter<"BillingSubscription"> | Date | string
    updatedAt?: DateTimeFilter<"BillingSubscription"> | Date | string
    plan?: XOR<BillingPlanScalarRelationFilter, BillingPlanWhereInput>
    payments?: BillingPaymentListRelationFilter
    invoices?: BillingInvoiceListRelationFilter
  }, "id">

  export type BillingSubscriptionOrderByWithAggregationInput = {
    id?: SortOrder
    projectId?: SortOrder
    planId?: SortOrder
    status?: SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    _count?: BillingSubscriptionCountOrderByAggregateInput
    _max?: BillingSubscriptionMaxOrderByAggregateInput
    _min?: BillingSubscriptionMinOrderByAggregateInput
  }

  export type BillingSubscriptionScalarWhereWithAggregatesInput = {
    AND?: BillingSubscriptionScalarWhereWithAggregatesInput | BillingSubscriptionScalarWhereWithAggregatesInput[]
    OR?: BillingSubscriptionScalarWhereWithAggregatesInput[]
    NOT?: BillingSubscriptionScalarWhereWithAggregatesInput | BillingSubscriptionScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"BillingSubscription"> | string
    projectId?: StringWithAggregatesFilter<"BillingSubscription"> | string
    planId?: StringWithAggregatesFilter<"BillingSubscription"> | string
    status?: StringWithAggregatesFilter<"BillingSubscription"> | string
    currentPeriodStart?: DateTimeWithAggregatesFilter<"BillingSubscription"> | Date | string
    currentPeriodEnd?: DateTimeWithAggregatesFilter<"BillingSubscription"> | Date | string
    createdAt?: DateTimeWithAggregatesFilter<"BillingSubscription"> | Date | string
    updatedAt?: DateTimeWithAggregatesFilter<"BillingSubscription"> | Date | string
  }

  export type BillingPaymentWhereInput = {
    AND?: BillingPaymentWhereInput | BillingPaymentWhereInput[]
    OR?: BillingPaymentWhereInput[]
    NOT?: BillingPaymentWhereInput | BillingPaymentWhereInput[]
    id?: StringFilter<"BillingPayment"> | string
    projectId?: StringFilter<"BillingPayment"> | string
    subscriptionId?: StringFilter<"BillingPayment"> | string
    amountMinor?: BigIntFilter<"BillingPayment"> | bigint | number
    currency?: StringFilter<"BillingPayment"> | string
    status?: StringFilter<"BillingPayment"> | string
    provider?: StringFilter<"BillingPayment"> | string
    providerPaymentId?: StringNullableFilter<"BillingPayment"> | string | null
    paidAt?: DateTimeNullableFilter<"BillingPayment"> | Date | string | null
    createdAt?: DateTimeFilter<"BillingPayment"> | Date | string
    subscription?: XOR<BillingSubscriptionScalarRelationFilter, BillingSubscriptionWhereInput>
  }

  export type BillingPaymentOrderByWithRelationInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    provider?: SortOrder
    providerPaymentId?: SortOrderInput | SortOrder
    paidAt?: SortOrderInput | SortOrder
    createdAt?: SortOrder
    subscription?: BillingSubscriptionOrderByWithRelationInput
  }

  export type BillingPaymentWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    AND?: BillingPaymentWhereInput | BillingPaymentWhereInput[]
    OR?: BillingPaymentWhereInput[]
    NOT?: BillingPaymentWhereInput | BillingPaymentWhereInput[]
    projectId?: StringFilter<"BillingPayment"> | string
    subscriptionId?: StringFilter<"BillingPayment"> | string
    amountMinor?: BigIntFilter<"BillingPayment"> | bigint | number
    currency?: StringFilter<"BillingPayment"> | string
    status?: StringFilter<"BillingPayment"> | string
    provider?: StringFilter<"BillingPayment"> | string
    providerPaymentId?: StringNullableFilter<"BillingPayment"> | string | null
    paidAt?: DateTimeNullableFilter<"BillingPayment"> | Date | string | null
    createdAt?: DateTimeFilter<"BillingPayment"> | Date | string
    subscription?: XOR<BillingSubscriptionScalarRelationFilter, BillingSubscriptionWhereInput>
  }, "id">

  export type BillingPaymentOrderByWithAggregationInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    provider?: SortOrder
    providerPaymentId?: SortOrderInput | SortOrder
    paidAt?: SortOrderInput | SortOrder
    createdAt?: SortOrder
    _count?: BillingPaymentCountOrderByAggregateInput
    _avg?: BillingPaymentAvgOrderByAggregateInput
    _max?: BillingPaymentMaxOrderByAggregateInput
    _min?: BillingPaymentMinOrderByAggregateInput
    _sum?: BillingPaymentSumOrderByAggregateInput
  }

  export type BillingPaymentScalarWhereWithAggregatesInput = {
    AND?: BillingPaymentScalarWhereWithAggregatesInput | BillingPaymentScalarWhereWithAggregatesInput[]
    OR?: BillingPaymentScalarWhereWithAggregatesInput[]
    NOT?: BillingPaymentScalarWhereWithAggregatesInput | BillingPaymentScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"BillingPayment"> | string
    projectId?: StringWithAggregatesFilter<"BillingPayment"> | string
    subscriptionId?: StringWithAggregatesFilter<"BillingPayment"> | string
    amountMinor?: BigIntWithAggregatesFilter<"BillingPayment"> | bigint | number
    currency?: StringWithAggregatesFilter<"BillingPayment"> | string
    status?: StringWithAggregatesFilter<"BillingPayment"> | string
    provider?: StringWithAggregatesFilter<"BillingPayment"> | string
    providerPaymentId?: StringNullableWithAggregatesFilter<"BillingPayment"> | string | null
    paidAt?: DateTimeNullableWithAggregatesFilter<"BillingPayment"> | Date | string | null
    createdAt?: DateTimeWithAggregatesFilter<"BillingPayment"> | Date | string
  }

  export type BillingInvoiceWhereInput = {
    AND?: BillingInvoiceWhereInput | BillingInvoiceWhereInput[]
    OR?: BillingInvoiceWhereInput[]
    NOT?: BillingInvoiceWhereInput | BillingInvoiceWhereInput[]
    id?: StringFilter<"BillingInvoice"> | string
    projectId?: StringFilter<"BillingInvoice"> | string
    subscriptionId?: StringFilter<"BillingInvoice"> | string
    number?: StringFilter<"BillingInvoice"> | string
    amountMinor?: BigIntFilter<"BillingInvoice"> | bigint | number
    currency?: StringFilter<"BillingInvoice"> | string
    status?: StringFilter<"BillingInvoice"> | string
    issuedAt?: DateTimeFilter<"BillingInvoice"> | Date | string
    dueAt?: DateTimeFilter<"BillingInvoice"> | Date | string
    paidAt?: DateTimeNullableFilter<"BillingInvoice"> | Date | string | null
    createdAt?: DateTimeFilter<"BillingInvoice"> | Date | string
    subscription?: XOR<BillingSubscriptionScalarRelationFilter, BillingSubscriptionWhereInput>
  }

  export type BillingInvoiceOrderByWithRelationInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    number?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    issuedAt?: SortOrder
    dueAt?: SortOrder
    paidAt?: SortOrderInput | SortOrder
    createdAt?: SortOrder
    subscription?: BillingSubscriptionOrderByWithRelationInput
  }

  export type BillingInvoiceWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    projectId_number?: BillingInvoiceProjectIdNumberCompoundUniqueInput
    AND?: BillingInvoiceWhereInput | BillingInvoiceWhereInput[]
    OR?: BillingInvoiceWhereInput[]
    NOT?: BillingInvoiceWhereInput | BillingInvoiceWhereInput[]
    projectId?: StringFilter<"BillingInvoice"> | string
    subscriptionId?: StringFilter<"BillingInvoice"> | string
    number?: StringFilter<"BillingInvoice"> | string
    amountMinor?: BigIntFilter<"BillingInvoice"> | bigint | number
    currency?: StringFilter<"BillingInvoice"> | string
    status?: StringFilter<"BillingInvoice"> | string
    issuedAt?: DateTimeFilter<"BillingInvoice"> | Date | string
    dueAt?: DateTimeFilter<"BillingInvoice"> | Date | string
    paidAt?: DateTimeNullableFilter<"BillingInvoice"> | Date | string | null
    createdAt?: DateTimeFilter<"BillingInvoice"> | Date | string
    subscription?: XOR<BillingSubscriptionScalarRelationFilter, BillingSubscriptionWhereInput>
  }, "id" | "projectId_number">

  export type BillingInvoiceOrderByWithAggregationInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    number?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    issuedAt?: SortOrder
    dueAt?: SortOrder
    paidAt?: SortOrderInput | SortOrder
    createdAt?: SortOrder
    _count?: BillingInvoiceCountOrderByAggregateInput
    _avg?: BillingInvoiceAvgOrderByAggregateInput
    _max?: BillingInvoiceMaxOrderByAggregateInput
    _min?: BillingInvoiceMinOrderByAggregateInput
    _sum?: BillingInvoiceSumOrderByAggregateInput
  }

  export type BillingInvoiceScalarWhereWithAggregatesInput = {
    AND?: BillingInvoiceScalarWhereWithAggregatesInput | BillingInvoiceScalarWhereWithAggregatesInput[]
    OR?: BillingInvoiceScalarWhereWithAggregatesInput[]
    NOT?: BillingInvoiceScalarWhereWithAggregatesInput | BillingInvoiceScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"BillingInvoice"> | string
    projectId?: StringWithAggregatesFilter<"BillingInvoice"> | string
    subscriptionId?: StringWithAggregatesFilter<"BillingInvoice"> | string
    number?: StringWithAggregatesFilter<"BillingInvoice"> | string
    amountMinor?: BigIntWithAggregatesFilter<"BillingInvoice"> | bigint | number
    currency?: StringWithAggregatesFilter<"BillingInvoice"> | string
    status?: StringWithAggregatesFilter<"BillingInvoice"> | string
    issuedAt?: DateTimeWithAggregatesFilter<"BillingInvoice"> | Date | string
    dueAt?: DateTimeWithAggregatesFilter<"BillingInvoice"> | Date | string
    paidAt?: DateTimeNullableWithAggregatesFilter<"BillingInvoice"> | Date | string | null
    createdAt?: DateTimeWithAggregatesFilter<"BillingInvoice"> | Date | string
  }

  export type BillingQuotaUsageWhereInput = {
    AND?: BillingQuotaUsageWhereInput | BillingQuotaUsageWhereInput[]
    OR?: BillingQuotaUsageWhereInput[]
    NOT?: BillingQuotaUsageWhereInput | BillingQuotaUsageWhereInput[]
    id?: StringFilter<"BillingQuotaUsage"> | string
    projectId?: StringFilter<"BillingQuotaUsage"> | string
    action?: StringFilter<"BillingQuotaUsage"> | string
    periodKey?: StringFilter<"BillingQuotaUsage"> | string
    used?: BigIntFilter<"BillingQuotaUsage"> | bigint | number
    updatedAt?: DateTimeFilter<"BillingQuotaUsage"> | Date | string
    createdAt?: DateTimeFilter<"BillingQuotaUsage"> | Date | string
  }

  export type BillingQuotaUsageOrderByWithRelationInput = {
    id?: SortOrder
    projectId?: SortOrder
    action?: SortOrder
    periodKey?: SortOrder
    used?: SortOrder
    updatedAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingQuotaUsageWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    projectId_action_periodKey?: BillingQuotaUsageProjectIdActionPeriodKeyCompoundUniqueInput
    AND?: BillingQuotaUsageWhereInput | BillingQuotaUsageWhereInput[]
    OR?: BillingQuotaUsageWhereInput[]
    NOT?: BillingQuotaUsageWhereInput | BillingQuotaUsageWhereInput[]
    projectId?: StringFilter<"BillingQuotaUsage"> | string
    action?: StringFilter<"BillingQuotaUsage"> | string
    periodKey?: StringFilter<"BillingQuotaUsage"> | string
    used?: BigIntFilter<"BillingQuotaUsage"> | bigint | number
    updatedAt?: DateTimeFilter<"BillingQuotaUsage"> | Date | string
    createdAt?: DateTimeFilter<"BillingQuotaUsage"> | Date | string
  }, "id" | "projectId_action_periodKey">

  export type BillingQuotaUsageOrderByWithAggregationInput = {
    id?: SortOrder
    projectId?: SortOrder
    action?: SortOrder
    periodKey?: SortOrder
    used?: SortOrder
    updatedAt?: SortOrder
    createdAt?: SortOrder
    _count?: BillingQuotaUsageCountOrderByAggregateInput
    _avg?: BillingQuotaUsageAvgOrderByAggregateInput
    _max?: BillingQuotaUsageMaxOrderByAggregateInput
    _min?: BillingQuotaUsageMinOrderByAggregateInput
    _sum?: BillingQuotaUsageSumOrderByAggregateInput
  }

  export type BillingQuotaUsageScalarWhereWithAggregatesInput = {
    AND?: BillingQuotaUsageScalarWhereWithAggregatesInput | BillingQuotaUsageScalarWhereWithAggregatesInput[]
    OR?: BillingQuotaUsageScalarWhereWithAggregatesInput[]
    NOT?: BillingQuotaUsageScalarWhereWithAggregatesInput | BillingQuotaUsageScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"BillingQuotaUsage"> | string
    projectId?: StringWithAggregatesFilter<"BillingQuotaUsage"> | string
    action?: StringWithAggregatesFilter<"BillingQuotaUsage"> | string
    periodKey?: StringWithAggregatesFilter<"BillingQuotaUsage"> | string
    used?: BigIntWithAggregatesFilter<"BillingQuotaUsage"> | bigint | number
    updatedAt?: DateTimeWithAggregatesFilter<"BillingQuotaUsage"> | Date | string
    createdAt?: DateTimeWithAggregatesFilter<"BillingQuotaUsage"> | Date | string
  }

  export type ModuleSubscriptionWhereInput = {
    AND?: ModuleSubscriptionWhereInput | ModuleSubscriptionWhereInput[]
    OR?: ModuleSubscriptionWhereInput[]
    NOT?: ModuleSubscriptionWhereInput | ModuleSubscriptionWhereInput[]
    id?: StringFilter<"ModuleSubscription"> | string
    projectId?: StringFilter<"ModuleSubscription"> | string
    moduleId?: StringFilter<"ModuleSubscription"> | string
    priceModel?: StringFilter<"ModuleSubscription"> | string
    unitPriceMinor?: BigIntFilter<"ModuleSubscription"> | bigint | number
    currency?: StringFilter<"ModuleSubscription"> | string
    state?: StringFilter<"ModuleSubscription"> | string
    revenueShareBps?: IntFilter<"ModuleSubscription"> | number
    partnerId?: StringNullableFilter<"ModuleSubscription"> | string | null
    trialEndsAt?: DateTimeNullableFilter<"ModuleSubscription"> | Date | string | null
    gracePeriodEnd?: DateTimeNullableFilter<"ModuleSubscription"> | Date | string | null
    currentPeriodStart?: DateTimeFilter<"ModuleSubscription"> | Date | string
    currentPeriodEnd?: DateTimeFilter<"ModuleSubscription"> | Date | string
    createdAt?: DateTimeFilter<"ModuleSubscription"> | Date | string
    updatedAt?: DateTimeFilter<"ModuleSubscription"> | Date | string
  }

  export type ModuleSubscriptionOrderByWithRelationInput = {
    id?: SortOrder
    projectId?: SortOrder
    moduleId?: SortOrder
    priceModel?: SortOrder
    unitPriceMinor?: SortOrder
    currency?: SortOrder
    state?: SortOrder
    revenueShareBps?: SortOrder
    partnerId?: SortOrderInput | SortOrder
    trialEndsAt?: SortOrderInput | SortOrder
    gracePeriodEnd?: SortOrderInput | SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type ModuleSubscriptionWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    projectId_moduleId?: ModuleSubscriptionProjectIdModuleIdCompoundUniqueInput
    AND?: ModuleSubscriptionWhereInput | ModuleSubscriptionWhereInput[]
    OR?: ModuleSubscriptionWhereInput[]
    NOT?: ModuleSubscriptionWhereInput | ModuleSubscriptionWhereInput[]
    projectId?: StringFilter<"ModuleSubscription"> | string
    moduleId?: StringFilter<"ModuleSubscription"> | string
    priceModel?: StringFilter<"ModuleSubscription"> | string
    unitPriceMinor?: BigIntFilter<"ModuleSubscription"> | bigint | number
    currency?: StringFilter<"ModuleSubscription"> | string
    state?: StringFilter<"ModuleSubscription"> | string
    revenueShareBps?: IntFilter<"ModuleSubscription"> | number
    partnerId?: StringNullableFilter<"ModuleSubscription"> | string | null
    trialEndsAt?: DateTimeNullableFilter<"ModuleSubscription"> | Date | string | null
    gracePeriodEnd?: DateTimeNullableFilter<"ModuleSubscription"> | Date | string | null
    currentPeriodStart?: DateTimeFilter<"ModuleSubscription"> | Date | string
    currentPeriodEnd?: DateTimeFilter<"ModuleSubscription"> | Date | string
    createdAt?: DateTimeFilter<"ModuleSubscription"> | Date | string
    updatedAt?: DateTimeFilter<"ModuleSubscription"> | Date | string
  }, "id" | "projectId_moduleId">

  export type ModuleSubscriptionOrderByWithAggregationInput = {
    id?: SortOrder
    projectId?: SortOrder
    moduleId?: SortOrder
    priceModel?: SortOrder
    unitPriceMinor?: SortOrder
    currency?: SortOrder
    state?: SortOrder
    revenueShareBps?: SortOrder
    partnerId?: SortOrderInput | SortOrder
    trialEndsAt?: SortOrderInput | SortOrder
    gracePeriodEnd?: SortOrderInput | SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    _count?: ModuleSubscriptionCountOrderByAggregateInput
    _avg?: ModuleSubscriptionAvgOrderByAggregateInput
    _max?: ModuleSubscriptionMaxOrderByAggregateInput
    _min?: ModuleSubscriptionMinOrderByAggregateInput
    _sum?: ModuleSubscriptionSumOrderByAggregateInput
  }

  export type ModuleSubscriptionScalarWhereWithAggregatesInput = {
    AND?: ModuleSubscriptionScalarWhereWithAggregatesInput | ModuleSubscriptionScalarWhereWithAggregatesInput[]
    OR?: ModuleSubscriptionScalarWhereWithAggregatesInput[]
    NOT?: ModuleSubscriptionScalarWhereWithAggregatesInput | ModuleSubscriptionScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"ModuleSubscription"> | string
    projectId?: StringWithAggregatesFilter<"ModuleSubscription"> | string
    moduleId?: StringWithAggregatesFilter<"ModuleSubscription"> | string
    priceModel?: StringWithAggregatesFilter<"ModuleSubscription"> | string
    unitPriceMinor?: BigIntWithAggregatesFilter<"ModuleSubscription"> | bigint | number
    currency?: StringWithAggregatesFilter<"ModuleSubscription"> | string
    state?: StringWithAggregatesFilter<"ModuleSubscription"> | string
    revenueShareBps?: IntWithAggregatesFilter<"ModuleSubscription"> | number
    partnerId?: StringNullableWithAggregatesFilter<"ModuleSubscription"> | string | null
    trialEndsAt?: DateTimeNullableWithAggregatesFilter<"ModuleSubscription"> | Date | string | null
    gracePeriodEnd?: DateTimeNullableWithAggregatesFilter<"ModuleSubscription"> | Date | string | null
    currentPeriodStart?: DateTimeWithAggregatesFilter<"ModuleSubscription"> | Date | string
    currentPeriodEnd?: DateTimeWithAggregatesFilter<"ModuleSubscription"> | Date | string
    createdAt?: DateTimeWithAggregatesFilter<"ModuleSubscription"> | Date | string
    updatedAt?: DateTimeWithAggregatesFilter<"ModuleSubscription"> | Date | string
  }

  export type AccountStateChangeWhereInput = {
    AND?: AccountStateChangeWhereInput | AccountStateChangeWhereInput[]
    OR?: AccountStateChangeWhereInput[]
    NOT?: AccountStateChangeWhereInput | AccountStateChangeWhereInput[]
    id?: StringFilter<"AccountStateChange"> | string
    projectId?: StringFilter<"AccountStateChange"> | string
    scope?: StringFilter<"AccountStateChange"> | string
    moduleId?: StringNullableFilter<"AccountStateChange"> | string | null
    fromState?: StringFilter<"AccountStateChange"> | string
    toState?: StringFilter<"AccountStateChange"> | string
    reason?: StringFilter<"AccountStateChange"> | string
    occurredAt?: DateTimeFilter<"AccountStateChange"> | Date | string
  }

  export type AccountStateChangeOrderByWithRelationInput = {
    id?: SortOrder
    projectId?: SortOrder
    scope?: SortOrder
    moduleId?: SortOrderInput | SortOrder
    fromState?: SortOrder
    toState?: SortOrder
    reason?: SortOrder
    occurredAt?: SortOrder
  }

  export type AccountStateChangeWhereUniqueInput = Prisma.AtLeast<{
    id?: string
    AND?: AccountStateChangeWhereInput | AccountStateChangeWhereInput[]
    OR?: AccountStateChangeWhereInput[]
    NOT?: AccountStateChangeWhereInput | AccountStateChangeWhereInput[]
    projectId?: StringFilter<"AccountStateChange"> | string
    scope?: StringFilter<"AccountStateChange"> | string
    moduleId?: StringNullableFilter<"AccountStateChange"> | string | null
    fromState?: StringFilter<"AccountStateChange"> | string
    toState?: StringFilter<"AccountStateChange"> | string
    reason?: StringFilter<"AccountStateChange"> | string
    occurredAt?: DateTimeFilter<"AccountStateChange"> | Date | string
  }, "id">

  export type AccountStateChangeOrderByWithAggregationInput = {
    id?: SortOrder
    projectId?: SortOrder
    scope?: SortOrder
    moduleId?: SortOrderInput | SortOrder
    fromState?: SortOrder
    toState?: SortOrder
    reason?: SortOrder
    occurredAt?: SortOrder
    _count?: AccountStateChangeCountOrderByAggregateInput
    _max?: AccountStateChangeMaxOrderByAggregateInput
    _min?: AccountStateChangeMinOrderByAggregateInput
  }

  export type AccountStateChangeScalarWhereWithAggregatesInput = {
    AND?: AccountStateChangeScalarWhereWithAggregatesInput | AccountStateChangeScalarWhereWithAggregatesInput[]
    OR?: AccountStateChangeScalarWhereWithAggregatesInput[]
    NOT?: AccountStateChangeScalarWhereWithAggregatesInput | AccountStateChangeScalarWhereWithAggregatesInput[]
    id?: StringWithAggregatesFilter<"AccountStateChange"> | string
    projectId?: StringWithAggregatesFilter<"AccountStateChange"> | string
    scope?: StringWithAggregatesFilter<"AccountStateChange"> | string
    moduleId?: StringNullableWithAggregatesFilter<"AccountStateChange"> | string | null
    fromState?: StringWithAggregatesFilter<"AccountStateChange"> | string
    toState?: StringWithAggregatesFilter<"AccountStateChange"> | string
    reason?: StringWithAggregatesFilter<"AccountStateChange"> | string
    occurredAt?: DateTimeWithAggregatesFilter<"AccountStateChange"> | Date | string
  }

  export type BillingProcessedMessageWhereInput = {
    AND?: BillingProcessedMessageWhereInput | BillingProcessedMessageWhereInput[]
    OR?: BillingProcessedMessageWhereInput[]
    NOT?: BillingProcessedMessageWhereInput | BillingProcessedMessageWhereInput[]
    dedupKey?: StringFilter<"BillingProcessedMessage"> | string
    routingKey?: StringFilter<"BillingProcessedMessage"> | string
    processedAt?: DateTimeFilter<"BillingProcessedMessage"> | Date | string
  }

  export type BillingProcessedMessageOrderByWithRelationInput = {
    dedupKey?: SortOrder
    routingKey?: SortOrder
    processedAt?: SortOrder
  }

  export type BillingProcessedMessageWhereUniqueInput = Prisma.AtLeast<{
    dedupKey?: string
    AND?: BillingProcessedMessageWhereInput | BillingProcessedMessageWhereInput[]
    OR?: BillingProcessedMessageWhereInput[]
    NOT?: BillingProcessedMessageWhereInput | BillingProcessedMessageWhereInput[]
    routingKey?: StringFilter<"BillingProcessedMessage"> | string
    processedAt?: DateTimeFilter<"BillingProcessedMessage"> | Date | string
  }, "dedupKey">

  export type BillingProcessedMessageOrderByWithAggregationInput = {
    dedupKey?: SortOrder
    routingKey?: SortOrder
    processedAt?: SortOrder
    _count?: BillingProcessedMessageCountOrderByAggregateInput
    _max?: BillingProcessedMessageMaxOrderByAggregateInput
    _min?: BillingProcessedMessageMinOrderByAggregateInput
  }

  export type BillingProcessedMessageScalarWhereWithAggregatesInput = {
    AND?: BillingProcessedMessageScalarWhereWithAggregatesInput | BillingProcessedMessageScalarWhereWithAggregatesInput[]
    OR?: BillingProcessedMessageScalarWhereWithAggregatesInput[]
    NOT?: BillingProcessedMessageScalarWhereWithAggregatesInput | BillingProcessedMessageScalarWhereWithAggregatesInput[]
    dedupKey?: StringWithAggregatesFilter<"BillingProcessedMessage"> | string
    routingKey?: StringWithAggregatesFilter<"BillingProcessedMessage"> | string
    processedAt?: DateTimeWithAggregatesFilter<"BillingProcessedMessage"> | Date | string
  }

  export type BillingEventOutboxWhereInput = {
    AND?: BillingEventOutboxWhereInput | BillingEventOutboxWhereInput[]
    OR?: BillingEventOutboxWhereInput[]
    NOT?: BillingEventOutboxWhereInput | BillingEventOutboxWhereInput[]
    messageId?: StringFilter<"BillingEventOutbox"> | string
    routingKey?: StringFilter<"BillingEventOutbox"> | string
    projectId?: StringNullableFilter<"BillingEventOutbox"> | string | null
    status?: StringFilter<"BillingEventOutbox"> | string
    attempts?: IntFilter<"BillingEventOutbox"> | number
    envelope?: JsonFilter<"BillingEventOutbox">
    lastError?: StringNullableFilter<"BillingEventOutbox"> | string | null
    createdAt?: DateTimeFilter<"BillingEventOutbox"> | Date | string
    updatedAt?: DateTimeFilter<"BillingEventOutbox"> | Date | string
    publishedAt?: DateTimeNullableFilter<"BillingEventOutbox"> | Date | string | null
  }

  export type BillingEventOutboxOrderByWithRelationInput = {
    messageId?: SortOrder
    routingKey?: SortOrder
    projectId?: SortOrderInput | SortOrder
    status?: SortOrder
    attempts?: SortOrder
    envelope?: SortOrder
    lastError?: SortOrderInput | SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    publishedAt?: SortOrderInput | SortOrder
  }

  export type BillingEventOutboxWhereUniqueInput = Prisma.AtLeast<{
    messageId?: string
    AND?: BillingEventOutboxWhereInput | BillingEventOutboxWhereInput[]
    OR?: BillingEventOutboxWhereInput[]
    NOT?: BillingEventOutboxWhereInput | BillingEventOutboxWhereInput[]
    routingKey?: StringFilter<"BillingEventOutbox"> | string
    projectId?: StringNullableFilter<"BillingEventOutbox"> | string | null
    status?: StringFilter<"BillingEventOutbox"> | string
    attempts?: IntFilter<"BillingEventOutbox"> | number
    envelope?: JsonFilter<"BillingEventOutbox">
    lastError?: StringNullableFilter<"BillingEventOutbox"> | string | null
    createdAt?: DateTimeFilter<"BillingEventOutbox"> | Date | string
    updatedAt?: DateTimeFilter<"BillingEventOutbox"> | Date | string
    publishedAt?: DateTimeNullableFilter<"BillingEventOutbox"> | Date | string | null
  }, "messageId">

  export type BillingEventOutboxOrderByWithAggregationInput = {
    messageId?: SortOrder
    routingKey?: SortOrder
    projectId?: SortOrderInput | SortOrder
    status?: SortOrder
    attempts?: SortOrder
    envelope?: SortOrder
    lastError?: SortOrderInput | SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    publishedAt?: SortOrderInput | SortOrder
    _count?: BillingEventOutboxCountOrderByAggregateInput
    _avg?: BillingEventOutboxAvgOrderByAggregateInput
    _max?: BillingEventOutboxMaxOrderByAggregateInput
    _min?: BillingEventOutboxMinOrderByAggregateInput
    _sum?: BillingEventOutboxSumOrderByAggregateInput
  }

  export type BillingEventOutboxScalarWhereWithAggregatesInput = {
    AND?: BillingEventOutboxScalarWhereWithAggregatesInput | BillingEventOutboxScalarWhereWithAggregatesInput[]
    OR?: BillingEventOutboxScalarWhereWithAggregatesInput[]
    NOT?: BillingEventOutboxScalarWhereWithAggregatesInput | BillingEventOutboxScalarWhereWithAggregatesInput[]
    messageId?: StringWithAggregatesFilter<"BillingEventOutbox"> | string
    routingKey?: StringWithAggregatesFilter<"BillingEventOutbox"> | string
    projectId?: StringNullableWithAggregatesFilter<"BillingEventOutbox"> | string | null
    status?: StringWithAggregatesFilter<"BillingEventOutbox"> | string
    attempts?: IntWithAggregatesFilter<"BillingEventOutbox"> | number
    envelope?: JsonWithAggregatesFilter<"BillingEventOutbox">
    lastError?: StringNullableWithAggregatesFilter<"BillingEventOutbox"> | string | null
    createdAt?: DateTimeWithAggregatesFilter<"BillingEventOutbox"> | Date | string
    updatedAt?: DateTimeWithAggregatesFilter<"BillingEventOutbox"> | Date | string
    publishedAt?: DateTimeNullableWithAggregatesFilter<"BillingEventOutbox"> | Date | string | null
  }

  export type BillingPlanCreateInput = {
    id: string
    code: string
    name: string
    description?: string | null
    priceMinor: bigint | number
    currency: string
    billingPeriod: string
    isActive?: boolean
    createdAt?: Date | string
    updatedAt?: Date | string
    quotas?: BillingPlanQuotaCreateNestedManyWithoutPlanInput
    subscriptions?: BillingSubscriptionCreateNestedManyWithoutPlanInput
  }

  export type BillingPlanUncheckedCreateInput = {
    id: string
    code: string
    name: string
    description?: string | null
    priceMinor: bigint | number
    currency: string
    billingPeriod: string
    isActive?: boolean
    createdAt?: Date | string
    updatedAt?: Date | string
    quotas?: BillingPlanQuotaUncheckedCreateNestedManyWithoutPlanInput
    subscriptions?: BillingSubscriptionUncheckedCreateNestedManyWithoutPlanInput
  }

  export type BillingPlanUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    code?: StringFieldUpdateOperationsInput | string
    name?: StringFieldUpdateOperationsInput | string
    description?: NullableStringFieldUpdateOperationsInput | string | null
    priceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    billingPeriod?: StringFieldUpdateOperationsInput | string
    isActive?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    quotas?: BillingPlanQuotaUpdateManyWithoutPlanNestedInput
    subscriptions?: BillingSubscriptionUpdateManyWithoutPlanNestedInput
  }

  export type BillingPlanUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    code?: StringFieldUpdateOperationsInput | string
    name?: StringFieldUpdateOperationsInput | string
    description?: NullableStringFieldUpdateOperationsInput | string | null
    priceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    billingPeriod?: StringFieldUpdateOperationsInput | string
    isActive?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    quotas?: BillingPlanQuotaUncheckedUpdateManyWithoutPlanNestedInput
    subscriptions?: BillingSubscriptionUncheckedUpdateManyWithoutPlanNestedInput
  }

  export type BillingPlanCreateManyInput = {
    id: string
    code: string
    name: string
    description?: string | null
    priceMinor: bigint | number
    currency: string
    billingPeriod: string
    isActive?: boolean
    createdAt?: Date | string
    updatedAt?: Date | string
  }

  export type BillingPlanUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    code?: StringFieldUpdateOperationsInput | string
    name?: StringFieldUpdateOperationsInput | string
    description?: NullableStringFieldUpdateOperationsInput | string | null
    priceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    billingPeriod?: StringFieldUpdateOperationsInput | string
    isActive?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPlanUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    code?: StringFieldUpdateOperationsInput | string
    name?: StringFieldUpdateOperationsInput | string
    description?: NullableStringFieldUpdateOperationsInput | string | null
    priceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    billingPeriod?: StringFieldUpdateOperationsInput | string
    isActive?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPlanQuotaCreateInput = {
    id: string
    action: string
    limit: bigint | number
    createdAt?: Date | string
    plan: BillingPlanCreateNestedOneWithoutQuotasInput
  }

  export type BillingPlanQuotaUncheckedCreateInput = {
    id: string
    planId: string
    action: string
    limit: bigint | number
    createdAt?: Date | string
  }

  export type BillingPlanQuotaUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    limit?: BigIntFieldUpdateOperationsInput | bigint | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    plan?: BillingPlanUpdateOneRequiredWithoutQuotasNestedInput
  }

  export type BillingPlanQuotaUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    planId?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    limit?: BigIntFieldUpdateOperationsInput | bigint | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPlanQuotaCreateManyInput = {
    id: string
    planId: string
    action: string
    limit: bigint | number
    createdAt?: Date | string
  }

  export type BillingPlanQuotaUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    limit?: BigIntFieldUpdateOperationsInput | bigint | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPlanQuotaUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    planId?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    limit?: BigIntFieldUpdateOperationsInput | bigint | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingSubscriptionCreateInput = {
    id: string
    projectId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
    plan: BillingPlanCreateNestedOneWithoutSubscriptionsInput
    payments?: BillingPaymentCreateNestedManyWithoutSubscriptionInput
    invoices?: BillingInvoiceCreateNestedManyWithoutSubscriptionInput
  }

  export type BillingSubscriptionUncheckedCreateInput = {
    id: string
    projectId: string
    planId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
    payments?: BillingPaymentUncheckedCreateNestedManyWithoutSubscriptionInput
    invoices?: BillingInvoiceUncheckedCreateNestedManyWithoutSubscriptionInput
  }

  export type BillingSubscriptionUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    plan?: BillingPlanUpdateOneRequiredWithoutSubscriptionsNestedInput
    payments?: BillingPaymentUpdateManyWithoutSubscriptionNestedInput
    invoices?: BillingInvoiceUpdateManyWithoutSubscriptionNestedInput
  }

  export type BillingSubscriptionUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    planId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    payments?: BillingPaymentUncheckedUpdateManyWithoutSubscriptionNestedInput
    invoices?: BillingInvoiceUncheckedUpdateManyWithoutSubscriptionNestedInput
  }

  export type BillingSubscriptionCreateManyInput = {
    id: string
    projectId: string
    planId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
  }

  export type BillingSubscriptionUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingSubscriptionUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    planId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPaymentCreateInput = {
    id: string
    projectId: string
    amountMinor: bigint | number
    currency: string
    status: string
    provider: string
    providerPaymentId?: string | null
    paidAt?: Date | string | null
    createdAt?: Date | string
    subscription: BillingSubscriptionCreateNestedOneWithoutPaymentsInput
  }

  export type BillingPaymentUncheckedCreateInput = {
    id: string
    projectId: string
    subscriptionId: string
    amountMinor: bigint | number
    currency: string
    status: string
    provider: string
    providerPaymentId?: string | null
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingPaymentUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    provider?: StringFieldUpdateOperationsInput | string
    providerPaymentId?: NullableStringFieldUpdateOperationsInput | string | null
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    subscription?: BillingSubscriptionUpdateOneRequiredWithoutPaymentsNestedInput
  }

  export type BillingPaymentUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    subscriptionId?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    provider?: StringFieldUpdateOperationsInput | string
    providerPaymentId?: NullableStringFieldUpdateOperationsInput | string | null
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPaymentCreateManyInput = {
    id: string
    projectId: string
    subscriptionId: string
    amountMinor: bigint | number
    currency: string
    status: string
    provider: string
    providerPaymentId?: string | null
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingPaymentUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    provider?: StringFieldUpdateOperationsInput | string
    providerPaymentId?: NullableStringFieldUpdateOperationsInput | string | null
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPaymentUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    subscriptionId?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    provider?: StringFieldUpdateOperationsInput | string
    providerPaymentId?: NullableStringFieldUpdateOperationsInput | string | null
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingInvoiceCreateInput = {
    id: string
    projectId: string
    number: string
    amountMinor: bigint | number
    currency: string
    status: string
    issuedAt: Date | string
    dueAt: Date | string
    paidAt?: Date | string | null
    createdAt?: Date | string
    subscription: BillingSubscriptionCreateNestedOneWithoutInvoicesInput
  }

  export type BillingInvoiceUncheckedCreateInput = {
    id: string
    projectId: string
    subscriptionId: string
    number: string
    amountMinor: bigint | number
    currency: string
    status: string
    issuedAt: Date | string
    dueAt: Date | string
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingInvoiceUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    issuedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    dueAt?: DateTimeFieldUpdateOperationsInput | Date | string
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    subscription?: BillingSubscriptionUpdateOneRequiredWithoutInvoicesNestedInput
  }

  export type BillingInvoiceUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    subscriptionId?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    issuedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    dueAt?: DateTimeFieldUpdateOperationsInput | Date | string
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingInvoiceCreateManyInput = {
    id: string
    projectId: string
    subscriptionId: string
    number: string
    amountMinor: bigint | number
    currency: string
    status: string
    issuedAt: Date | string
    dueAt: Date | string
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingInvoiceUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    issuedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    dueAt?: DateTimeFieldUpdateOperationsInput | Date | string
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingInvoiceUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    subscriptionId?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    issuedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    dueAt?: DateTimeFieldUpdateOperationsInput | Date | string
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingQuotaUsageCreateInput = {
    id: string
    projectId: string
    action: string
    periodKey: string
    used?: bigint | number
    updatedAt?: Date | string
    createdAt?: Date | string
  }

  export type BillingQuotaUsageUncheckedCreateInput = {
    id: string
    projectId: string
    action: string
    periodKey: string
    used?: bigint | number
    updatedAt?: Date | string
    createdAt?: Date | string
  }

  export type BillingQuotaUsageUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    periodKey?: StringFieldUpdateOperationsInput | string
    used?: BigIntFieldUpdateOperationsInput | bigint | number
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingQuotaUsageUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    periodKey?: StringFieldUpdateOperationsInput | string
    used?: BigIntFieldUpdateOperationsInput | bigint | number
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingQuotaUsageCreateManyInput = {
    id: string
    projectId: string
    action: string
    periodKey: string
    used?: bigint | number
    updatedAt?: Date | string
    createdAt?: Date | string
  }

  export type BillingQuotaUsageUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    periodKey?: StringFieldUpdateOperationsInput | string
    used?: BigIntFieldUpdateOperationsInput | bigint | number
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingQuotaUsageUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    periodKey?: StringFieldUpdateOperationsInput | string
    used?: BigIntFieldUpdateOperationsInput | bigint | number
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ModuleSubscriptionCreateInput = {
    id: string
    projectId: string
    moduleId: string
    priceModel?: string
    unitPriceMinor?: bigint | number
    currency?: string
    state?: string
    revenueShareBps?: number
    partnerId?: string | null
    trialEndsAt?: Date | string | null
    gracePeriodEnd?: Date | string | null
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
  }

  export type ModuleSubscriptionUncheckedCreateInput = {
    id: string
    projectId: string
    moduleId: string
    priceModel?: string
    unitPriceMinor?: bigint | number
    currency?: string
    state?: string
    revenueShareBps?: number
    partnerId?: string | null
    trialEndsAt?: Date | string | null
    gracePeriodEnd?: Date | string | null
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
  }

  export type ModuleSubscriptionUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    moduleId?: StringFieldUpdateOperationsInput | string
    priceModel?: StringFieldUpdateOperationsInput | string
    unitPriceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    state?: StringFieldUpdateOperationsInput | string
    revenueShareBps?: IntFieldUpdateOperationsInput | number
    partnerId?: NullableStringFieldUpdateOperationsInput | string | null
    trialEndsAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    gracePeriodEnd?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ModuleSubscriptionUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    moduleId?: StringFieldUpdateOperationsInput | string
    priceModel?: StringFieldUpdateOperationsInput | string
    unitPriceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    state?: StringFieldUpdateOperationsInput | string
    revenueShareBps?: IntFieldUpdateOperationsInput | number
    partnerId?: NullableStringFieldUpdateOperationsInput | string | null
    trialEndsAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    gracePeriodEnd?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ModuleSubscriptionCreateManyInput = {
    id: string
    projectId: string
    moduleId: string
    priceModel?: string
    unitPriceMinor?: bigint | number
    currency?: string
    state?: string
    revenueShareBps?: number
    partnerId?: string | null
    trialEndsAt?: Date | string | null
    gracePeriodEnd?: Date | string | null
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
  }

  export type ModuleSubscriptionUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    moduleId?: StringFieldUpdateOperationsInput | string
    priceModel?: StringFieldUpdateOperationsInput | string
    unitPriceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    state?: StringFieldUpdateOperationsInput | string
    revenueShareBps?: IntFieldUpdateOperationsInput | number
    partnerId?: NullableStringFieldUpdateOperationsInput | string | null
    trialEndsAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    gracePeriodEnd?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type ModuleSubscriptionUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    moduleId?: StringFieldUpdateOperationsInput | string
    priceModel?: StringFieldUpdateOperationsInput | string
    unitPriceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    state?: StringFieldUpdateOperationsInput | string
    revenueShareBps?: IntFieldUpdateOperationsInput | number
    partnerId?: NullableStringFieldUpdateOperationsInput | string | null
    trialEndsAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    gracePeriodEnd?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type AccountStateChangeCreateInput = {
    id: string
    projectId: string
    scope?: string
    moduleId?: string | null
    fromState: string
    toState: string
    reason: string
    occurredAt?: Date | string
  }

  export type AccountStateChangeUncheckedCreateInput = {
    id: string
    projectId: string
    scope?: string
    moduleId?: string | null
    fromState: string
    toState: string
    reason: string
    occurredAt?: Date | string
  }

  export type AccountStateChangeUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    scope?: StringFieldUpdateOperationsInput | string
    moduleId?: NullableStringFieldUpdateOperationsInput | string | null
    fromState?: StringFieldUpdateOperationsInput | string
    toState?: StringFieldUpdateOperationsInput | string
    reason?: StringFieldUpdateOperationsInput | string
    occurredAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type AccountStateChangeUncheckedUpdateInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    scope?: StringFieldUpdateOperationsInput | string
    moduleId?: NullableStringFieldUpdateOperationsInput | string | null
    fromState?: StringFieldUpdateOperationsInput | string
    toState?: StringFieldUpdateOperationsInput | string
    reason?: StringFieldUpdateOperationsInput | string
    occurredAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type AccountStateChangeCreateManyInput = {
    id: string
    projectId: string
    scope?: string
    moduleId?: string | null
    fromState: string
    toState: string
    reason: string
    occurredAt?: Date | string
  }

  export type AccountStateChangeUpdateManyMutationInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    scope?: StringFieldUpdateOperationsInput | string
    moduleId?: NullableStringFieldUpdateOperationsInput | string | null
    fromState?: StringFieldUpdateOperationsInput | string
    toState?: StringFieldUpdateOperationsInput | string
    reason?: StringFieldUpdateOperationsInput | string
    occurredAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type AccountStateChangeUncheckedUpdateManyInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    scope?: StringFieldUpdateOperationsInput | string
    moduleId?: NullableStringFieldUpdateOperationsInput | string | null
    fromState?: StringFieldUpdateOperationsInput | string
    toState?: StringFieldUpdateOperationsInput | string
    reason?: StringFieldUpdateOperationsInput | string
    occurredAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingProcessedMessageCreateInput = {
    dedupKey: string
    routingKey: string
    processedAt?: Date | string
  }

  export type BillingProcessedMessageUncheckedCreateInput = {
    dedupKey: string
    routingKey: string
    processedAt?: Date | string
  }

  export type BillingProcessedMessageUpdateInput = {
    dedupKey?: StringFieldUpdateOperationsInput | string
    routingKey?: StringFieldUpdateOperationsInput | string
    processedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingProcessedMessageUncheckedUpdateInput = {
    dedupKey?: StringFieldUpdateOperationsInput | string
    routingKey?: StringFieldUpdateOperationsInput | string
    processedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingProcessedMessageCreateManyInput = {
    dedupKey: string
    routingKey: string
    processedAt?: Date | string
  }

  export type BillingProcessedMessageUpdateManyMutationInput = {
    dedupKey?: StringFieldUpdateOperationsInput | string
    routingKey?: StringFieldUpdateOperationsInput | string
    processedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingProcessedMessageUncheckedUpdateManyInput = {
    dedupKey?: StringFieldUpdateOperationsInput | string
    routingKey?: StringFieldUpdateOperationsInput | string
    processedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingEventOutboxCreateInput = {
    messageId: string
    routingKey: string
    projectId?: string | null
    status?: string
    attempts?: number
    envelope: JsonNullValueInput | InputJsonValue
    lastError?: string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    publishedAt?: Date | string | null
  }

  export type BillingEventOutboxUncheckedCreateInput = {
    messageId: string
    routingKey: string
    projectId?: string | null
    status?: string
    attempts?: number
    envelope: JsonNullValueInput | InputJsonValue
    lastError?: string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    publishedAt?: Date | string | null
  }

  export type BillingEventOutboxUpdateInput = {
    messageId?: StringFieldUpdateOperationsInput | string
    routingKey?: StringFieldUpdateOperationsInput | string
    projectId?: NullableStringFieldUpdateOperationsInput | string | null
    status?: StringFieldUpdateOperationsInput | string
    attempts?: IntFieldUpdateOperationsInput | number
    envelope?: JsonNullValueInput | InputJsonValue
    lastError?: NullableStringFieldUpdateOperationsInput | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    publishedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
  }

  export type BillingEventOutboxUncheckedUpdateInput = {
    messageId?: StringFieldUpdateOperationsInput | string
    routingKey?: StringFieldUpdateOperationsInput | string
    projectId?: NullableStringFieldUpdateOperationsInput | string | null
    status?: StringFieldUpdateOperationsInput | string
    attempts?: IntFieldUpdateOperationsInput | number
    envelope?: JsonNullValueInput | InputJsonValue
    lastError?: NullableStringFieldUpdateOperationsInput | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    publishedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
  }

  export type BillingEventOutboxCreateManyInput = {
    messageId: string
    routingKey: string
    projectId?: string | null
    status?: string
    attempts?: number
    envelope: JsonNullValueInput | InputJsonValue
    lastError?: string | null
    createdAt?: Date | string
    updatedAt?: Date | string
    publishedAt?: Date | string | null
  }

  export type BillingEventOutboxUpdateManyMutationInput = {
    messageId?: StringFieldUpdateOperationsInput | string
    routingKey?: StringFieldUpdateOperationsInput | string
    projectId?: NullableStringFieldUpdateOperationsInput | string | null
    status?: StringFieldUpdateOperationsInput | string
    attempts?: IntFieldUpdateOperationsInput | number
    envelope?: JsonNullValueInput | InputJsonValue
    lastError?: NullableStringFieldUpdateOperationsInput | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    publishedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
  }

  export type BillingEventOutboxUncheckedUpdateManyInput = {
    messageId?: StringFieldUpdateOperationsInput | string
    routingKey?: StringFieldUpdateOperationsInput | string
    projectId?: NullableStringFieldUpdateOperationsInput | string | null
    status?: StringFieldUpdateOperationsInput | string
    attempts?: IntFieldUpdateOperationsInput | number
    envelope?: JsonNullValueInput | InputJsonValue
    lastError?: NullableStringFieldUpdateOperationsInput | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    publishedAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
  }

  export type StringFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringFilter<$PrismaModel> | string
  }

  export type StringNullableFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel> | null
    in?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringNullableFilter<$PrismaModel> | string | null
  }

  export type BigIntFilter<$PrismaModel = never> = {
    equals?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    in?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>
    notIn?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>
    lt?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    lte?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    gt?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    gte?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    not?: NestedBigIntFilter<$PrismaModel> | bigint | number
  }

  export type BoolFilter<$PrismaModel = never> = {
    equals?: boolean | BooleanFieldRefInput<$PrismaModel>
    not?: NestedBoolFilter<$PrismaModel> | boolean
  }

  export type DateTimeFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeFilter<$PrismaModel> | Date | string
  }

  export type BillingPlanQuotaListRelationFilter = {
    every?: BillingPlanQuotaWhereInput
    some?: BillingPlanQuotaWhereInput
    none?: BillingPlanQuotaWhereInput
  }

  export type BillingSubscriptionListRelationFilter = {
    every?: BillingSubscriptionWhereInput
    some?: BillingSubscriptionWhereInput
    none?: BillingSubscriptionWhereInput
  }

  export type SortOrderInput = {
    sort: SortOrder
    nulls?: NullsOrder
  }

  export type BillingPlanQuotaOrderByRelationAggregateInput = {
    _count?: SortOrder
  }

  export type BillingSubscriptionOrderByRelationAggregateInput = {
    _count?: SortOrder
  }

  export type BillingPlanCountOrderByAggregateInput = {
    id?: SortOrder
    code?: SortOrder
    name?: SortOrder
    description?: SortOrder
    priceMinor?: SortOrder
    currency?: SortOrder
    billingPeriod?: SortOrder
    isActive?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type BillingPlanAvgOrderByAggregateInput = {
    priceMinor?: SortOrder
  }

  export type BillingPlanMaxOrderByAggregateInput = {
    id?: SortOrder
    code?: SortOrder
    name?: SortOrder
    description?: SortOrder
    priceMinor?: SortOrder
    currency?: SortOrder
    billingPeriod?: SortOrder
    isActive?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type BillingPlanMinOrderByAggregateInput = {
    id?: SortOrder
    code?: SortOrder
    name?: SortOrder
    description?: SortOrder
    priceMinor?: SortOrder
    currency?: SortOrder
    billingPeriod?: SortOrder
    isActive?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type BillingPlanSumOrderByAggregateInput = {
    priceMinor?: SortOrder
  }

  export type StringWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringWithAggregatesFilter<$PrismaModel> | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedStringFilter<$PrismaModel>
    _max?: NestedStringFilter<$PrismaModel>
  }

  export type StringNullableWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel> | null
    in?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringNullableWithAggregatesFilter<$PrismaModel> | string | null
    _count?: NestedIntNullableFilter<$PrismaModel>
    _min?: NestedStringNullableFilter<$PrismaModel>
    _max?: NestedStringNullableFilter<$PrismaModel>
  }

  export type BigIntWithAggregatesFilter<$PrismaModel = never> = {
    equals?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    in?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>
    notIn?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>
    lt?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    lte?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    gt?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    gte?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    not?: NestedBigIntWithAggregatesFilter<$PrismaModel> | bigint | number
    _count?: NestedIntFilter<$PrismaModel>
    _avg?: NestedFloatFilter<$PrismaModel>
    _sum?: NestedBigIntFilter<$PrismaModel>
    _min?: NestedBigIntFilter<$PrismaModel>
    _max?: NestedBigIntFilter<$PrismaModel>
  }

  export type BoolWithAggregatesFilter<$PrismaModel = never> = {
    equals?: boolean | BooleanFieldRefInput<$PrismaModel>
    not?: NestedBoolWithAggregatesFilter<$PrismaModel> | boolean
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedBoolFilter<$PrismaModel>
    _max?: NestedBoolFilter<$PrismaModel>
  }

  export type DateTimeWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeWithAggregatesFilter<$PrismaModel> | Date | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedDateTimeFilter<$PrismaModel>
    _max?: NestedDateTimeFilter<$PrismaModel>
  }

  export type BillingPlanScalarRelationFilter = {
    is?: BillingPlanWhereInput
    isNot?: BillingPlanWhereInput
  }

  export type BillingPlanQuotaPlanIdActionCompoundUniqueInput = {
    planId: string
    action: string
  }

  export type BillingPlanQuotaCountOrderByAggregateInput = {
    id?: SortOrder
    planId?: SortOrder
    action?: SortOrder
    limit?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingPlanQuotaAvgOrderByAggregateInput = {
    limit?: SortOrder
  }

  export type BillingPlanQuotaMaxOrderByAggregateInput = {
    id?: SortOrder
    planId?: SortOrder
    action?: SortOrder
    limit?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingPlanQuotaMinOrderByAggregateInput = {
    id?: SortOrder
    planId?: SortOrder
    action?: SortOrder
    limit?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingPlanQuotaSumOrderByAggregateInput = {
    limit?: SortOrder
  }

  export type BillingPaymentListRelationFilter = {
    every?: BillingPaymentWhereInput
    some?: BillingPaymentWhereInput
    none?: BillingPaymentWhereInput
  }

  export type BillingInvoiceListRelationFilter = {
    every?: BillingInvoiceWhereInput
    some?: BillingInvoiceWhereInput
    none?: BillingInvoiceWhereInput
  }

  export type BillingPaymentOrderByRelationAggregateInput = {
    _count?: SortOrder
  }

  export type BillingInvoiceOrderByRelationAggregateInput = {
    _count?: SortOrder
  }

  export type BillingSubscriptionCountOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    planId?: SortOrder
    status?: SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type BillingSubscriptionMaxOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    planId?: SortOrder
    status?: SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type BillingSubscriptionMinOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    planId?: SortOrder
    status?: SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type DateTimeNullableFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel> | null
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeNullableFilter<$PrismaModel> | Date | string | null
  }

  export type BillingSubscriptionScalarRelationFilter = {
    is?: BillingSubscriptionWhereInput
    isNot?: BillingSubscriptionWhereInput
  }

  export type BillingPaymentCountOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    provider?: SortOrder
    providerPaymentId?: SortOrder
    paidAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingPaymentAvgOrderByAggregateInput = {
    amountMinor?: SortOrder
  }

  export type BillingPaymentMaxOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    provider?: SortOrder
    providerPaymentId?: SortOrder
    paidAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingPaymentMinOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    provider?: SortOrder
    providerPaymentId?: SortOrder
    paidAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingPaymentSumOrderByAggregateInput = {
    amountMinor?: SortOrder
  }

  export type DateTimeNullableWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel> | null
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeNullableWithAggregatesFilter<$PrismaModel> | Date | string | null
    _count?: NestedIntNullableFilter<$PrismaModel>
    _min?: NestedDateTimeNullableFilter<$PrismaModel>
    _max?: NestedDateTimeNullableFilter<$PrismaModel>
  }

  export type BillingInvoiceProjectIdNumberCompoundUniqueInput = {
    projectId: string
    number: string
  }

  export type BillingInvoiceCountOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    number?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    issuedAt?: SortOrder
    dueAt?: SortOrder
    paidAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingInvoiceAvgOrderByAggregateInput = {
    amountMinor?: SortOrder
  }

  export type BillingInvoiceMaxOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    number?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    issuedAt?: SortOrder
    dueAt?: SortOrder
    paidAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingInvoiceMinOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    subscriptionId?: SortOrder
    number?: SortOrder
    amountMinor?: SortOrder
    currency?: SortOrder
    status?: SortOrder
    issuedAt?: SortOrder
    dueAt?: SortOrder
    paidAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingInvoiceSumOrderByAggregateInput = {
    amountMinor?: SortOrder
  }

  export type BillingQuotaUsageProjectIdActionPeriodKeyCompoundUniqueInput = {
    projectId: string
    action: string
    periodKey: string
  }

  export type BillingQuotaUsageCountOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    action?: SortOrder
    periodKey?: SortOrder
    used?: SortOrder
    updatedAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingQuotaUsageAvgOrderByAggregateInput = {
    used?: SortOrder
  }

  export type BillingQuotaUsageMaxOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    action?: SortOrder
    periodKey?: SortOrder
    used?: SortOrder
    updatedAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingQuotaUsageMinOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    action?: SortOrder
    periodKey?: SortOrder
    used?: SortOrder
    updatedAt?: SortOrder
    createdAt?: SortOrder
  }

  export type BillingQuotaUsageSumOrderByAggregateInput = {
    used?: SortOrder
  }

  export type IntFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntFilter<$PrismaModel> | number
  }

  export type ModuleSubscriptionProjectIdModuleIdCompoundUniqueInput = {
    projectId: string
    moduleId: string
  }

  export type ModuleSubscriptionCountOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    moduleId?: SortOrder
    priceModel?: SortOrder
    unitPriceMinor?: SortOrder
    currency?: SortOrder
    state?: SortOrder
    revenueShareBps?: SortOrder
    partnerId?: SortOrder
    trialEndsAt?: SortOrder
    gracePeriodEnd?: SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type ModuleSubscriptionAvgOrderByAggregateInput = {
    unitPriceMinor?: SortOrder
    revenueShareBps?: SortOrder
  }

  export type ModuleSubscriptionMaxOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    moduleId?: SortOrder
    priceModel?: SortOrder
    unitPriceMinor?: SortOrder
    currency?: SortOrder
    state?: SortOrder
    revenueShareBps?: SortOrder
    partnerId?: SortOrder
    trialEndsAt?: SortOrder
    gracePeriodEnd?: SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type ModuleSubscriptionMinOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    moduleId?: SortOrder
    priceModel?: SortOrder
    unitPriceMinor?: SortOrder
    currency?: SortOrder
    state?: SortOrder
    revenueShareBps?: SortOrder
    partnerId?: SortOrder
    trialEndsAt?: SortOrder
    gracePeriodEnd?: SortOrder
    currentPeriodStart?: SortOrder
    currentPeriodEnd?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
  }

  export type ModuleSubscriptionSumOrderByAggregateInput = {
    unitPriceMinor?: SortOrder
    revenueShareBps?: SortOrder
  }

  export type IntWithAggregatesFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntWithAggregatesFilter<$PrismaModel> | number
    _count?: NestedIntFilter<$PrismaModel>
    _avg?: NestedFloatFilter<$PrismaModel>
    _sum?: NestedIntFilter<$PrismaModel>
    _min?: NestedIntFilter<$PrismaModel>
    _max?: NestedIntFilter<$PrismaModel>
  }

  export type AccountStateChangeCountOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    scope?: SortOrder
    moduleId?: SortOrder
    fromState?: SortOrder
    toState?: SortOrder
    reason?: SortOrder
    occurredAt?: SortOrder
  }

  export type AccountStateChangeMaxOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    scope?: SortOrder
    moduleId?: SortOrder
    fromState?: SortOrder
    toState?: SortOrder
    reason?: SortOrder
    occurredAt?: SortOrder
  }

  export type AccountStateChangeMinOrderByAggregateInput = {
    id?: SortOrder
    projectId?: SortOrder
    scope?: SortOrder
    moduleId?: SortOrder
    fromState?: SortOrder
    toState?: SortOrder
    reason?: SortOrder
    occurredAt?: SortOrder
  }

  export type BillingProcessedMessageCountOrderByAggregateInput = {
    dedupKey?: SortOrder
    routingKey?: SortOrder
    processedAt?: SortOrder
  }

  export type BillingProcessedMessageMaxOrderByAggregateInput = {
    dedupKey?: SortOrder
    routingKey?: SortOrder
    processedAt?: SortOrder
  }

  export type BillingProcessedMessageMinOrderByAggregateInput = {
    dedupKey?: SortOrder
    routingKey?: SortOrder
    processedAt?: SortOrder
  }
  export type JsonFilter<$PrismaModel = never> =
    | PatchUndefined<
        Either<Required<JsonFilterBase<$PrismaModel>>, Exclude<keyof Required<JsonFilterBase<$PrismaModel>>, 'path'>>,
        Required<JsonFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<JsonFilterBase<$PrismaModel>>, 'path'>>

  export type JsonFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    mode?: QueryMode | EnumQueryModeFieldRefInput<$PrismaModel>
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
  }

  export type BillingEventOutboxCountOrderByAggregateInput = {
    messageId?: SortOrder
    routingKey?: SortOrder
    projectId?: SortOrder
    status?: SortOrder
    attempts?: SortOrder
    envelope?: SortOrder
    lastError?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    publishedAt?: SortOrder
  }

  export type BillingEventOutboxAvgOrderByAggregateInput = {
    attempts?: SortOrder
  }

  export type BillingEventOutboxMaxOrderByAggregateInput = {
    messageId?: SortOrder
    routingKey?: SortOrder
    projectId?: SortOrder
    status?: SortOrder
    attempts?: SortOrder
    lastError?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    publishedAt?: SortOrder
  }

  export type BillingEventOutboxMinOrderByAggregateInput = {
    messageId?: SortOrder
    routingKey?: SortOrder
    projectId?: SortOrder
    status?: SortOrder
    attempts?: SortOrder
    lastError?: SortOrder
    createdAt?: SortOrder
    updatedAt?: SortOrder
    publishedAt?: SortOrder
  }

  export type BillingEventOutboxSumOrderByAggregateInput = {
    attempts?: SortOrder
  }
  export type JsonWithAggregatesFilter<$PrismaModel = never> =
    | PatchUndefined<
        Either<Required<JsonWithAggregatesFilterBase<$PrismaModel>>, Exclude<keyof Required<JsonWithAggregatesFilterBase<$PrismaModel>>, 'path'>>,
        Required<JsonWithAggregatesFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<JsonWithAggregatesFilterBase<$PrismaModel>>, 'path'>>

  export type JsonWithAggregatesFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    mode?: QueryMode | EnumQueryModeFieldRefInput<$PrismaModel>
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedJsonFilter<$PrismaModel>
    _max?: NestedJsonFilter<$PrismaModel>
  }

  export type BillingPlanQuotaCreateNestedManyWithoutPlanInput = {
    create?: XOR<BillingPlanQuotaCreateWithoutPlanInput, BillingPlanQuotaUncheckedCreateWithoutPlanInput> | BillingPlanQuotaCreateWithoutPlanInput[] | BillingPlanQuotaUncheckedCreateWithoutPlanInput[]
    connectOrCreate?: BillingPlanQuotaCreateOrConnectWithoutPlanInput | BillingPlanQuotaCreateOrConnectWithoutPlanInput[]
    createMany?: BillingPlanQuotaCreateManyPlanInputEnvelope
    connect?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
  }

  export type BillingSubscriptionCreateNestedManyWithoutPlanInput = {
    create?: XOR<BillingSubscriptionCreateWithoutPlanInput, BillingSubscriptionUncheckedCreateWithoutPlanInput> | BillingSubscriptionCreateWithoutPlanInput[] | BillingSubscriptionUncheckedCreateWithoutPlanInput[]
    connectOrCreate?: BillingSubscriptionCreateOrConnectWithoutPlanInput | BillingSubscriptionCreateOrConnectWithoutPlanInput[]
    createMany?: BillingSubscriptionCreateManyPlanInputEnvelope
    connect?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
  }

  export type BillingPlanQuotaUncheckedCreateNestedManyWithoutPlanInput = {
    create?: XOR<BillingPlanQuotaCreateWithoutPlanInput, BillingPlanQuotaUncheckedCreateWithoutPlanInput> | BillingPlanQuotaCreateWithoutPlanInput[] | BillingPlanQuotaUncheckedCreateWithoutPlanInput[]
    connectOrCreate?: BillingPlanQuotaCreateOrConnectWithoutPlanInput | BillingPlanQuotaCreateOrConnectWithoutPlanInput[]
    createMany?: BillingPlanQuotaCreateManyPlanInputEnvelope
    connect?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
  }

  export type BillingSubscriptionUncheckedCreateNestedManyWithoutPlanInput = {
    create?: XOR<BillingSubscriptionCreateWithoutPlanInput, BillingSubscriptionUncheckedCreateWithoutPlanInput> | BillingSubscriptionCreateWithoutPlanInput[] | BillingSubscriptionUncheckedCreateWithoutPlanInput[]
    connectOrCreate?: BillingSubscriptionCreateOrConnectWithoutPlanInput | BillingSubscriptionCreateOrConnectWithoutPlanInput[]
    createMany?: BillingSubscriptionCreateManyPlanInputEnvelope
    connect?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
  }

  export type StringFieldUpdateOperationsInput = {
    set?: string
  }

  export type NullableStringFieldUpdateOperationsInput = {
    set?: string | null
  }

  export type BigIntFieldUpdateOperationsInput = {
    set?: bigint | number
    increment?: bigint | number
    decrement?: bigint | number
    multiply?: bigint | number
    divide?: bigint | number
  }

  export type BoolFieldUpdateOperationsInput = {
    set?: boolean
  }

  export type DateTimeFieldUpdateOperationsInput = {
    set?: Date | string
  }

  export type BillingPlanQuotaUpdateManyWithoutPlanNestedInput = {
    create?: XOR<BillingPlanQuotaCreateWithoutPlanInput, BillingPlanQuotaUncheckedCreateWithoutPlanInput> | BillingPlanQuotaCreateWithoutPlanInput[] | BillingPlanQuotaUncheckedCreateWithoutPlanInput[]
    connectOrCreate?: BillingPlanQuotaCreateOrConnectWithoutPlanInput | BillingPlanQuotaCreateOrConnectWithoutPlanInput[]
    upsert?: BillingPlanQuotaUpsertWithWhereUniqueWithoutPlanInput | BillingPlanQuotaUpsertWithWhereUniqueWithoutPlanInput[]
    createMany?: BillingPlanQuotaCreateManyPlanInputEnvelope
    set?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
    disconnect?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
    delete?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
    connect?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
    update?: BillingPlanQuotaUpdateWithWhereUniqueWithoutPlanInput | BillingPlanQuotaUpdateWithWhereUniqueWithoutPlanInput[]
    updateMany?: BillingPlanQuotaUpdateManyWithWhereWithoutPlanInput | BillingPlanQuotaUpdateManyWithWhereWithoutPlanInput[]
    deleteMany?: BillingPlanQuotaScalarWhereInput | BillingPlanQuotaScalarWhereInput[]
  }

  export type BillingSubscriptionUpdateManyWithoutPlanNestedInput = {
    create?: XOR<BillingSubscriptionCreateWithoutPlanInput, BillingSubscriptionUncheckedCreateWithoutPlanInput> | BillingSubscriptionCreateWithoutPlanInput[] | BillingSubscriptionUncheckedCreateWithoutPlanInput[]
    connectOrCreate?: BillingSubscriptionCreateOrConnectWithoutPlanInput | BillingSubscriptionCreateOrConnectWithoutPlanInput[]
    upsert?: BillingSubscriptionUpsertWithWhereUniqueWithoutPlanInput | BillingSubscriptionUpsertWithWhereUniqueWithoutPlanInput[]
    createMany?: BillingSubscriptionCreateManyPlanInputEnvelope
    set?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
    disconnect?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
    delete?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
    connect?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
    update?: BillingSubscriptionUpdateWithWhereUniqueWithoutPlanInput | BillingSubscriptionUpdateWithWhereUniqueWithoutPlanInput[]
    updateMany?: BillingSubscriptionUpdateManyWithWhereWithoutPlanInput | BillingSubscriptionUpdateManyWithWhereWithoutPlanInput[]
    deleteMany?: BillingSubscriptionScalarWhereInput | BillingSubscriptionScalarWhereInput[]
  }

  export type BillingPlanQuotaUncheckedUpdateManyWithoutPlanNestedInput = {
    create?: XOR<BillingPlanQuotaCreateWithoutPlanInput, BillingPlanQuotaUncheckedCreateWithoutPlanInput> | BillingPlanQuotaCreateWithoutPlanInput[] | BillingPlanQuotaUncheckedCreateWithoutPlanInput[]
    connectOrCreate?: BillingPlanQuotaCreateOrConnectWithoutPlanInput | BillingPlanQuotaCreateOrConnectWithoutPlanInput[]
    upsert?: BillingPlanQuotaUpsertWithWhereUniqueWithoutPlanInput | BillingPlanQuotaUpsertWithWhereUniqueWithoutPlanInput[]
    createMany?: BillingPlanQuotaCreateManyPlanInputEnvelope
    set?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
    disconnect?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
    delete?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
    connect?: BillingPlanQuotaWhereUniqueInput | BillingPlanQuotaWhereUniqueInput[]
    update?: BillingPlanQuotaUpdateWithWhereUniqueWithoutPlanInput | BillingPlanQuotaUpdateWithWhereUniqueWithoutPlanInput[]
    updateMany?: BillingPlanQuotaUpdateManyWithWhereWithoutPlanInput | BillingPlanQuotaUpdateManyWithWhereWithoutPlanInput[]
    deleteMany?: BillingPlanQuotaScalarWhereInput | BillingPlanQuotaScalarWhereInput[]
  }

  export type BillingSubscriptionUncheckedUpdateManyWithoutPlanNestedInput = {
    create?: XOR<BillingSubscriptionCreateWithoutPlanInput, BillingSubscriptionUncheckedCreateWithoutPlanInput> | BillingSubscriptionCreateWithoutPlanInput[] | BillingSubscriptionUncheckedCreateWithoutPlanInput[]
    connectOrCreate?: BillingSubscriptionCreateOrConnectWithoutPlanInput | BillingSubscriptionCreateOrConnectWithoutPlanInput[]
    upsert?: BillingSubscriptionUpsertWithWhereUniqueWithoutPlanInput | BillingSubscriptionUpsertWithWhereUniqueWithoutPlanInput[]
    createMany?: BillingSubscriptionCreateManyPlanInputEnvelope
    set?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
    disconnect?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
    delete?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
    connect?: BillingSubscriptionWhereUniqueInput | BillingSubscriptionWhereUniqueInput[]
    update?: BillingSubscriptionUpdateWithWhereUniqueWithoutPlanInput | BillingSubscriptionUpdateWithWhereUniqueWithoutPlanInput[]
    updateMany?: BillingSubscriptionUpdateManyWithWhereWithoutPlanInput | BillingSubscriptionUpdateManyWithWhereWithoutPlanInput[]
    deleteMany?: BillingSubscriptionScalarWhereInput | BillingSubscriptionScalarWhereInput[]
  }

  export type BillingPlanCreateNestedOneWithoutQuotasInput = {
    create?: XOR<BillingPlanCreateWithoutQuotasInput, BillingPlanUncheckedCreateWithoutQuotasInput>
    connectOrCreate?: BillingPlanCreateOrConnectWithoutQuotasInput
    connect?: BillingPlanWhereUniqueInput
  }

  export type BillingPlanUpdateOneRequiredWithoutQuotasNestedInput = {
    create?: XOR<BillingPlanCreateWithoutQuotasInput, BillingPlanUncheckedCreateWithoutQuotasInput>
    connectOrCreate?: BillingPlanCreateOrConnectWithoutQuotasInput
    upsert?: BillingPlanUpsertWithoutQuotasInput
    connect?: BillingPlanWhereUniqueInput
    update?: XOR<XOR<BillingPlanUpdateToOneWithWhereWithoutQuotasInput, BillingPlanUpdateWithoutQuotasInput>, BillingPlanUncheckedUpdateWithoutQuotasInput>
  }

  export type BillingPlanCreateNestedOneWithoutSubscriptionsInput = {
    create?: XOR<BillingPlanCreateWithoutSubscriptionsInput, BillingPlanUncheckedCreateWithoutSubscriptionsInput>
    connectOrCreate?: BillingPlanCreateOrConnectWithoutSubscriptionsInput
    connect?: BillingPlanWhereUniqueInput
  }

  export type BillingPaymentCreateNestedManyWithoutSubscriptionInput = {
    create?: XOR<BillingPaymentCreateWithoutSubscriptionInput, BillingPaymentUncheckedCreateWithoutSubscriptionInput> | BillingPaymentCreateWithoutSubscriptionInput[] | BillingPaymentUncheckedCreateWithoutSubscriptionInput[]
    connectOrCreate?: BillingPaymentCreateOrConnectWithoutSubscriptionInput | BillingPaymentCreateOrConnectWithoutSubscriptionInput[]
    createMany?: BillingPaymentCreateManySubscriptionInputEnvelope
    connect?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
  }

  export type BillingInvoiceCreateNestedManyWithoutSubscriptionInput = {
    create?: XOR<BillingInvoiceCreateWithoutSubscriptionInput, BillingInvoiceUncheckedCreateWithoutSubscriptionInput> | BillingInvoiceCreateWithoutSubscriptionInput[] | BillingInvoiceUncheckedCreateWithoutSubscriptionInput[]
    connectOrCreate?: BillingInvoiceCreateOrConnectWithoutSubscriptionInput | BillingInvoiceCreateOrConnectWithoutSubscriptionInput[]
    createMany?: BillingInvoiceCreateManySubscriptionInputEnvelope
    connect?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
  }

  export type BillingPaymentUncheckedCreateNestedManyWithoutSubscriptionInput = {
    create?: XOR<BillingPaymentCreateWithoutSubscriptionInput, BillingPaymentUncheckedCreateWithoutSubscriptionInput> | BillingPaymentCreateWithoutSubscriptionInput[] | BillingPaymentUncheckedCreateWithoutSubscriptionInput[]
    connectOrCreate?: BillingPaymentCreateOrConnectWithoutSubscriptionInput | BillingPaymentCreateOrConnectWithoutSubscriptionInput[]
    createMany?: BillingPaymentCreateManySubscriptionInputEnvelope
    connect?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
  }

  export type BillingInvoiceUncheckedCreateNestedManyWithoutSubscriptionInput = {
    create?: XOR<BillingInvoiceCreateWithoutSubscriptionInput, BillingInvoiceUncheckedCreateWithoutSubscriptionInput> | BillingInvoiceCreateWithoutSubscriptionInput[] | BillingInvoiceUncheckedCreateWithoutSubscriptionInput[]
    connectOrCreate?: BillingInvoiceCreateOrConnectWithoutSubscriptionInput | BillingInvoiceCreateOrConnectWithoutSubscriptionInput[]
    createMany?: BillingInvoiceCreateManySubscriptionInputEnvelope
    connect?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
  }

  export type BillingPlanUpdateOneRequiredWithoutSubscriptionsNestedInput = {
    create?: XOR<BillingPlanCreateWithoutSubscriptionsInput, BillingPlanUncheckedCreateWithoutSubscriptionsInput>
    connectOrCreate?: BillingPlanCreateOrConnectWithoutSubscriptionsInput
    upsert?: BillingPlanUpsertWithoutSubscriptionsInput
    connect?: BillingPlanWhereUniqueInput
    update?: XOR<XOR<BillingPlanUpdateToOneWithWhereWithoutSubscriptionsInput, BillingPlanUpdateWithoutSubscriptionsInput>, BillingPlanUncheckedUpdateWithoutSubscriptionsInput>
  }

  export type BillingPaymentUpdateManyWithoutSubscriptionNestedInput = {
    create?: XOR<BillingPaymentCreateWithoutSubscriptionInput, BillingPaymentUncheckedCreateWithoutSubscriptionInput> | BillingPaymentCreateWithoutSubscriptionInput[] | BillingPaymentUncheckedCreateWithoutSubscriptionInput[]
    connectOrCreate?: BillingPaymentCreateOrConnectWithoutSubscriptionInput | BillingPaymentCreateOrConnectWithoutSubscriptionInput[]
    upsert?: BillingPaymentUpsertWithWhereUniqueWithoutSubscriptionInput | BillingPaymentUpsertWithWhereUniqueWithoutSubscriptionInput[]
    createMany?: BillingPaymentCreateManySubscriptionInputEnvelope
    set?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
    disconnect?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
    delete?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
    connect?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
    update?: BillingPaymentUpdateWithWhereUniqueWithoutSubscriptionInput | BillingPaymentUpdateWithWhereUniqueWithoutSubscriptionInput[]
    updateMany?: BillingPaymentUpdateManyWithWhereWithoutSubscriptionInput | BillingPaymentUpdateManyWithWhereWithoutSubscriptionInput[]
    deleteMany?: BillingPaymentScalarWhereInput | BillingPaymentScalarWhereInput[]
  }

  export type BillingInvoiceUpdateManyWithoutSubscriptionNestedInput = {
    create?: XOR<BillingInvoiceCreateWithoutSubscriptionInput, BillingInvoiceUncheckedCreateWithoutSubscriptionInput> | BillingInvoiceCreateWithoutSubscriptionInput[] | BillingInvoiceUncheckedCreateWithoutSubscriptionInput[]
    connectOrCreate?: BillingInvoiceCreateOrConnectWithoutSubscriptionInput | BillingInvoiceCreateOrConnectWithoutSubscriptionInput[]
    upsert?: BillingInvoiceUpsertWithWhereUniqueWithoutSubscriptionInput | BillingInvoiceUpsertWithWhereUniqueWithoutSubscriptionInput[]
    createMany?: BillingInvoiceCreateManySubscriptionInputEnvelope
    set?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
    disconnect?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
    delete?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
    connect?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
    update?: BillingInvoiceUpdateWithWhereUniqueWithoutSubscriptionInput | BillingInvoiceUpdateWithWhereUniqueWithoutSubscriptionInput[]
    updateMany?: BillingInvoiceUpdateManyWithWhereWithoutSubscriptionInput | BillingInvoiceUpdateManyWithWhereWithoutSubscriptionInput[]
    deleteMany?: BillingInvoiceScalarWhereInput | BillingInvoiceScalarWhereInput[]
  }

  export type BillingPaymentUncheckedUpdateManyWithoutSubscriptionNestedInput = {
    create?: XOR<BillingPaymentCreateWithoutSubscriptionInput, BillingPaymentUncheckedCreateWithoutSubscriptionInput> | BillingPaymentCreateWithoutSubscriptionInput[] | BillingPaymentUncheckedCreateWithoutSubscriptionInput[]
    connectOrCreate?: BillingPaymentCreateOrConnectWithoutSubscriptionInput | BillingPaymentCreateOrConnectWithoutSubscriptionInput[]
    upsert?: BillingPaymentUpsertWithWhereUniqueWithoutSubscriptionInput | BillingPaymentUpsertWithWhereUniqueWithoutSubscriptionInput[]
    createMany?: BillingPaymentCreateManySubscriptionInputEnvelope
    set?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
    disconnect?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
    delete?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
    connect?: BillingPaymentWhereUniqueInput | BillingPaymentWhereUniqueInput[]
    update?: BillingPaymentUpdateWithWhereUniqueWithoutSubscriptionInput | BillingPaymentUpdateWithWhereUniqueWithoutSubscriptionInput[]
    updateMany?: BillingPaymentUpdateManyWithWhereWithoutSubscriptionInput | BillingPaymentUpdateManyWithWhereWithoutSubscriptionInput[]
    deleteMany?: BillingPaymentScalarWhereInput | BillingPaymentScalarWhereInput[]
  }

  export type BillingInvoiceUncheckedUpdateManyWithoutSubscriptionNestedInput = {
    create?: XOR<BillingInvoiceCreateWithoutSubscriptionInput, BillingInvoiceUncheckedCreateWithoutSubscriptionInput> | BillingInvoiceCreateWithoutSubscriptionInput[] | BillingInvoiceUncheckedCreateWithoutSubscriptionInput[]
    connectOrCreate?: BillingInvoiceCreateOrConnectWithoutSubscriptionInput | BillingInvoiceCreateOrConnectWithoutSubscriptionInput[]
    upsert?: BillingInvoiceUpsertWithWhereUniqueWithoutSubscriptionInput | BillingInvoiceUpsertWithWhereUniqueWithoutSubscriptionInput[]
    createMany?: BillingInvoiceCreateManySubscriptionInputEnvelope
    set?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
    disconnect?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
    delete?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
    connect?: BillingInvoiceWhereUniqueInput | BillingInvoiceWhereUniqueInput[]
    update?: BillingInvoiceUpdateWithWhereUniqueWithoutSubscriptionInput | BillingInvoiceUpdateWithWhereUniqueWithoutSubscriptionInput[]
    updateMany?: BillingInvoiceUpdateManyWithWhereWithoutSubscriptionInput | BillingInvoiceUpdateManyWithWhereWithoutSubscriptionInput[]
    deleteMany?: BillingInvoiceScalarWhereInput | BillingInvoiceScalarWhereInput[]
  }

  export type BillingSubscriptionCreateNestedOneWithoutPaymentsInput = {
    create?: XOR<BillingSubscriptionCreateWithoutPaymentsInput, BillingSubscriptionUncheckedCreateWithoutPaymentsInput>
    connectOrCreate?: BillingSubscriptionCreateOrConnectWithoutPaymentsInput
    connect?: BillingSubscriptionWhereUniqueInput
  }

  export type NullableDateTimeFieldUpdateOperationsInput = {
    set?: Date | string | null
  }

  export type BillingSubscriptionUpdateOneRequiredWithoutPaymentsNestedInput = {
    create?: XOR<BillingSubscriptionCreateWithoutPaymentsInput, BillingSubscriptionUncheckedCreateWithoutPaymentsInput>
    connectOrCreate?: BillingSubscriptionCreateOrConnectWithoutPaymentsInput
    upsert?: BillingSubscriptionUpsertWithoutPaymentsInput
    connect?: BillingSubscriptionWhereUniqueInput
    update?: XOR<XOR<BillingSubscriptionUpdateToOneWithWhereWithoutPaymentsInput, BillingSubscriptionUpdateWithoutPaymentsInput>, BillingSubscriptionUncheckedUpdateWithoutPaymentsInput>
  }

  export type BillingSubscriptionCreateNestedOneWithoutInvoicesInput = {
    create?: XOR<BillingSubscriptionCreateWithoutInvoicesInput, BillingSubscriptionUncheckedCreateWithoutInvoicesInput>
    connectOrCreate?: BillingSubscriptionCreateOrConnectWithoutInvoicesInput
    connect?: BillingSubscriptionWhereUniqueInput
  }

  export type BillingSubscriptionUpdateOneRequiredWithoutInvoicesNestedInput = {
    create?: XOR<BillingSubscriptionCreateWithoutInvoicesInput, BillingSubscriptionUncheckedCreateWithoutInvoicesInput>
    connectOrCreate?: BillingSubscriptionCreateOrConnectWithoutInvoicesInput
    upsert?: BillingSubscriptionUpsertWithoutInvoicesInput
    connect?: BillingSubscriptionWhereUniqueInput
    update?: XOR<XOR<BillingSubscriptionUpdateToOneWithWhereWithoutInvoicesInput, BillingSubscriptionUpdateWithoutInvoicesInput>, BillingSubscriptionUncheckedUpdateWithoutInvoicesInput>
  }

  export type IntFieldUpdateOperationsInput = {
    set?: number
    increment?: number
    decrement?: number
    multiply?: number
    divide?: number
  }

  export type NestedStringFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringFilter<$PrismaModel> | string
  }

  export type NestedStringNullableFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel> | null
    in?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringNullableFilter<$PrismaModel> | string | null
  }

  export type NestedBigIntFilter<$PrismaModel = never> = {
    equals?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    in?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>
    notIn?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>
    lt?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    lte?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    gt?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    gte?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    not?: NestedBigIntFilter<$PrismaModel> | bigint | number
  }

  export type NestedBoolFilter<$PrismaModel = never> = {
    equals?: boolean | BooleanFieldRefInput<$PrismaModel>
    not?: NestedBoolFilter<$PrismaModel> | boolean
  }

  export type NestedDateTimeFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeFilter<$PrismaModel> | Date | string
  }

  export type NestedStringWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringWithAggregatesFilter<$PrismaModel> | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedStringFilter<$PrismaModel>
    _max?: NestedStringFilter<$PrismaModel>
  }

  export type NestedIntFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntFilter<$PrismaModel> | number
  }

  export type NestedStringNullableWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel> | null
    in?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel> | null
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringNullableWithAggregatesFilter<$PrismaModel> | string | null
    _count?: NestedIntNullableFilter<$PrismaModel>
    _min?: NestedStringNullableFilter<$PrismaModel>
    _max?: NestedStringNullableFilter<$PrismaModel>
  }

  export type NestedIntNullableFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel> | null
    in?: number[] | ListIntFieldRefInput<$PrismaModel> | null
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel> | null
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntNullableFilter<$PrismaModel> | number | null
  }

  export type NestedBigIntWithAggregatesFilter<$PrismaModel = never> = {
    equals?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    in?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>
    notIn?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>
    lt?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    lte?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    gt?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    gte?: bigint | number | BigIntFieldRefInput<$PrismaModel>
    not?: NestedBigIntWithAggregatesFilter<$PrismaModel> | bigint | number
    _count?: NestedIntFilter<$PrismaModel>
    _avg?: NestedFloatFilter<$PrismaModel>
    _sum?: NestedBigIntFilter<$PrismaModel>
    _min?: NestedBigIntFilter<$PrismaModel>
    _max?: NestedBigIntFilter<$PrismaModel>
  }

  export type NestedFloatFilter<$PrismaModel = never> = {
    equals?: number | FloatFieldRefInput<$PrismaModel>
    in?: number[] | ListFloatFieldRefInput<$PrismaModel>
    notIn?: number[] | ListFloatFieldRefInput<$PrismaModel>
    lt?: number | FloatFieldRefInput<$PrismaModel>
    lte?: number | FloatFieldRefInput<$PrismaModel>
    gt?: number | FloatFieldRefInput<$PrismaModel>
    gte?: number | FloatFieldRefInput<$PrismaModel>
    not?: NestedFloatFilter<$PrismaModel> | number
  }

  export type NestedBoolWithAggregatesFilter<$PrismaModel = never> = {
    equals?: boolean | BooleanFieldRefInput<$PrismaModel>
    not?: NestedBoolWithAggregatesFilter<$PrismaModel> | boolean
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedBoolFilter<$PrismaModel>
    _max?: NestedBoolFilter<$PrismaModel>
  }

  export type NestedDateTimeWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeWithAggregatesFilter<$PrismaModel> | Date | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedDateTimeFilter<$PrismaModel>
    _max?: NestedDateTimeFilter<$PrismaModel>
  }

  export type NestedDateTimeNullableFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel> | null
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeNullableFilter<$PrismaModel> | Date | string | null
  }

  export type NestedDateTimeNullableWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel> | null
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel> | null
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeNullableWithAggregatesFilter<$PrismaModel> | Date | string | null
    _count?: NestedIntNullableFilter<$PrismaModel>
    _min?: NestedDateTimeNullableFilter<$PrismaModel>
    _max?: NestedDateTimeNullableFilter<$PrismaModel>
  }

  export type NestedIntWithAggregatesFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntWithAggregatesFilter<$PrismaModel> | number
    _count?: NestedIntFilter<$PrismaModel>
    _avg?: NestedFloatFilter<$PrismaModel>
    _sum?: NestedIntFilter<$PrismaModel>
    _min?: NestedIntFilter<$PrismaModel>
    _max?: NestedIntFilter<$PrismaModel>
  }
  export type NestedJsonFilter<$PrismaModel = never> =
    | PatchUndefined<
        Either<Required<NestedJsonFilterBase<$PrismaModel>>, Exclude<keyof Required<NestedJsonFilterBase<$PrismaModel>>, 'path'>>,
        Required<NestedJsonFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<NestedJsonFilterBase<$PrismaModel>>, 'path'>>

  export type NestedJsonFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    mode?: QueryMode | EnumQueryModeFieldRefInput<$PrismaModel>
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
  }

  export type BillingPlanQuotaCreateWithoutPlanInput = {
    id: string
    action: string
    limit: bigint | number
    createdAt?: Date | string
  }

  export type BillingPlanQuotaUncheckedCreateWithoutPlanInput = {
    id: string
    action: string
    limit: bigint | number
    createdAt?: Date | string
  }

  export type BillingPlanQuotaCreateOrConnectWithoutPlanInput = {
    where: BillingPlanQuotaWhereUniqueInput
    create: XOR<BillingPlanQuotaCreateWithoutPlanInput, BillingPlanQuotaUncheckedCreateWithoutPlanInput>
  }

  export type BillingPlanQuotaCreateManyPlanInputEnvelope = {
    data: BillingPlanQuotaCreateManyPlanInput | BillingPlanQuotaCreateManyPlanInput[]
    skipDuplicates?: boolean
  }

  export type BillingSubscriptionCreateWithoutPlanInput = {
    id: string
    projectId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
    payments?: BillingPaymentCreateNestedManyWithoutSubscriptionInput
    invoices?: BillingInvoiceCreateNestedManyWithoutSubscriptionInput
  }

  export type BillingSubscriptionUncheckedCreateWithoutPlanInput = {
    id: string
    projectId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
    payments?: BillingPaymentUncheckedCreateNestedManyWithoutSubscriptionInput
    invoices?: BillingInvoiceUncheckedCreateNestedManyWithoutSubscriptionInput
  }

  export type BillingSubscriptionCreateOrConnectWithoutPlanInput = {
    where: BillingSubscriptionWhereUniqueInput
    create: XOR<BillingSubscriptionCreateWithoutPlanInput, BillingSubscriptionUncheckedCreateWithoutPlanInput>
  }

  export type BillingSubscriptionCreateManyPlanInputEnvelope = {
    data: BillingSubscriptionCreateManyPlanInput | BillingSubscriptionCreateManyPlanInput[]
    skipDuplicates?: boolean
  }

  export type BillingPlanQuotaUpsertWithWhereUniqueWithoutPlanInput = {
    where: BillingPlanQuotaWhereUniqueInput
    update: XOR<BillingPlanQuotaUpdateWithoutPlanInput, BillingPlanQuotaUncheckedUpdateWithoutPlanInput>
    create: XOR<BillingPlanQuotaCreateWithoutPlanInput, BillingPlanQuotaUncheckedCreateWithoutPlanInput>
  }

  export type BillingPlanQuotaUpdateWithWhereUniqueWithoutPlanInput = {
    where: BillingPlanQuotaWhereUniqueInput
    data: XOR<BillingPlanQuotaUpdateWithoutPlanInput, BillingPlanQuotaUncheckedUpdateWithoutPlanInput>
  }

  export type BillingPlanQuotaUpdateManyWithWhereWithoutPlanInput = {
    where: BillingPlanQuotaScalarWhereInput
    data: XOR<BillingPlanQuotaUpdateManyMutationInput, BillingPlanQuotaUncheckedUpdateManyWithoutPlanInput>
  }

  export type BillingPlanQuotaScalarWhereInput = {
    AND?: BillingPlanQuotaScalarWhereInput | BillingPlanQuotaScalarWhereInput[]
    OR?: BillingPlanQuotaScalarWhereInput[]
    NOT?: BillingPlanQuotaScalarWhereInput | BillingPlanQuotaScalarWhereInput[]
    id?: StringFilter<"BillingPlanQuota"> | string
    planId?: StringFilter<"BillingPlanQuota"> | string
    action?: StringFilter<"BillingPlanQuota"> | string
    limit?: BigIntFilter<"BillingPlanQuota"> | bigint | number
    createdAt?: DateTimeFilter<"BillingPlanQuota"> | Date | string
  }

  export type BillingSubscriptionUpsertWithWhereUniqueWithoutPlanInput = {
    where: BillingSubscriptionWhereUniqueInput
    update: XOR<BillingSubscriptionUpdateWithoutPlanInput, BillingSubscriptionUncheckedUpdateWithoutPlanInput>
    create: XOR<BillingSubscriptionCreateWithoutPlanInput, BillingSubscriptionUncheckedCreateWithoutPlanInput>
  }

  export type BillingSubscriptionUpdateWithWhereUniqueWithoutPlanInput = {
    where: BillingSubscriptionWhereUniqueInput
    data: XOR<BillingSubscriptionUpdateWithoutPlanInput, BillingSubscriptionUncheckedUpdateWithoutPlanInput>
  }

  export type BillingSubscriptionUpdateManyWithWhereWithoutPlanInput = {
    where: BillingSubscriptionScalarWhereInput
    data: XOR<BillingSubscriptionUpdateManyMutationInput, BillingSubscriptionUncheckedUpdateManyWithoutPlanInput>
  }

  export type BillingSubscriptionScalarWhereInput = {
    AND?: BillingSubscriptionScalarWhereInput | BillingSubscriptionScalarWhereInput[]
    OR?: BillingSubscriptionScalarWhereInput[]
    NOT?: BillingSubscriptionScalarWhereInput | BillingSubscriptionScalarWhereInput[]
    id?: StringFilter<"BillingSubscription"> | string
    projectId?: StringFilter<"BillingSubscription"> | string
    planId?: StringFilter<"BillingSubscription"> | string
    status?: StringFilter<"BillingSubscription"> | string
    currentPeriodStart?: DateTimeFilter<"BillingSubscription"> | Date | string
    currentPeriodEnd?: DateTimeFilter<"BillingSubscription"> | Date | string
    createdAt?: DateTimeFilter<"BillingSubscription"> | Date | string
    updatedAt?: DateTimeFilter<"BillingSubscription"> | Date | string
  }

  export type BillingPlanCreateWithoutQuotasInput = {
    id: string
    code: string
    name: string
    description?: string | null
    priceMinor: bigint | number
    currency: string
    billingPeriod: string
    isActive?: boolean
    createdAt?: Date | string
    updatedAt?: Date | string
    subscriptions?: BillingSubscriptionCreateNestedManyWithoutPlanInput
  }

  export type BillingPlanUncheckedCreateWithoutQuotasInput = {
    id: string
    code: string
    name: string
    description?: string | null
    priceMinor: bigint | number
    currency: string
    billingPeriod: string
    isActive?: boolean
    createdAt?: Date | string
    updatedAt?: Date | string
    subscriptions?: BillingSubscriptionUncheckedCreateNestedManyWithoutPlanInput
  }

  export type BillingPlanCreateOrConnectWithoutQuotasInput = {
    where: BillingPlanWhereUniqueInput
    create: XOR<BillingPlanCreateWithoutQuotasInput, BillingPlanUncheckedCreateWithoutQuotasInput>
  }

  export type BillingPlanUpsertWithoutQuotasInput = {
    update: XOR<BillingPlanUpdateWithoutQuotasInput, BillingPlanUncheckedUpdateWithoutQuotasInput>
    create: XOR<BillingPlanCreateWithoutQuotasInput, BillingPlanUncheckedCreateWithoutQuotasInput>
    where?: BillingPlanWhereInput
  }

  export type BillingPlanUpdateToOneWithWhereWithoutQuotasInput = {
    where?: BillingPlanWhereInput
    data: XOR<BillingPlanUpdateWithoutQuotasInput, BillingPlanUncheckedUpdateWithoutQuotasInput>
  }

  export type BillingPlanUpdateWithoutQuotasInput = {
    id?: StringFieldUpdateOperationsInput | string
    code?: StringFieldUpdateOperationsInput | string
    name?: StringFieldUpdateOperationsInput | string
    description?: NullableStringFieldUpdateOperationsInput | string | null
    priceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    billingPeriod?: StringFieldUpdateOperationsInput | string
    isActive?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    subscriptions?: BillingSubscriptionUpdateManyWithoutPlanNestedInput
  }

  export type BillingPlanUncheckedUpdateWithoutQuotasInput = {
    id?: StringFieldUpdateOperationsInput | string
    code?: StringFieldUpdateOperationsInput | string
    name?: StringFieldUpdateOperationsInput | string
    description?: NullableStringFieldUpdateOperationsInput | string | null
    priceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    billingPeriod?: StringFieldUpdateOperationsInput | string
    isActive?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    subscriptions?: BillingSubscriptionUncheckedUpdateManyWithoutPlanNestedInput
  }

  export type BillingPlanCreateWithoutSubscriptionsInput = {
    id: string
    code: string
    name: string
    description?: string | null
    priceMinor: bigint | number
    currency: string
    billingPeriod: string
    isActive?: boolean
    createdAt?: Date | string
    updatedAt?: Date | string
    quotas?: BillingPlanQuotaCreateNestedManyWithoutPlanInput
  }

  export type BillingPlanUncheckedCreateWithoutSubscriptionsInput = {
    id: string
    code: string
    name: string
    description?: string | null
    priceMinor: bigint | number
    currency: string
    billingPeriod: string
    isActive?: boolean
    createdAt?: Date | string
    updatedAt?: Date | string
    quotas?: BillingPlanQuotaUncheckedCreateNestedManyWithoutPlanInput
  }

  export type BillingPlanCreateOrConnectWithoutSubscriptionsInput = {
    where: BillingPlanWhereUniqueInput
    create: XOR<BillingPlanCreateWithoutSubscriptionsInput, BillingPlanUncheckedCreateWithoutSubscriptionsInput>
  }

  export type BillingPaymentCreateWithoutSubscriptionInput = {
    id: string
    projectId: string
    amountMinor: bigint | number
    currency: string
    status: string
    provider: string
    providerPaymentId?: string | null
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingPaymentUncheckedCreateWithoutSubscriptionInput = {
    id: string
    projectId: string
    amountMinor: bigint | number
    currency: string
    status: string
    provider: string
    providerPaymentId?: string | null
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingPaymentCreateOrConnectWithoutSubscriptionInput = {
    where: BillingPaymentWhereUniqueInput
    create: XOR<BillingPaymentCreateWithoutSubscriptionInput, BillingPaymentUncheckedCreateWithoutSubscriptionInput>
  }

  export type BillingPaymentCreateManySubscriptionInputEnvelope = {
    data: BillingPaymentCreateManySubscriptionInput | BillingPaymentCreateManySubscriptionInput[]
    skipDuplicates?: boolean
  }

  export type BillingInvoiceCreateWithoutSubscriptionInput = {
    id: string
    projectId: string
    number: string
    amountMinor: bigint | number
    currency: string
    status: string
    issuedAt: Date | string
    dueAt: Date | string
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingInvoiceUncheckedCreateWithoutSubscriptionInput = {
    id: string
    projectId: string
    number: string
    amountMinor: bigint | number
    currency: string
    status: string
    issuedAt: Date | string
    dueAt: Date | string
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingInvoiceCreateOrConnectWithoutSubscriptionInput = {
    where: BillingInvoiceWhereUniqueInput
    create: XOR<BillingInvoiceCreateWithoutSubscriptionInput, BillingInvoiceUncheckedCreateWithoutSubscriptionInput>
  }

  export type BillingInvoiceCreateManySubscriptionInputEnvelope = {
    data: BillingInvoiceCreateManySubscriptionInput | BillingInvoiceCreateManySubscriptionInput[]
    skipDuplicates?: boolean
  }

  export type BillingPlanUpsertWithoutSubscriptionsInput = {
    update: XOR<BillingPlanUpdateWithoutSubscriptionsInput, BillingPlanUncheckedUpdateWithoutSubscriptionsInput>
    create: XOR<BillingPlanCreateWithoutSubscriptionsInput, BillingPlanUncheckedCreateWithoutSubscriptionsInput>
    where?: BillingPlanWhereInput
  }

  export type BillingPlanUpdateToOneWithWhereWithoutSubscriptionsInput = {
    where?: BillingPlanWhereInput
    data: XOR<BillingPlanUpdateWithoutSubscriptionsInput, BillingPlanUncheckedUpdateWithoutSubscriptionsInput>
  }

  export type BillingPlanUpdateWithoutSubscriptionsInput = {
    id?: StringFieldUpdateOperationsInput | string
    code?: StringFieldUpdateOperationsInput | string
    name?: StringFieldUpdateOperationsInput | string
    description?: NullableStringFieldUpdateOperationsInput | string | null
    priceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    billingPeriod?: StringFieldUpdateOperationsInput | string
    isActive?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    quotas?: BillingPlanQuotaUpdateManyWithoutPlanNestedInput
  }

  export type BillingPlanUncheckedUpdateWithoutSubscriptionsInput = {
    id?: StringFieldUpdateOperationsInput | string
    code?: StringFieldUpdateOperationsInput | string
    name?: StringFieldUpdateOperationsInput | string
    description?: NullableStringFieldUpdateOperationsInput | string | null
    priceMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    billingPeriod?: StringFieldUpdateOperationsInput | string
    isActive?: BoolFieldUpdateOperationsInput | boolean
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    quotas?: BillingPlanQuotaUncheckedUpdateManyWithoutPlanNestedInput
  }

  export type BillingPaymentUpsertWithWhereUniqueWithoutSubscriptionInput = {
    where: BillingPaymentWhereUniqueInput
    update: XOR<BillingPaymentUpdateWithoutSubscriptionInput, BillingPaymentUncheckedUpdateWithoutSubscriptionInput>
    create: XOR<BillingPaymentCreateWithoutSubscriptionInput, BillingPaymentUncheckedCreateWithoutSubscriptionInput>
  }

  export type BillingPaymentUpdateWithWhereUniqueWithoutSubscriptionInput = {
    where: BillingPaymentWhereUniqueInput
    data: XOR<BillingPaymentUpdateWithoutSubscriptionInput, BillingPaymentUncheckedUpdateWithoutSubscriptionInput>
  }

  export type BillingPaymentUpdateManyWithWhereWithoutSubscriptionInput = {
    where: BillingPaymentScalarWhereInput
    data: XOR<BillingPaymentUpdateManyMutationInput, BillingPaymentUncheckedUpdateManyWithoutSubscriptionInput>
  }

  export type BillingPaymentScalarWhereInput = {
    AND?: BillingPaymentScalarWhereInput | BillingPaymentScalarWhereInput[]
    OR?: BillingPaymentScalarWhereInput[]
    NOT?: BillingPaymentScalarWhereInput | BillingPaymentScalarWhereInput[]
    id?: StringFilter<"BillingPayment"> | string
    projectId?: StringFilter<"BillingPayment"> | string
    subscriptionId?: StringFilter<"BillingPayment"> | string
    amountMinor?: BigIntFilter<"BillingPayment"> | bigint | number
    currency?: StringFilter<"BillingPayment"> | string
    status?: StringFilter<"BillingPayment"> | string
    provider?: StringFilter<"BillingPayment"> | string
    providerPaymentId?: StringNullableFilter<"BillingPayment"> | string | null
    paidAt?: DateTimeNullableFilter<"BillingPayment"> | Date | string | null
    createdAt?: DateTimeFilter<"BillingPayment"> | Date | string
  }

  export type BillingInvoiceUpsertWithWhereUniqueWithoutSubscriptionInput = {
    where: BillingInvoiceWhereUniqueInput
    update: XOR<BillingInvoiceUpdateWithoutSubscriptionInput, BillingInvoiceUncheckedUpdateWithoutSubscriptionInput>
    create: XOR<BillingInvoiceCreateWithoutSubscriptionInput, BillingInvoiceUncheckedCreateWithoutSubscriptionInput>
  }

  export type BillingInvoiceUpdateWithWhereUniqueWithoutSubscriptionInput = {
    where: BillingInvoiceWhereUniqueInput
    data: XOR<BillingInvoiceUpdateWithoutSubscriptionInput, BillingInvoiceUncheckedUpdateWithoutSubscriptionInput>
  }

  export type BillingInvoiceUpdateManyWithWhereWithoutSubscriptionInput = {
    where: BillingInvoiceScalarWhereInput
    data: XOR<BillingInvoiceUpdateManyMutationInput, BillingInvoiceUncheckedUpdateManyWithoutSubscriptionInput>
  }

  export type BillingInvoiceScalarWhereInput = {
    AND?: BillingInvoiceScalarWhereInput | BillingInvoiceScalarWhereInput[]
    OR?: BillingInvoiceScalarWhereInput[]
    NOT?: BillingInvoiceScalarWhereInput | BillingInvoiceScalarWhereInput[]
    id?: StringFilter<"BillingInvoice"> | string
    projectId?: StringFilter<"BillingInvoice"> | string
    subscriptionId?: StringFilter<"BillingInvoice"> | string
    number?: StringFilter<"BillingInvoice"> | string
    amountMinor?: BigIntFilter<"BillingInvoice"> | bigint | number
    currency?: StringFilter<"BillingInvoice"> | string
    status?: StringFilter<"BillingInvoice"> | string
    issuedAt?: DateTimeFilter<"BillingInvoice"> | Date | string
    dueAt?: DateTimeFilter<"BillingInvoice"> | Date | string
    paidAt?: DateTimeNullableFilter<"BillingInvoice"> | Date | string | null
    createdAt?: DateTimeFilter<"BillingInvoice"> | Date | string
  }

  export type BillingSubscriptionCreateWithoutPaymentsInput = {
    id: string
    projectId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
    plan: BillingPlanCreateNestedOneWithoutSubscriptionsInput
    invoices?: BillingInvoiceCreateNestedManyWithoutSubscriptionInput
  }

  export type BillingSubscriptionUncheckedCreateWithoutPaymentsInput = {
    id: string
    projectId: string
    planId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
    invoices?: BillingInvoiceUncheckedCreateNestedManyWithoutSubscriptionInput
  }

  export type BillingSubscriptionCreateOrConnectWithoutPaymentsInput = {
    where: BillingSubscriptionWhereUniqueInput
    create: XOR<BillingSubscriptionCreateWithoutPaymentsInput, BillingSubscriptionUncheckedCreateWithoutPaymentsInput>
  }

  export type BillingSubscriptionUpsertWithoutPaymentsInput = {
    update: XOR<BillingSubscriptionUpdateWithoutPaymentsInput, BillingSubscriptionUncheckedUpdateWithoutPaymentsInput>
    create: XOR<BillingSubscriptionCreateWithoutPaymentsInput, BillingSubscriptionUncheckedCreateWithoutPaymentsInput>
    where?: BillingSubscriptionWhereInput
  }

  export type BillingSubscriptionUpdateToOneWithWhereWithoutPaymentsInput = {
    where?: BillingSubscriptionWhereInput
    data: XOR<BillingSubscriptionUpdateWithoutPaymentsInput, BillingSubscriptionUncheckedUpdateWithoutPaymentsInput>
  }

  export type BillingSubscriptionUpdateWithoutPaymentsInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    plan?: BillingPlanUpdateOneRequiredWithoutSubscriptionsNestedInput
    invoices?: BillingInvoiceUpdateManyWithoutSubscriptionNestedInput
  }

  export type BillingSubscriptionUncheckedUpdateWithoutPaymentsInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    planId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    invoices?: BillingInvoiceUncheckedUpdateManyWithoutSubscriptionNestedInput
  }

  export type BillingSubscriptionCreateWithoutInvoicesInput = {
    id: string
    projectId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
    plan: BillingPlanCreateNestedOneWithoutSubscriptionsInput
    payments?: BillingPaymentCreateNestedManyWithoutSubscriptionInput
  }

  export type BillingSubscriptionUncheckedCreateWithoutInvoicesInput = {
    id: string
    projectId: string
    planId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
    payments?: BillingPaymentUncheckedCreateNestedManyWithoutSubscriptionInput
  }

  export type BillingSubscriptionCreateOrConnectWithoutInvoicesInput = {
    where: BillingSubscriptionWhereUniqueInput
    create: XOR<BillingSubscriptionCreateWithoutInvoicesInput, BillingSubscriptionUncheckedCreateWithoutInvoicesInput>
  }

  export type BillingSubscriptionUpsertWithoutInvoicesInput = {
    update: XOR<BillingSubscriptionUpdateWithoutInvoicesInput, BillingSubscriptionUncheckedUpdateWithoutInvoicesInput>
    create: XOR<BillingSubscriptionCreateWithoutInvoicesInput, BillingSubscriptionUncheckedCreateWithoutInvoicesInput>
    where?: BillingSubscriptionWhereInput
  }

  export type BillingSubscriptionUpdateToOneWithWhereWithoutInvoicesInput = {
    where?: BillingSubscriptionWhereInput
    data: XOR<BillingSubscriptionUpdateWithoutInvoicesInput, BillingSubscriptionUncheckedUpdateWithoutInvoicesInput>
  }

  export type BillingSubscriptionUpdateWithoutInvoicesInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    plan?: BillingPlanUpdateOneRequiredWithoutSubscriptionsNestedInput
    payments?: BillingPaymentUpdateManyWithoutSubscriptionNestedInput
  }

  export type BillingSubscriptionUncheckedUpdateWithoutInvoicesInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    planId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    payments?: BillingPaymentUncheckedUpdateManyWithoutSubscriptionNestedInput
  }

  export type BillingPlanQuotaCreateManyPlanInput = {
    id: string
    action: string
    limit: bigint | number
    createdAt?: Date | string
  }

  export type BillingSubscriptionCreateManyPlanInput = {
    id: string
    projectId: string
    status: string
    currentPeriodStart: Date | string
    currentPeriodEnd: Date | string
    createdAt?: Date | string
    updatedAt?: Date | string
  }

  export type BillingPlanQuotaUpdateWithoutPlanInput = {
    id?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    limit?: BigIntFieldUpdateOperationsInput | bigint | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPlanQuotaUncheckedUpdateWithoutPlanInput = {
    id?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    limit?: BigIntFieldUpdateOperationsInput | bigint | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPlanQuotaUncheckedUpdateManyWithoutPlanInput = {
    id?: StringFieldUpdateOperationsInput | string
    action?: StringFieldUpdateOperationsInput | string
    limit?: BigIntFieldUpdateOperationsInput | bigint | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingSubscriptionUpdateWithoutPlanInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    payments?: BillingPaymentUpdateManyWithoutSubscriptionNestedInput
    invoices?: BillingInvoiceUpdateManyWithoutSubscriptionNestedInput
  }

  export type BillingSubscriptionUncheckedUpdateWithoutPlanInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    payments?: BillingPaymentUncheckedUpdateManyWithoutSubscriptionNestedInput
    invoices?: BillingInvoiceUncheckedUpdateManyWithoutSubscriptionNestedInput
  }

  export type BillingSubscriptionUncheckedUpdateManyWithoutPlanInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    currentPeriodStart?: DateTimeFieldUpdateOperationsInput | Date | string
    currentPeriodEnd?: DateTimeFieldUpdateOperationsInput | Date | string
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
    updatedAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPaymentCreateManySubscriptionInput = {
    id: string
    projectId: string
    amountMinor: bigint | number
    currency: string
    status: string
    provider: string
    providerPaymentId?: string | null
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingInvoiceCreateManySubscriptionInput = {
    id: string
    projectId: string
    number: string
    amountMinor: bigint | number
    currency: string
    status: string
    issuedAt: Date | string
    dueAt: Date | string
    paidAt?: Date | string | null
    createdAt?: Date | string
  }

  export type BillingPaymentUpdateWithoutSubscriptionInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    provider?: StringFieldUpdateOperationsInput | string
    providerPaymentId?: NullableStringFieldUpdateOperationsInput | string | null
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPaymentUncheckedUpdateWithoutSubscriptionInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    provider?: StringFieldUpdateOperationsInput | string
    providerPaymentId?: NullableStringFieldUpdateOperationsInput | string | null
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingPaymentUncheckedUpdateManyWithoutSubscriptionInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    provider?: StringFieldUpdateOperationsInput | string
    providerPaymentId?: NullableStringFieldUpdateOperationsInput | string | null
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingInvoiceUpdateWithoutSubscriptionInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    issuedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    dueAt?: DateTimeFieldUpdateOperationsInput | Date | string
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingInvoiceUncheckedUpdateWithoutSubscriptionInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    issuedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    dueAt?: DateTimeFieldUpdateOperationsInput | Date | string
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type BillingInvoiceUncheckedUpdateManyWithoutSubscriptionInput = {
    id?: StringFieldUpdateOperationsInput | string
    projectId?: StringFieldUpdateOperationsInput | string
    number?: StringFieldUpdateOperationsInput | string
    amountMinor?: BigIntFieldUpdateOperationsInput | bigint | number
    currency?: StringFieldUpdateOperationsInput | string
    status?: StringFieldUpdateOperationsInput | string
    issuedAt?: DateTimeFieldUpdateOperationsInput | Date | string
    dueAt?: DateTimeFieldUpdateOperationsInput | Date | string
    paidAt?: NullableDateTimeFieldUpdateOperationsInput | Date | string | null
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }



  /**
   * Batch Payload for updateMany & deleteMany & createMany
   */

  export type BatchPayload = {
    count: number
  }

  /**
   * DMMF
   */
  export const dmmf: runtime.BaseDMMF
}