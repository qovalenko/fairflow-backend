export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/** Poll until `predicate` returns a truthy value (no sleep/waitForTimeout). */
export async function waitFor<T>(
  predicate: () => Promise<T | false | null | undefined>,
  opts: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 400;
  const label = opts.label ?? 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms${lastErr ? `: ${String(lastErr)}` : ''}`,
  );
}
