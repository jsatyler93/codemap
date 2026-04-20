function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RetryScheduler {
  constructor({ maxAttempts = 3, baseDelayMs = 80 } = {}) {
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
  }

  async run(operation, contextLabel) {
    let attempt = 0;
    let lastError = undefined;
    while (attempt < this.maxAttempts) {
      try {
        attempt += 1;
        return await operation();
      } catch (err) {
        lastError = err;
        if (attempt >= this.maxAttempts) break;
        await sleep(this.baseDelayMs * attempt);
      }
    }
    throw new Error(`retry-failed:${contextLabel}:${String(lastError)}`);
  }
}
