/** Lifecycle/failure coordination shared by application services; no process API. */
export interface ApplicationControl {
  assertAvailable(): void;
  write(work: () => void): void;
  fail(error: unknown): void;
  isFailed(): boolean;
}
