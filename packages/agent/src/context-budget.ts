export interface ContextBudget {
  readonly maxTotalBytes: number;
  readonly maxSingleFileBytes: number;
  readonly reservedBytes: number;

  remaining(): number;
  canAllocate(bytes: number): boolean;
  allocate(bytes: number): void;
  reset(): void;
}

export function createContextBudget(maxTotalBytes: number, maxSingleFileBytes: number, reservedBytes = 0): ContextBudget {
  let remainingBytes = maxTotalBytes - reservedBytes;

  return {
    maxTotalBytes,
    maxSingleFileBytes,
    reservedBytes,
    remaining(): number {
      return remainingBytes;
    },
    canAllocate(bytes: number): boolean {
      return bytes <= remainingBytes && bytes <= maxSingleFileBytes;
    },
    allocate(bytes: number): void {
      remainingBytes -= bytes;
    },
    reset(): void {
      remainingBytes = maxTotalBytes - reservedBytes;
    },
  };
}
