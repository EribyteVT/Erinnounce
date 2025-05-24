import { RETRY_CONFIG } from "../config/constants.js";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff(
  fn,
  operation,
  maxAttempts = RETRY_CONFIG.maxAttempts
) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) {
        console.error(`${operation} failed after ${maxAttempts} attempts:`, error);
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000,
        RETRY_CONFIG.maxDelay
      );

      console.warn(
        `${operation} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(
          delay
        )}ms:`,
        error.message
      );
      await sleep(delay);
    }
  }

  throw lastError;
}