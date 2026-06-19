// Type definitions for lingcode-js
// Project: https://lingcode.dev

export interface LingCodeError extends Error {
  /** Server error code, e.g. "where_required", "object_not_found", or null. */
  code: string | null;
  /** HTTP status (0 for client-side errors). */
  status: number;
}

/** Supabase-style result envelope: check `error` before using `data`. */
export interface Result<T = any> {
  data: T | null;
  error: LingCodeError | null;
}

export interface User {
  id: string | null;
  email: string | null;
}

export interface Session {
  user: User | null;
  token: string;
}

/** A live row-change event delivered to `.subscribe()`. */
export interface ChangeEvent<T = any> {
  table: string;
  type: "INSERT" | "UPDATE" | "DELETE";
  row: T;
}

/** Cancels a realtime subscription. */
export type Unsubscribe = () => void;

/**
 * Chainable query builder. Add filters (`.eq`, `.in`, …) and modifiers
 * (`.order`, `.limit`) before a terminal op (`.select`, `.insert`,
 * `.update`, `.delete`). `.update()`/`.delete()` REQUIRE a filter.
 */
export interface QueryBuilder<T = any> {
  eq(column: string, value: any): this;
  neq(column: string, value: any): this;
  gt(column: string, value: any): this;
  gte(column: string, value: any): this;
  lt(column: string, value: any): this;
  lte(column: string, value: any): this;
  like(column: string, value: string): this;
  ilike(column: string, value: string): this;
  in(column: string, values: any[]): this;
  /** `.is(col, null)` → IS NULL; `.is(col, "not_null")` → IS NOT NULL. */
  is(column: string, value: null | "not_null"): this;
  /** Merge several equality filters at once. */
  match(filters: Record<string, any>): this;
  order(column: string, opts?: { ascending?: boolean }): this;
  limit(n: number): this;
  range(from: number, to: number): this;

  select(): Promise<Result<T[]>>;
  insert(row: Partial<T> | Partial<T>[]): Promise<Result<T[]>>;
  /** Requires a filter (.eq/.match). */
  update(patch: Partial<T>): Promise<Result<T[]>>;
  /** Requires a filter (.eq/.match). */
  delete(): Promise<Result<T[]>>;

  /** Subscribe to live INSERT/UPDATE/DELETE events (RLS-filtered). */
  subscribe(
    onChange: (event: ChangeEvent<T>) => void,
    onError?: (e: Event) => void
  ): Unsubscribe;
}

export interface ProviderInfo {
  available: boolean;
  source?: string | null;
}

export interface AuthApi {
  signUp(creds: { email: string; password: string }): Promise<Result<Session>>;
  signIn(creds: { email: string; password: string }): Promise<Result<Session>>;
  signInWithPassword(creds: { email: string; password: string }): Promise<Result<Session>>;
  /** Top-level navigation to the provider; on return the session is auto-stored. */
  signInWithOAuth(provider: "google" | "github" | "apple" | string, opts?: { redirectTo?: string }): void;
  /** Which OAuth providers are enabled for this backend. */
  getProviders(): Promise<Record<string, ProviderInfo>>;
  sendMagicLink(opts: { email: string; redirectTo?: string }): Promise<Result<{ sent: boolean }>>;
  verifyMagicLink(token: string): Promise<Result<Session>>;
  sendOtp(opts: { email: string }): Promise<Result<{ sent: boolean }>>;
  verifyOtp(opts: { email: string; code: string }): Promise<Result<Session>>;
  getUser(): User | null;
  getToken(): string | null;
  /** OAuth error code from the last redirect, if any. */
  lastError(): string | null;
  signOut(): Promise<{ error: null }>;
}

export interface StorageBucket {
  /**
   * Upload a file. Small files (≤5 MB) go inline; larger files (video/audio
   * recordings, etc.) upload directly to object storage via a presigned URL, so
   * GB-scale files work. The size cap is per tier — see `client.config` / the
   * backend's `maxUploadBytes`.
   */
  upload(path: string, file: Blob | File | ArrayBuffer | string, opts?: { contentType?: string }): Promise<Result<{ bucket: string; path: string; bytes: number; url: string }>>;
  download(path: string): Promise<Result<Blob>>;
  getPublicUrl(path: string): string;
  remove(path: string): Promise<Result<{ removed: boolean }>>;
}

export interface StorageApi {
  from(bucket: string): StorageBucket;
}

export interface FunctionsApi {
  invoke<T = any>(slug: string, body?: any): Promise<Result<T>>;
}

export interface VectorApi {
  search<T = any>(query: {
    table: string;
    column: string;
    embedding: number[];
    limit?: number;
    metric?: "cosine" | "l2" | "ip";
  }): Promise<Result<T[]>>;
  embed(input: string | string[]): Promise<Result<{ embedding: number[]; embeddings: number[][]; model: string; dimensions: number }>>;
}

export interface PushApi {
  isSupported(): boolean;
  /** Registers the service worker + subscribes via PushManager, then stores the subscription. */
  subscribe(opts?: { serviceWorker?: string }): Promise<Result<any>>;
}

export interface TelemetryApi {
  /** Log a custom analytics event with optional params (<=25 keys; scalar values). */
  logEvent(name: string, params?: Record<string, string | number | boolean>): void;
  /** Convenience for a screen_view event. */
  logScreen(name: string): void;
  /** Record a custom performance trace, in milliseconds. */
  trace(name: string, ms: number): void;
  /** Report a caught error/crash (flushes immediately). */
  recordError(err: Error | { message?: string; stack?: string } | string): void;
  /** Tie analytics to a real app user id (opt-in). Pass null/'' to clear. */
  setUserId(id: string | null): void;
  /** Set user properties for segmentation. Merged + persisted; attached to events. */
  setUserProperties(props: Record<string, string | number | boolean>): void;
  /** Force-send buffered events now. */
  flush(): Promise<Result>;
}

export interface ConfigApi {
  /** Resolves once this client's remote config has loaded. */
  readonly ready: Promise<ConfigApi>;
  /** Read a remote-config value (or `def` if unset). Experiment variants come through here. */
  get<T = any>(key: string, def?: T): T;
  /** All resolved config values. */
  all(): Record<string, any>;
}

export interface LingCodeClient {
  readonly url: string;
  readonly anonKey: string;
  readonly backendId: string;
  /** Resolves after any auth redirect in the URL is consumed. */
  readonly ready: Promise<LingCodeClient>;
  from<T = any>(table: string): QueryBuilder<T>;
  auth: AuthApi;
  storage: StorageApi;
  functions: FunctionsApi;
  vector: VectorApi;
  push: PushApi;
  telemetry: TelemetryApi;
  config: ConfigApi;
}

export interface CreateClientOptions {
  /** Set false to skip reading ?lc_session/?lc_magic from the URL on construct. */
  detectSessionInUrl?: boolean;
}

export function createClient(url: string, anonKey: string, options?: CreateClientOptions): LingCodeClient;
export const version: string;

declare const LingCode: {
  createClient: typeof createClient;
  version: string;
};
export default LingCode;

declare global {
  interface Window {
    LingCode: typeof LingCode;
    /** Pre-injected in LingCode /try preview & published apps. */
    lingcode?: LingCodeClient;
    LINGCODE_BACKEND_URL?: string;
    LINGCODE_BACKEND_ANON_KEY?: string;
  }
}
