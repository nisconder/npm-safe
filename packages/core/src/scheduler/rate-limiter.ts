/**
 * Token bucket rate limiter.
 *
 * Standalone utility — does not import from any other local module.
 */

/** A pending consumer waiting in the FIFO queue. */
interface PendingConsumer {
  /** Number of tokens requested. */
  count: number;
  /** Resolves the consumer's `consume()` promise once fulfilled. */
  resolve: () => void;
  /** Rejects the consumer's `consume()` promise on dispose. */
  reject: (error: Error) => void;
}

/**
 * Token bucket rate limiter using a continuous-refill token bucket.
 *
 * Tokens accumulate at `tokensPerSecond` up to a maximum of `maxBurst`.
 * `consume()` blocks until the requested number of tokens are available,
 * servicing concurrent callers in FIFO order.
 */
export class TokenBucket {
  private readonly tokensPerSecond: number;
  private readonly maxBurst: number;

  /** Current number of available tokens (fractional allowed). */
  private available: number;
  /** Timestamp (ms) of the last refill computation. */
  private lastRefillTime: number;

  /** FIFO queue of consumers waiting for tokens. */
  private readonly queue: PendingConsumer[] = [];
  /** Handle to the refill interval, or `null` when disposed. */
  private intervalId: ReturnType<typeof setInterval> | null;

  /**
   * @param tokensPerSecond - Rate of token refill (default: 5).
   * @param maxBurst - Maximum accumulated tokens (default: 10).
   */
  constructor(tokensPerSecond: number = 5, maxBurst: number = 10) {
    if (tokensPerSecond <= 0 || !Number.isFinite(tokensPerSecond)) {
      throw new RangeError(`tokensPerSecond must be a positive finite number, got: ${tokensPerSecond}`);
    }
    if (maxBurst <= 0 || !Number.isFinite(maxBurst)) {
      throw new RangeError(`maxBurst must be a positive finite number, got: ${maxBurst}`);
    }

    this.tokensPerSecond = tokensPerSecond;
    this.maxBurst = maxBurst;
    // Bucket starts full (full burst available immediately).
    this.available = maxBurst;
    this.lastRefillTime = Date.now();

    // Refill tick at 100ms granularity. The actual refill amount is computed
    // from elapsed wall-clock time, so tick frequency only affects latency,
    // not the refill rate.
    this.intervalId = setInterval(() => this.refill(), 100);
    // Don't keep the Node.js event loop alive while the bucket is idle.
    // A queued consumer references the timer again until its promise settles.
    this.setIntervalReferenced(false);
  }

  /** Toggle whether the Node.js refill timer keeps the event loop alive. */
  private setIntervalReferenced(referenced: boolean): void {
    if (typeof this.intervalId !== "object" || this.intervalId === null) {
      return;
    }

    const timer = this.intervalId as { ref?: () => void; unref?: () => void };
    if (referenced) {
      timer.ref?.();
    } else {
      timer.unref?.();
    }
  }

  /**
   * Refill tokens based on elapsed wall-clock time since the last refill,
   * then service as many queued consumers as possible in FIFO order.
   */
  private refill(): void {
    if (this.intervalId === null) {
      return;
    }

    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTime) / 1000;
    this.lastRefillTime = now;

    // Continuous refill: fractional tokens accumulate based on real time.
    this.available = Math.min(this.maxBurst, this.available + elapsedSeconds * this.tokensPerSecond);

    this.drainQueue();
  }

  /**
   * Fulfill queued consumers in FIFO order while tokens are sufficient.
   * A consumer whose requested `count` exceeds `maxBurst` is auto-allowed
   * (it would otherwise deadlock forever) and drains the bucket to zero.
   */
  private drainQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];

      if (next.count > this.maxBurst) {
        // Edge case: request larger than capacity can never be satisfied
        // by accumulation. Auto-allow it and drain the bucket to zero.
        this.available = 0;
        this.queue.shift();
        next.resolve();
        continue;
      }

      if (this.available >= next.count) {
        this.available -= next.count;
        this.queue.shift();
        next.resolve();
        continue;
      }

      // Not enough tokens for the head of the queue; stop draining.
      // FIFO fairness: we never skip ahead.
      break;
    }

    if (this.queue.length === 0) {
      this.setIntervalReferenced(false);
    }
  }

  /**
   * Wait until `count` tokens are available, then consume them.
   *
   * Resolves immediately if enough tokens are available, otherwise waits
   * for refill. Concurrent callers are serviced in FIFO order.
   *
   * @param count - Number of tokens to consume (default: 1).
   */
  async consume(count: number = 1): Promise<void> {
    if (this.intervalId === null) {
      throw new Error("TokenBucket has been disposed");
    }
    if (count < 0 || !Number.isFinite(count)) {
      throw new RangeError(`count must be a non-negative finite number, got: ${count}`);
    }
    if (count === 0) {
      return;
    }

    // Fast path: enough tokens available right now.
    if (this.available >= count || count > this.maxBurst) {
      if (count > this.maxBurst) {
        // Auto-allow oversized request; drain bucket to zero.
        this.available = 0;
      } else {
        this.available -= count;
      }
      return;
    }

    // Slow path: enqueue and wait for refill to fulfill the request.
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ count, resolve, reject });
      // Node 20 may otherwise exit while this promise is still pending because
      // an unreferenced interval is not considered active event-loop work.
      this.setIntervalReferenced(true);
    });
  }

  /**
   * Try to consume tokens without waiting. Returns `true` if successful,
   * `false` if insufficient tokens are currently available.
   *
   * @param count - Number of tokens to consume (default: 1).
   */
  tryConsume(count: number = 1): boolean {
    if (this.intervalId === null) {
      return false;
    }
    if (count < 0 || !Number.isFinite(count)) {
      return false;
    }
    if (count === 0) {
      return true;
    }

    // Oversized request: auto-allow, drain bucket to zero.
    if (count > this.maxBurst) {
      this.available = 0;
      return true;
    }

    if (this.available >= count) {
      this.available -= count;
      return true;
    }

    return false;
  }

  /**
   * Get current bucket state.
   *
   * @returns An object with the current available tokens, the max burst
   * capacity, and the refill rate (tokens per second).
   */
  getStats(): { available: number; maxBurst: number; rate: number } {
    return {
      available: this.available,
      maxBurst: this.maxBurst,
      rate: this.tokensPerSecond,
    };
  }

  /**
   * Stop the refill timer and clean up. Any pending consumers are rejected
   * with an Error. Subsequent calls to `consume()` will reject and
   * `tryConsume()` will return `false`.
   */
  dispose(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Reject all pending consumers in FIFO order.
    while (this.queue.length > 0) {
      const pending = this.queue.shift()!;
      pending.reject(new Error("TokenBucket has been disposed"));
    }
  }
}
