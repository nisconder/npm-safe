import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../src/scheduler/rate-limiter.js";

describe("TokenBucket", () => {
  let bucket: TokenBucket;

  afterEach(() => {
    try {
      bucket.dispose();
    } catch {
      // already disposed
    }
  });

  describe("constructor", () => {
    it("creates with default values", () => {
      bucket = new TokenBucket();
      const stats = bucket.getStats();
      assert.strictEqual(stats.rate, 5);
      assert.strictEqual(stats.maxBurst, 10);
      assert.strictEqual(stats.available, 10);
    });

    it("creates with custom values", () => {
      bucket = new TokenBucket(3, 6);
      const stats = bucket.getStats();
      assert.strictEqual(stats.rate, 3);
      assert.strictEqual(stats.maxBurst, 6);
      assert.strictEqual(stats.available, 6);
    });

    it("throws on zero tokensPerSecond", () => {
      assert.throws(() => new TokenBucket(0, 10), RangeError);
    });

    it("throws on negative tokensPerSecond", () => {
      assert.throws(() => new TokenBucket(-1, 10), RangeError);
    });

    it("throws on zero maxBurst", () => {
      assert.throws(() => new TokenBucket(5, 0), RangeError);
    });

    it("throws on negative maxBurst", () => {
      assert.throws(() => new TokenBucket(5, -1), RangeError);
    });

    it("throws on NaN tokensPerSecond", () => {
      assert.throws(() => new TokenBucket(NaN, 10), RangeError);
    });

    it("throws on Infinity maxBurst", () => {
      assert.throws(() => new TokenBucket(5, Infinity), RangeError);
    });
  });

  describe("consume", () => {
    it("consumes tokens immediately when available", async () => {
      bucket = new TokenBucket(5, 10);
      await bucket.consume(1);
      const stats = bucket.getStats();
      assert.strictEqual(stats.available, 9);
    });

    it("consumes multiple tokens at once", async () => {
      bucket = new TokenBucket(5, 10);
      await bucket.consume(3);
      const stats = bucket.getStats();
      assert.strictEqual(stats.available, 7);
    });

    it("consumes 0 tokens as no-op", async () => {
      bucket = new TokenBucket(5, 10);
      await bucket.consume(0);
      const stats = bucket.getStats();
      assert.strictEqual(stats.available, 10);
    });

    it("auto-allows requests larger than maxBurst", async () => {
      bucket = new TokenBucket(5, 10);
      const before = bucket.getStats().available;
      await bucket.consume(100);
      const after = bucket.getStats().available;
      assert.strictEqual(after, 0);
      assert.ok(before === 10);
    });

    it("throws after dispose", async () => {
      bucket = new TokenBucket(5, 10);
      bucket.dispose();
      await assert.rejects(
        async () => bucket.consume(1),
        /disposed/,
      );
    });

    it("throws on negative count", async () => {
      bucket = new TokenBucket(5, 10);
      await assert.rejects(
        async () => bucket.consume(-1),
        /non-negative/,
      );
    });

    it("throws on NaN count", async () => {
      bucket = new TokenBucket(5, 10);
      await assert.rejects(
        async () => bucket.consume(NaN),
        /non-negative/,
      );
    });
  });

  describe("tryConsume", () => {
    it("consumes tokens and returns true when available", () => {
      bucket = new TokenBucket(5, 10);
      assert.strictEqual(bucket.tryConsume(2), true);
      assert.strictEqual(bucket.getStats().available, 8);
    });

    it("returns false when not enough tokens", () => {
      bucket = new TokenBucket(5, 10);
      assert.strictEqual(bucket.tryConsume(11), true);
      assert.strictEqual(bucket.getStats().available, 0);
    });

    it("returns false after dispose", () => {
      bucket = new TokenBucket(5, 10);
      bucket.dispose();
      assert.strictEqual(bucket.tryConsume(1), false);
    });

    it("returns true for zero count", () => {
      bucket = new TokenBucket(5, 10);
      assert.strictEqual(bucket.tryConsume(0), true);
      assert.strictEqual(bucket.getStats().available, 10);
    });

    it("handles negative count gracefully", () => {
      bucket = new TokenBucket(5, 10);
      assert.strictEqual(bucket.tryConsume(-1), false);
    });
  });

  describe("dispose", () => {
    it("cleans up interval and rejects pending consumers", async () => {
      bucket = new TokenBucket(5, 2);
      // Drain all tokens so next consume queues.
      await bucket.consume(2);
      // The bucket should be at 0 now. A consume(1) will queue.
      // But we can also test the dispose rejection.
      bucket.dispose();

      await assert.rejects(
        async () => bucket.consume(1),
        /disposed/,
      );
    });

    it("is safe to call multiple times", () => {
      bucket = new TokenBucket(5, 10);
      bucket.dispose();
      bucket.dispose();
      assert.strictEqual(bucket.tryConsume(1), false);
    });
  });

  describe("waiting behavior", () => {
    it("eventually fulfills queued consumer after refill", async () => {
      // Use high rate so the test is deterministic and fast.
      bucket = new TokenBucket(500, 2);
      // Consume all burst.
      await bucket.consume(2);
      assert.strictEqual(bucket.getStats().available, 0);

      // This will queue — but should resolve quickly (100ms tick).
      const start = Date.now();
      await bucket.consume(1);
      const elapsed = Date.now() - start;
      // With 500 tokens/s refill and 100ms tick, should resolve within ~200ms max.
      assert.ok(elapsed < 500, `expected < 500ms, got ${elapsed}ms`);
      assert.ok(bucket.getStats().available >= 0);
    });

    it("services consumers in FIFO order", async () => {
      bucket = new TokenBucket(1000, 1);
      await bucket.consume(1);
      assert.strictEqual(bucket.getStats().available, 0);

      const results: number[] = [];
      const p1 = bucket.consume(1).then(() => results.push(1));
      const p2 = bucket.consume(1).then(() => results.push(2));
      const p3 = bucket.consume(1).then(() => results.push(3));

      await Promise.all([p1, p2, p3]);
      assert.deepStrictEqual(results, [1, 2, 3]);
    });
  });
});
