/** A promise whose settlement is controlled from outside. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  return {
    promise,
    resolve(value: T) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject(error: unknown) {
      if (settled) return;
      settled = true;
      rejectFn(error);
    },
    get settled() {
      return settled;
    },
  };
}
