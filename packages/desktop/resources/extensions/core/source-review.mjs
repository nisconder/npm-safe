const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const activeReviews = new WeakMap();

export function desktopSourceReviewBudgetMs(timeoutMs) {
  // Reserve 10 seconds within the native timer limit for the frontend response.
  return Math.min(2_147_473_647, timeoutMs * 2 + 120_000);
}

/** Extend the public masked status with the request budget, never raw config. */
export function desktopLlmStatus(engine) {
  const status = engine.getLlmStatus();
  const configuredTimeout = engine.getLlmConfig().timeoutMs;
  const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 && configuredTimeout <= 2_147_483_647
    ? configuredTimeout : 30_000;
  return { ...status, timeoutMs };
}

/** Reuse the CLI's deep-check path for one explicitly selected registry release. */
export async function reviewDesktopPackageSource(engine, data, log = () => {}) {
  const name = data?.name;
  const version = data?.version;
  if (typeof name !== "string" || name.length > 214 || !PACKAGE_NAME.test(name)) {
    throw new Error("源码复核需要有效的 npm 包名。");
  }
  if (typeof version !== "string" || version.length > 256 || !EXACT_VERSION.test(version)) {
    throw new Error("源码复核需要固定的完整版本号，不支持标签、版本范围或仓库地址。");
  }
  const status = desktopLlmStatus(engine);
  if (status.enabled !== true || status.configured !== true) {
    throw new Error("源码复核需要已启用且已配置的 LLM。");
  }
  if (status.sourceReview !== true) {
    throw new Error("请先在 LLM 设置中启用深度检查源码复核。");
  }

  const active = activeReviews.get(engine) ?? new Set();
  const target = `${name}\0${version}`;
  if (active.has(target)) throw new Error("所选版本的源码复核正在进行，请等待当前任务结束。");
  active.add(target);
  activeReviews.set(engine, active);

  const started = performance.now();
  let review;
  const report = (state) => {
    try {
      log(JSON.stringify({
        name, version, status: state,
        verdict: ["benign", "malicious", "unknown"].includes(review?.verdict) ? review.verdict : "unknown",
        calls: Number.isSafeInteger(review?.calls) && review.calls >= 0 ? review.calls : 0,
        sourceCharsSent: Number.isSafeInteger(review?.sourceCharsSent) && review.sourceCharsSent >= 0 ? review.sourceCharsSent : 0,
        ...(["invalid-request-schema", "invalid-source-range", "supplement-character-budget"].includes(review?.sourceRequestFailure)
          ? { sourceRequestFailure: review.sourceRequestFailure } : {}),
        ...(Array.isArray(review?.evidenceOffsetCorrections) && review.evidenceOffsetCorrections.length
          ? { evidenceOffsetsCorrected: review.evidenceOffsetCorrections.length } : {}),
        elapsedMs: Math.round(performance.now() - started),
      }));
    } catch { /* Operational logging must not change the review result. */ }
  };
  try {
    report("started");
    const signal = AbortSignal.timeout(desktopSourceReviewBudgetMs(status.timeoutMs));
    const result = await engine.checkPackage(name, { version, deep: true, forceRefresh: true, signal });
    signal.throwIfAborted();
    if (!result?.exists || result.packageName !== name || result.latestVersion !== version) {
      throw new Error("引擎未返回所选 npm 包固定版本的检查结果。");
    }
    review = result.security?.sourceReview;
    if (!review || !["complete", "failed", "skipped"].includes(review.status)) {
      throw new Error("引擎未返回源码复核结果，请确认已启用深度检查源码复核。");
    }
    await engine.recordCheckHistory(result);
    return result;
  } finally {
    // These operational counters contain no package source, model response or key.
    report(review?.status ?? "failed");
    active.delete(target);
    if (active.size === 0) activeReviews.delete(engine);
  }
}
