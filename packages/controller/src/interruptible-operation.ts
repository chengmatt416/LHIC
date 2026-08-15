export class OperationInterruptedError extends Error {
  public constructor(
    public readonly operation: string,
    public readonly reason: "aborted" | "timeout",
    public readonly timeoutMs?: number,
  ) {
    super(
      reason === "timeout"
        ? `${operation} timed out after ${timeoutMs} ms.`
        : `${operation} was aborted.`,
    );
    this.name = "OperationInterruptedError";
  }
}

/**
 * Bounds an interruptible operation even when the implementation ignores its
 * AbortSignal. The losing promise remains observed by Promise.race, while the
 * signal gives cooperative implementations a chance to stop their work.
 */
export async function runInterruptible<T>(
  operation: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${operation} timeout must be a positive integer.`);
  }
  if (externalSignal?.aborted) {
    throw new OperationInterruptedError(operation, "aborted");
  }

  const operationController = new AbortController();
  const { promise: interrupted, reject } = Promise.withResolvers<never>();
  const onExternalAbort = (): void => {
    reject(new OperationInterruptedError(operation, "aborted"));
    operationController.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    reject(new OperationInterruptedError(operation, "timeout", timeoutMs));
    operationController.abort();
  }, timeoutMs);

  try {
    const operationPromise = Promise.resolve().then(() =>
      run(operationController.signal),
    );
    return await Promise.race([operationPromise, interrupted]);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
