/**
 * ForgeAI v0.3.0 — Structured Tool Results
 *
 * A consistent, strongly typed result/error system for all ForgeAI tools.
 */
import { randomUUID } from "crypto";

export const ToolErrorCode = {
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  INVALID_PATH: "INVALID_PATH",
  PATH_OUTSIDE_WORKSPACE: "PATH_OUTSIDE_WORKSPACE",
  SENSITIVE_FILE: "SENSITIVE_FILE",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_READ_FAILED: "FILE_READ_FAILED",
  FILE_WRITE_FAILED: "FILE_WRITE_FAILED",
  DIRECTORY_NOT_FOUND: "DIRECTORY_NOT_FOUND",
  SEARCH_FAILED: "SEARCH_FAILED",
  COMMAND_FAILED: "COMMAND_FAILED",
  COMMAND_NOT_ALLOWED: "COMMAND_NOT_ALLOWED",
  COMMAND_NOT_FOUND: "COMMAND_NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  GIT_FAILED: "GIT_FAILED",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  BINARY_FILE: "BINARY_FILE",
  OUTPUT_LIMIT: "OUTPUT_LIMIT",
  INVALID_CURSOR: "INVALID_CURSOR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

export interface ToolError {
  /** Stable machine-readable error code. */
  code: ToolErrorCode;
  /** Human-readable error message. */
  message: string;
  /** Whether the agent can recover and retry. */
  recoverable: boolean;
}

/**
 * Machine-readable pagination information attached to a ToolResult when the
 * output was too large to fit in a single bounded response.
 *
 * - `page` / `pageSize`: 1-based index of the current page and its size.
 * - `hasMore`: whether additional pages exist.
 * - `nextCursor`: opaque single-use token used to request the next page.
 *   Cursors are scoped to the originating tool invocation and cannot be
 *   reused or manipulated to access unrelated data.
 */
export interface ToolPagination {
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor?: string;
  totalItems?: number;
  totalBytes?: number;
}

export interface ToolMetadata {
  durationMs?: number;
  exitCode?: number;
  truncated?: boolean;
  bytesRead?: number;
  bytesWritten?: number;
  stdout?: string;
  stderr?: string;
  cancelled?: boolean;
  timedOut?: boolean;
  pagination?: ToolPagination;
}

export interface ToolResult<T = unknown> {
  id: string;
  toolCallId: string;
  name: string;
  success: boolean;
  output?: T;
  error?: ToolError;
  metadata?: ToolMetadata;
}

/** Helper to build a successful ToolResult. */
export function createSuccessResult<T>(
  name: string,
  toolCallId: string,
  output: T,
  metadata: ToolMetadata = {}
): ToolResult<T> {
  return {
    id: randomUUID(),
    toolCallId,
    name,
    success: true,
    output,
    metadata,
  };
}

/** Helper to build a failed ToolResult. */
export function createErrorResult(
  name: string,
  toolCallId: string,
  code: ToolErrorCode,
  message: string,
  recoverable: boolean,
  metadata: ToolMetadata = {}
): ToolResult {
  return {
    id: randomUUID(),
    toolCallId,
    name,
    success: false,
    error: { code, message, recoverable },
    metadata,
  };
}