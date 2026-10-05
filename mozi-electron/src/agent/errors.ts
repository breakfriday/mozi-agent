import { isAppError } from "../../../shared/agent";
import type { AppError } from "../../../shared/agent";
export function failure(code: AppError["code"], message: string): AppError { return { code, message }; }
export function appError(error: unknown): AppError {
  return isAppError(error) ? error : failure("INTERNAL_ERROR", error instanceof Error ? error.message : "Agent operation failed.");
}
