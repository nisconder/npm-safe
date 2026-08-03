/**
 * Frontend logic for the npm-safe Neutralinojs desktop app.
 *
 * All engine operations are delegated to the `js.npmsafe.core` extension
 * process via Neutralino's WebSocket IPC.
 */

const EXT_ID = "js.npmsafe.core";

let engineReady = false;

// ---------------------------------------------------------------------------
// Engine IPC bridge
// ---------------------------------------------------------------------------

const pending = new Map();

function registerHistoryEvents() {
  const events = ["getHistory", "addHistory", "clearHistory"];
  for (const name of events) {
    Neutralino.events.on(`${name}:response`, (evt) => {
      const { requestId, result } = evt.detail ?? {};
      const entry = pending.get(requestId);
      if (entry) {
        pending.delete(requestId);
        entry.resolve(result);
      }
    });
    Neutralino.events.on(`${name}:error`, (evt) => {
      const { requestId, message } = evt.detail ?? {};
      const entry = pending.get(requestId);
      if (entry) {
        pending.delete(requestId);
        entry.reject(new Error(message ?? "Engine error"));
      }
    });
  }
}

function callEngine(method, data) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("请求超时"));
    }, 30000);
    pending.set(requestId, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    Neutralino.extensions.dispatch(EXT_ID, method, {
      ...data,
      _requestId: requestId,
    });
  });
}

function registerEngineEvents() {
  const events = [
    "checkPackage",
    "searchPackages",
    "getWatchlist",
    "addToWatchlist",
    "removeFromWatchlist",
    "refreshPackage",
    "refreshAll",
    "getSetting",
    "setSetting",
    "listRules",
    "setRuleEnabled",
    "setRuleSeverity",
    "setRuleOptions",
    "loadRulePlugins",
    "getLlmStatus",
    "setLlmConfig",
    "testLlmConnection",
  ];

  for (const name of events) {
    Neutralino.events.on(`${name}:response`, (evt) => {
      const { requestId, result } = evt.detail ?? {};
      const entry = pending.get(requestId);
      if (entry) {
        pending.delete(requestId);
        entry.resolve(result);
      }
    });

    Neutralino.events.on(`${name}:error`, (evt) => {
      const { requestId, message } = evt.detail ?? {};
      const entry = pending.get(requestId);
      if (entry) {
        pending.delete(requestId);
        entry.reject(new Error(message ?? "Engine error"));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function setStatus(message, type = "") {
  const bar = document.getElementById("status-bar");
  bar.textContent = message;
  bar.className = `status-bar ${type}`;
}

function setBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
    btn.textContent = "处理中...";
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.originalText ?? btn.textContent;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

const TAB_TITLES = {
  overview: "总览",
  check: "检查",
  search: "搜索",
  watch: "监控",
  rules: "评价体系",
  llm: "LLM",
  settings: "设置",
};

const THEME_KEY = "npm-safe-theme";
const LAST_TAB_KEY = "npm-safe-last-tab";

// Preferences are persisted in two layers:
//   1. localStorage — applied instantly at startup (fast, synchronous).
//   2. Engine settings table (~/.npm-safe/npm-safe.db) — survives webview
//      cache clears and is the source of truth once the engine connects.
function persistPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore quota / privacy-mode failures
  }
  if (engineReady) {
    try {
      void callEngine("setSetting", { key, value });
    } catch {
      // best effort
    }
  }
}

function applyTheme(isLight) {
  document.body.classList.toggle("light-theme", isLight);
}

function setTheme(isLight) {
  applyTheme(isLight);
  persistPref(THEME_KEY, isLight ? "light" : "dark");
}

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved === "light");
}

function toggleTheme() {
  setTheme(!document.body.classList.contains("light-theme"));
}

function switchTab(tab) {
  const btn = document.querySelector(`.nav-item[data-tab='${tab}']`);
  if (!btn || !TAB_TITLES[tab]) return false;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(`tab-${tab}`).classList.add("active");
  const title = document.getElementById("top-title");
  if (title) title.textContent = TAB_TITLES[tab];
  persistPref(LAST_TAB_KEY, tab);
  if (tab === "overview") renderOverview();
  if (tab === "rules") renderRules();
  if (tab === "llm") renderLlmConfig();
  return true;
}

function restoreLastTab() {
  const saved = localStorage.getItem(LAST_TAB_KEY);
  if (saved && switchTab(saved)) return;
  switchTab("overview");
}

// Hydrate preferences from the engine settings table once the extension
// signals it is ready. Backend values win over localStorage.
async function hydratePrefs() {
  engineReady = true;
  try {
    const theme = await callEngine("getSetting", { key: "theme" });
    if (theme === "light" || theme === "dark") applyTheme(theme === "light");

    const tab = await callEngine("getSetting", { key: "lastTab" });
    if (tab && TAB_TITLES[tab]) switchTab(tab);
  } catch {
    // Engine not reachable — localStorage values already applied.
  }
}

function initPrefs() {
  Neutralino.events.on("engineReady", () => {
    void hydratePrefs();
  });
  // Fallback in case the extension is an older build that never broadcasts.
  setTimeout(() => {
    if (!engineReady) void hydratePrefs();
  }, 2500);
}

function initTabs() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
    });
  });
}

// ---------------------------------------------------------------------------
// Title bar controls
// ---------------------------------------------------------------------------

function initTitleBar() {
  const drag = document.getElementById("title-bar-drag");
  if (drag && Neutralino.window && Neutralino.window.setDraggableRegion) {
    Neutralino.window.setDraggableRegion(drag);
  }

  const minimize = document.getElementById("window-minimize");
  if (minimize && Neutralino.window && Neutralino.window.minimize) {
    minimize.addEventListener("click", () => Neutralino.window.minimize());
  }

  const close = document.getElementById("window-close");
  if (close) {
    close.addEventListener("click", () => Neutralino.app.exit());
  }

  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      toggleTheme();
    });
  }
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function renderCheckResult(result) {
  const area = document.getElementById("check-result");
  if (!result.exists) {
    area.innerHTML = `<div class="card"><div class="card-title">未找到</div>包 "${escapeHtml(result.packageName)}" 不存在于 npm 注册表。</div>`;
    return;
  }

  const report = result.security.staticScan;
  const findings = report?.findings ?? [];

  const rows = [
    ["包名", escapeHtml(result.packageName)],
    ["最新版本", escapeHtml(result.latestVersion)],
    ["安全等级", `<span class="badge ${escapeAttr(result.security.overallLevel)}">${escapeHtml(result.security.overallLevel)}</span>`],
    ["分数", `${escapeHtml(String(result.security.overallScore))}/100`],
    ["发现项数量", String(findings.length)],
  ];

  if (result.registryInfo?.description) rows.push(["描述", escapeHtml(result.registryInfo.description)]);
  if (result.registryInfo?.homepage) rows.push(["主页", escapeHtml(result.registryInfo.homepage)]);
  if (result.registryInfo?.repository) rows.push(["仓库", escapeHtml(result.registryInfo.repository)]);

  let html = `<div class="card"><div class="card-title">${escapeHtml(result.packageName)} 检查结果</div>`;
  for (const [k, v] of rows) {
    html += `<div class="card-row"><span>${k}</span><span class="value">${v}</span></div>`;
  }

  if (findings.length > 0) {
    html += `<div class="card-title" style="margin-top:12px">发现项</div>`;
    for (const f of findings) {
      const sev = f.severity;
      html += `
        <div class="finding ${escapeAttr(sev)}">
          <div class="finding-header">[${escapeHtml(sev.toUpperCase())}] ${escapeHtml(f.ruleId)} — ${escapeHtml(f.ruleName)}</div>
          <div class="finding-message">${escapeHtml(f.message)}</div>
          ${f.recommendation ? `<div class="finding-meta">建议: ${escapeHtml(f.recommendation)}</div>` : ""}
          ${f.codeSnippet ? `<div class="finding-meta">片段: ${escapeHtml(f.codeSnippet)}</div>` : ""}
          ${f.lineNumber ? `<div class="finding-meta">行号: ${escapeHtml(String(f.lineNumber))}</div>` : ""}
        </div>`;
    }
  }

  html += "</div>";
  area.innerHTML = html;
}

async function handleCheck() {
  const name = document.getElementById("check-name").value.trim();
  if (!name) return;

  const btn = document.getElementById("check-btn");
  setBusy(btn, true);
  setStatus(`正在检查 ${name} ...`);
  try {
    const result = await callEngine("checkPackage", { name });
    renderCheckResult(result);
    setStatus(`检查完成: ${name}`, "success");
  } catch (err) {
    document.getElementById("check-result").innerHTML =
      `<div class="card"><div class="card-title" style="color:var(--md-error)">检查失败</div>${escapeHtml(err.message)}</div>`;
    setStatus(err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function renderSearchResults(results) {
  const area = document.getElementById("search-result");
  if (results.length === 0) {
    area.innerHTML = `<div class="empty">没有找到匹配的包。</div>`;
    return;
  }

  let html = "";
  for (const hit of results) {
    const pkg = hit.package;
    html += `
      <div class="search-item" data-name="${escapeAttr(pkg.name)}">
        <div class="pkg-name">${escapeHtml(pkg.name)}@${escapeHtml(pkg.version)}</div>
        ${pkg.description ? `<div class="pkg-desc">${escapeHtml(pkg.description)}</div>` : ""}
        <div class="pkg-meta">searchScore: ${(hit.searchScore ?? 0).toFixed(2)}</div>
      </div>`;
  }
  area.innerHTML = html;

  area.querySelectorAll(".search-item").forEach((item) => {
    item.addEventListener("click", () => {
      document.querySelector(".nav-item[data-tab='check']").click();
      document.getElementById("check-name").value = item.dataset.name;
      handleCheck();
    });
  });
}

async function handleSearch() {
  const query = document.getElementById("search-query").value.trim();
  if (!query) return;

  const size = parseInt(document.getElementById("search-size").value, 10) || 20;
  const btn = document.getElementById("search-btn");
  setBusy(btn, true);
  setStatus(`正在搜索 ${query} ...`);
  try {
    const results = await callEngine("searchPackages", { query, size });
    renderSearchResults(results);
    setStatus(`搜索完成: ${results.length} 条结果`, "success");
  } catch (err) {
    document.getElementById("search-result").innerHTML =
      `<div class="card"><div class="card-title" style="color:var(--md-error)">搜索失败</div>${escapeHtml(err.message)}</div>`;
    setStatus(err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

async function renderWatchlist() {
  const area = document.getElementById("watch-result");
  try {
    const list = await callEngine("getWatchlist", {});
    if (list.length === 0) {
      area.innerHTML = `<div class="empty">监控列表为空。</div>`;
      return;
    }
    let html = "";
    for (const name of list) {
      html += `
        <div class="list-item">
          <span class="name">${escapeHtml(name)}</span>
          <div class="actions">
            <button class="btn btn-sm" data-refresh="${escapeAttr(name)}">检查</button>
            <button class="btn btn-sm btn-danger" data-remove="${escapeAttr(name)}">移除</button>
          </div>
        </div>`;
    }
    area.innerHTML = html;

    area.querySelectorAll("[data-refresh]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("check-name").value = btn.dataset.refresh;
        document.querySelector(".nav-item[data-tab='check']").click();
        handleCheck();
      });
    });

    area.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await callEngine("removeFromWatchlist", { name: btn.dataset.remove });
          await renderWatchlist();
          setStatus(`已移除 ${btn.dataset.remove}`, "success");
        } catch (err) {
          setStatus(err.message, "error");
        }
      });
    });
  } catch (err) {
    area.innerHTML = `<div class="card"><div class="card-title" style="color:var(--md-error)">加载失败</div>${escapeHtml(err.message)}</div>`;
  }
}

async function handleWatchAdd() {
  const name = document.getElementById("watch-name").value.trim();
  if (!name) return;
  const btn = document.getElementById("watch-add-btn");
  setBusy(btn, true);
  try {
    await callEngine("addToWatchlist", { name });
    document.getElementById("watch-name").value = "";
    document.querySelector("label[for='watch-name']").style.color = "";
    await renderWatchlist();
    setStatus(`已添加 ${name} 到监控列表`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function handleSettingGet() {
  const key = document.getElementById("setting-key").value.trim();
  if (!key) return;
  try {
    const value = await callEngine("getSetting", { key });
    document.getElementById("setting-result").innerHTML =
      `<div class="card"><div class="card-row"><span>${escapeHtml(key)}</span><span class="value">${escapeHtml(value ?? "(未设置)")}</span></div></div>`;
    setStatus(`读取设置: ${key}`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function handleSettingSet() {
  const key = document.getElementById("setting-key").value.trim();
  const value = document.getElementById("setting-value").value;
  if (!key) return;
  try {
    await callEngine("setSetting", { key, value });
    document.getElementById("setting-value").value = "";
    setStatus(`已写入 ${key}`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const SEVERITY_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

let rulesCache = [];

async function renderRules() {
  const list = document.getElementById("rules-list");
  const summary = document.getElementById("rules-summary");
  list.innerHTML = `<div class="loading">正在加载规则...</div>`;
  summary.textContent = "";
  try {
    const rules = await callEngine("listRules", {});
    rulesCache = rules;
    const enabledCount = rules.filter((r) => r.enabled).length;
    summary.textContent = `共 ${rules.length} 条规则，已启用 ${enabledCount} 条`;

    if (rules.length === 0) {
      list.innerHTML = `<div class="empty">没有已注册的规则。</div>`;
      return;
    }

    list.innerHTML = rules
      .map(
        (r) => `
        <div class="card rule-card" data-rule-id="${escapeAttr(r.id)}">
          <div class="rule-header">
            <span class="rule-name">${escapeHtml(r.name)}</span>
            <span class="badge ${r.enabled ? "safe" : "unknown"}">${r.enabled ? "已启用" : "已禁用"}</span>
            <span class="badge ${escapeAttr(r.severity)}">${escapeHtml(SEVERITY_LABELS[r.severity] ?? r.severity)}</span>
            <span class="rule-id">${escapeHtml(r.id)} · ${escapeHtml(r.source)}</span>
          </div>
          <div class="rule-description">${escapeHtml(r.description)}</div>
          <div class="rule-controls">
            <label class="switch-label">
              <input type="checkbox" class="rule-toggle" ${r.enabled ? "checked" : ""} />
              <span class="switch"></span>
              <span class="switch-text">启用</span>
            </label>
            <div class="rule-control">
              <label for="rule-severity-${escapeAttr(r.id)}">严重级别</label>
              <select id="rule-severity-${escapeAttr(r.id)}" class="rule-severity">
                <option value="low" ${r.severity === "low" ? "selected" : ""}>低</option>
                <option value="medium" ${r.severity === "medium" ? "selected" : ""}>中</option>
                <option value="high" ${r.severity === "high" ? "selected" : ""}>高</option>
                <option value="critical" ${r.severity === "critical" ? "selected" : ""}>严重</option>
              </select>
            </div>
          </div>
        </div>`
      )
      .join("");

    list.querySelectorAll(".rule-card").forEach((card) => {
      const ruleId = card.dataset.ruleId;
      const toggle = card.querySelector(".rule-toggle");
      const severity = card.querySelector(".rule-severity");

      toggle.addEventListener("change", async () => {
        try {
          await callEngine("setRuleEnabled", { ruleId, enabled: toggle.checked });
          setStatus(`规则 ${ruleId} ${toggle.checked ? "已启用" : "已禁用"}`, "success");
          await renderRules();
        } catch (err) {
          setStatus(err.message, "error");
          toggle.checked = !toggle.checked;
        }
      });

      severity.addEventListener("change", async () => {
        try {
          await callEngine("setRuleSeverity", { ruleId, severity: severity.value });
          setStatus(`规则 ${ruleId} 严重级别已更新`, "success");
          await renderRules();
        } catch (err) {
          setStatus(err.message, "error");
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="card"><div class="card-title" style="color:var(--md-error)">加载失败</div>${escapeHtml(err.message)}</div>`;
  }
}

async function handleLoadRulePlugins() {
  const btn = document.getElementById("rules-load-btn");
  setBusy(btn, true);
  setStatus("正在加载插件规则...");
  try {
    const count = await callEngine("loadRulePlugins", {});
    await renderRules();
    setStatus(`已加载 ${count} 条插件规则`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

// ---------------------------------------------------------------------------
// LLM configuration
// ---------------------------------------------------------------------------

async function renderLlmConfig() {
  const statusText = document.getElementById("llm-status-text");
  const enabledInput = document.getElementById("llm-enabled");
  const providerInput = document.getElementById("llm-provider");
  const apiKeyInput = document.getElementById("llm-api-key");
  const modelInput = document.getElementById("llm-model");
  const baseUrlInput = document.getElementById("llm-base-url");
  const resultArea = document.getElementById("llm-result");

  try {
    const status = await callEngine("getLlmStatus", {});
    enabledInput.checked = status.enabled;
    providerInput.value = status.provider;
    apiKeyInput.value = "";
    apiKeyInput.placeholder = " ";
    const hint = document.getElementById("llm-api-key-hint");
    if (hint) hint.textContent = status.apiKey ? `已配置 (${status.apiKey})` : "未配置";
    modelInput.value = status.model ?? "";
    baseUrlInput.value = status.baseUrl ?? "";

    const configured = status.configured ? "已配置" : "未配置";
    statusText.innerHTML = `<span class="badge ${status.enabled && status.configured ? "safe" : "unknown"}">${status.enabled ? "已启用" : "已禁用"}</span> ${status.provider} · ${configured}`;
    resultArea.innerHTML = "";
  } catch (err) {
    resultArea.innerHTML = `<div class="card"><div class="card-title" style="color:var(--md-error)">加载失败</div>${escapeHtml(err.message)}</div>`;
  }
}

async function handleLlmSave() {
  const btn = document.getElementById("llm-save-btn");
  setBusy(btn, true);
  setStatus("正在保存 LLM 配置...");
  try {
    const update = {
      enabled: document.getElementById("llm-enabled").checked,
      provider: document.getElementById("llm-provider").value,
      model: document.getElementById("llm-model").value.trim() || undefined,
      baseUrl: document.getElementById("llm-base-url").value.trim() || undefined,
    };
    const apiKey = document.getElementById("llm-api-key").value.trim();
    if (apiKey) update.apiKey = apiKey;
    await callEngine("setLlmConfig", update);
    await renderLlmConfig();
    setStatus("LLM 配置已保存", "success");
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

async function handleLlmTest() {
  const btn = document.getElementById("llm-test-btn");
  setBusy(btn, true);
  setStatus("正在测试 LLM 连接...");
  const resultArea = document.getElementById("llm-result");
  try {
    const ok = await callEngine("testLlmConnection", {});
    if (ok) {
      resultArea.innerHTML = `<div class="card"><div class="card-title" style="color:var(--md-safe)">连接成功</div>LLM 连接测试通过。</div>`;
      setStatus("LLM 连接正常", "success");
    } else {
      resultArea.innerHTML = `<div class="card"><div class="card-title" style="color:var(--md-error)">连接失败</div>未启用或未配置 API 密钥。</div>`;
      setStatus("LLM 连接失败", "error");
    }
  } catch (err) {
    resultArea.innerHTML = `<div class="card"><div class="card-title" style="color:var(--md-error)">连接失败</div>${escapeHtml(err.message)}</div>`;
    setStatus(err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

async function handleLlmReset() {
  document.getElementById("llm-api-key").value = "";
  await renderLlmConfig();
  setStatus("已恢复当前保存的配置", "success");
}

// ---------------------------------------------------------------------------
// Overview Dashboard
// ---------------------------------------------------------------------------

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function levelLabel(level) {
  const map = { safe: "安全", suspicious: "可疑", dangerous: "危险", unknown: "未知" };
  return map[level] ?? level;
}

function setGaugeValue(value, max = 100) {
  const arc = document.getElementById("gauge-arc");
  if (!arc) return;
  const progress = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  arc.style.strokeDasharray = `${progress} 100`;
}

function scoreToColorClass(score) {
  if (score >= 80) return "safe";
  if (score >= 50) return "suspicious";
  return "dangerous";
}

async function renderOverview() {
  try {
    const history = await callEngine("getHistory", {});
    const total = history.length;
    const weeklyCounts = new Array(7).fill(0);
    const now = new Date();
    const weekStart = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    weekStart.setHours(0, 0, 0, 0);

    const riskCounts = { safe: 0, suspicious: 0, dangerous: 0, unknown: 0 };
    let validScoreSum = 0;
    let validScoreCount = 0;
    const recent = history.slice(0, 8);

    for (const h of history) {
      const t = new Date(h.timestamp);
      const dayIndex = Math.floor((t.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
      if (dayIndex >= 0 && dayIndex < 7) weeklyCounts[dayIndex]++;
      riskCounts[h.level] = (riskCounts[h.level] ?? 0) + 1;
      if (typeof h.score === "number") {
        validScoreSum += h.score;
        validScoreCount++;
      }
    }

    const weeklyTotal = weeklyCounts.reduce((a, b) => a + b, 0);
    const avgScore = validScoreCount > 0 ? Math.round(validScoreSum / validScoreCount) : 0;
    const maxCount = Math.max(1, ...weeklyCounts);

    document.getElementById("total-count").textContent = total;
    document.getElementById("weekly-count").textContent = weeklyTotal;
    document.getElementById("risk-safe").textContent = riskCounts.safe;
    document.getElementById("risk-suspicious").textContent = riskCounts.suspicious;
    document.getElementById("risk-dangerous").textContent = riskCounts.dangerous;
    document.getElementById("risk-unknown").textContent = riskCounts.unknown;

    const chart = document.getElementById("weekly-chart");
    chart.innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const bar = document.createElement("div");
      bar.className = "mini-bar";
      bar.style.height = `${(weeklyCounts[i] / maxCount) * 100}%`;
      bar.title = `${weeklyCounts[i]} 次`;
      chart.appendChild(bar);
    }

    const arc = document.getElementById("gauge-arc");
    const value = document.getElementById("gauge-value");
    const label = document.getElementById("gauge-label");
    const summary = document.getElementById("gauge-summary");

    if (validScoreCount > 0) {
      setGaugeValue(avgScore, 100);
      value.textContent = avgScore;
      label.textContent = `平均安全评分 (${validScoreCount} 次检查)`;
      summary.innerHTML = `最近检查平均分为 <span class="badge ${scoreToColorClass(avgScore)}">${avgScore}/100</span>，${levelLabel(scoreToColorClass(avgScore))}`;
    } else {
      setGaugeValue(0, 100);
      value.textContent = "0";
      label.textContent = "等待数据";
      summary.textContent = "暂无检查记录";
    }

    const recentList = document.getElementById("recent-checks");
    if (recent.length === 0) {
      recentList.innerHTML = `<div class="empty">还没有检查过任何包，去「检查」页面试试。</div>`;
      return;
    }
    recentList.innerHTML = recent
      .map(
        (h) => `
        <div class="recent-item" data-name="${escapeAttr(h.packageName)}">
          <div class="recent-item-main">
            <span class="recent-item-name">${escapeHtml(h.packageName)}</span>
            <span class="recent-item-time">${formatDate(h.timestamp)}</span>
          </div>
          <div class="recent-item-score">
            <span class="badge ${escapeAttr(h.level)}">${escapeHtml(levelLabel(h.level))}</span>
            ${typeof h.score === "number" ? `<span>${h.score}/100</span>` : ""}
          </div>
        </div>
      `,
      )
      .join("");

    recentList.querySelectorAll(".recent-item").forEach((item) => {
      item.addEventListener("click", () => {
        document.querySelector(".nav-item[data-tab='check']").click();
        document.getElementById("check-name").value = item.dataset.name;
        handleCheck();
      });
    });
  } catch (err) {
    document.getElementById("recent-checks").innerHTML =
      `<div class="empty">加载仪表盘失败: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

Neutralino.init();

Neutralino.events.on("windowClose", () => {
  Neutralino.app.exit();
});

(async function init() {
  loadTheme();
  initPrefs();
  initTabs();
  initTitleBar();
  registerEngineEvents();
  registerHistoryEvents();
  restoreLastTab();

  document.getElementById("check-btn").addEventListener("click", handleCheck);
  document.getElementById("check-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleCheck();
  });
  document.getElementById("search-btn").addEventListener("click", handleSearch);
  document.getElementById("search-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch();
  });
  document.getElementById("watch-add-btn").addEventListener("click", handleWatchAdd);
  document.getElementById("watch-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleWatchAdd();
  });
  document.getElementById("watch-refresh-btn").addEventListener("click", async () => {
    const btn = document.getElementById("watch-refresh-btn");
    setBusy(btn, true);
    setStatus("正在刷新全部 ...");
    try {
      await callEngine("refreshAll", {});
      await renderWatchlist();
      setStatus("刷新完成", "success");
    } catch (err) {
      setStatus(err.message, "error");
    } finally {
      setBusy(btn, false);
    }
  });
  document.getElementById("setting-get-btn").addEventListener("click", handleSettingGet);
  document.getElementById("setting-set-btn").addEventListener("click", handleSettingSet);

  document.getElementById("rules-load-btn").addEventListener("click", handleLoadRulePlugins);

  document.getElementById("llm-save-btn").addEventListener("click", handleLlmSave);
  document.getElementById("llm-test-btn").addEventListener("click", handleLlmTest);
  document.getElementById("llm-reset-btn").addEventListener("click", handleLlmReset);

  await renderWatchlist();
  await renderOverview();
  setStatus("就绪");
})();
