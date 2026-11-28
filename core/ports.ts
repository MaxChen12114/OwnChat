/**
 * Port shapes the platform services will be assembled from: transport, secret, storage and the
 * database provider. Shapes only — no implementation, no storage reads, no environment probing.
 *
 * Why these live in `core/` next to `runtime.ts`: the runtime context (`provide`/`get`/`inject`)
 * is the container, and a container without declared port shapes ends up as call sites importing
 * concrete modules. `DbProvider` is what `dbSvc.register(name, factory)` stores; the other three
 * are the seams the neighbouring batches need (a transport for the hand-rolled fetch sites, a
 * secret reader for tokens, a storage reader for the hot window). Declaring them here means one
 * place says "this is a port" instead of three services inventing three spellings.
 *
 * Deliberate omissions: no DOM types (`Response`, `Blob`, `Storage`), so the shapes type-check in a
 * worker, a Node test and a browser alike; and no write side on `SecretPort` — setting a token is
 * an explicit user action that must go through its own UI path, never through a service call.
 *
 * Not to be confused with `core/capability.ts`: that file is the *tool capability snapshot* (what
 * this environment can currently do, with its two-way lock). A provider registry is a different
 * question — who supplies a value — and merging the two would either grow the frozen snapshot with
 * unrelated bits or make "capability off" look like "provider missing".
 * @module core/ports
 */

import type { DbPort } from "./db";

/** One HTTP request as a port sees it. `body` is already serialised: headers are added here. */
export interface TransportRequest {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The subset of an HTTP response the port promises. Streaming is a separate concern. */
export interface TransportResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** The request exit. Implementations decide timeouts and auth; callers never touch `fetch`. */
export interface TransportPort {
  send(req: TransportRequest): Promise<TransportResponse>;
}

/** Read-only token access. `get` answers an empty string when nothing is stored. */
export interface SecretPort {
  get(id: string): string;
  has(id: string): boolean;
}

/** Key/value persistence for the hot window (localStorage on the web, native KV on the desktop). */
export interface StoragePort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * One DbPort implementation a host can hand out. `create` runs on every selection, so a factory
 * must not keep module-level state that outlives its port; the facade owns selection, not the
 * adapter.
 */
export interface DbProvider {
  readonly name: string;
  create(options?: unknown): DbPort;
}
