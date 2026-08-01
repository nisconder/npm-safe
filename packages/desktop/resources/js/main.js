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

function callEngine(method, data) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pending.set(requestId, { resolve, reject });

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
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "处理中..." : btn.dataset.originalText ?? btn.textContent;
  }
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function renderCheckResult(result) {
  const area = document.getElementById("check-result");
  if (!result.exists) {
    area.innerHTML = `<div class="card"><div class="card-title">未找到</div>包 "${result.packageName}" 不存在于 npm 注册表。</div>`;
    return;
  }

  const report = result.security.staticScan;
  const findings = report?.findings ?? [];

  const rows = [
    ["包名", result.packageName],
    ["最新版本", result.latestVersion],
    ["安全等级", `<span class="badge ${result.security.overallLevel}">${result.security.overallLevel}</span>`],
    ["分数", `${result.security.overallScore}/100`],
    ["发现项数量", String(findings.length)],
  ];

  if (result.registryInfo?.description) rows.push(["描述", result.registryInfo.description]);
  if (result.registryInfo?.homepage) rows.push(["主页", result.registryInfo.homepage]);
  if (result.registryInfo?.repository) rows.push(["仓库", result.registryInfo.repository]);

  let html = `<div class="card"><div class="card-title">${result.packageName} 检查结果</div>`;
  for (const [k, v] of rows) {
    html += `<div class="card-row"><span>${k}</span><span class="value">${v}</span></div>`;
  }

  if (findings.length > 0) {
    html += `<div class="card-title" style="margin-top:12px">发现项</div>`;
    for (const f of findings) {
      const sev = f.severity;
      html += `
        <div class="finding ${sev}">
          <div class="finding-header">[${sev.toUpperCase()}] ${f.ruleId} — ${f.ruleName}</div>
          <div class="finding-message">${escapeHtml(f.message)}</div>
          ${f.recommendation ? `<div class="finding-meta">建议: ${escapeHtml(f.recommendation)}</div>` : ""}
          ${f.codeSnippet ? `<div class="finding-meta">片段: ${escapeHtml(f.codeSnippet)}</div>` : ""}
          ${f.lineNumber ? `<div class="finding-meta">行号: ${f.lineNumber}</div>` : ""}
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
      `<div class="card"><div class="card-title" style="color:var(--red)">检查失败</div>${escapeHtml(err.message)}</div>`;
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
      document.querySelector(".tab-btn[data-tab='check']").click();
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
      `<div class="card"><div class="card-title" style="color:var(--red)">搜索失败</div>${escapeHtml(err.message)}</div>`;
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
        document.querySelector(".tab-btn[data-tab='check']").click();
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
    area.innerHTML = `<div class="card"><div class="card-title" style="color:var(--red)">加载失败</div>${escapeHtml(err.message)}</div>`;
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
  initTabs();
  registerEngineEvents();

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
  document.getElementById("watch-refresh-btn").addEventListener("click", renderWatchlist);
  document.getElementById("setting-get-btn").addEventListener("click", handleSettingGet);
  document.getElementById("setting-set-btn").addEventListener("click", handleSettingSet);

  await renderWatchlist();
  setStatus("就绪");
})();
