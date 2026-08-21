/**
 * ForgeAI v0.3.2 — Tool Output Pagination
 *
 * A bounded, in-memory pagination store for large tool outputs.
 *
 * Security properties:
 * - Cursors are opaque random tokens; they carry no paths, commands or data.
 * - Cursors are SINGLE-USE: fetching a page consumes the token and issues a
 *   fresh token for the remainder. Replaying a cursor is rejected.
 * - Buffered pages are pre-filtered tool output — security filtering always
 *   happens BEFORE pagination, so later pages can never bypass it.
 * - The store is bounded (max entries + TTL) to prevent memory exhaustion.
 */
import { randomUUID } from "crypto";

/** Maximum number of active pagination entries held in memory. */
export const PAGINATION_MAX_ENTRIES = 50;
/** Time-to-live for a pagination entry (ms). */
export const PAGINATION_TTL_MS = 15 * 60 * 1000;
/** Hard cap on buffered bytes per pagination entry. */
export const PAGINATION_MAX_BUFFER_BYTES = 1024 * 1024;

export interface PaginatedPage {
  /** 1-based index of this page. */
  page: number;
  /** Number of items/bytes in this page (informational). */
  pageSize: number;
  /** Total number of pages available for this invocation. */
  totalPages: number;
  hasMore: boolean;
  nextCursor?: string;
}

interface PaginationEntry {
  pages: string[];
  /** Tool name that created this entry; cursors are rejected cross-tool. */
  owner: string;
  createdAt: number;
}

export class PaginationStore {
  private readonly entries = new Map<string, PaginationEntry>();

  /**
   * Stores pre-chunked pages and returns an opaque cursor for page 2
   * (page 1 is returned directly by the tool). The entry is scoped to the
   * owning tool name; a cursor presented to a different tool is rejected.
   */
  store(pages: string[], owner: string): string {
    // Evict expired entries first
    this.evictExpired();

    // Enforce bounded store size (drop oldest)
    while (this.entries.size >= PAGINATION_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    const cursor = randomUUID();
    this.entries.set(cursor, { pages, owner, createdAt: Date.now() });
    return cursor;
  }

  /**
   * Fetches the next page for a cursor. The cursor is consumed (single-use);
   * when more pages remain, a fresh cursor is returned for the continuation.
   * Returns null when the cursor is invalid, expired, already used, or
   * presented to a tool other than its owner.
   */
  fetch(cursor: string, owner: string): PaginatedPage & { content: string } | null {
    this.evictExpired();

    const entry = this.entries.get(cursor);
    if (!entry || entry.owner !== owner) return null;
    this.entries.delete(cursor); // single-use

    const [content, ...remaining] = entry.pages;
    const totalPages = entry.pages.length;
    const hasMore = remaining.length > 0;

    let nextCursor: string | undefined;
    if (hasMore) {
      nextCursor = randomUUID();
      this.entries.set(nextCursor, { pages: remaining, owner, createdAt: Date.now() });
    }

    return {
      content,
      page: 1, // relative to the remaining pages at time of storage
      pageSize: Buffer.byteLength(content, "utf-8"),
      totalPages,
      hasMore,
      nextCursor,
    };
  }

  /** Test/debug helper: number of live entries. */
  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > PAGINATION_TTL_MS) {
        this.entries.delete(key);
      }
    }
  }
}

/** Shared process-wide pagination store. */
export const paginationStore = new PaginationStore();

/**
 * Splits text into chunks of at most `chunkSizeBytes` UTF-8 bytes without
 * splitting surrogate pairs. Deterministic for identical input.
 */
export function chunkText(text: string, chunkSizeBytes: number): string[] {
  if (Buffer.byteLength(text, "utf-8") <= chunkSizeBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  // Iterate by code points so surrogate pairs are never split.
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf-8");
    if (currentBytes + chBytes > chunkSizeBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}