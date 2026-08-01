const views = ["overview", "watchlist", "reports", "settings"];
const titles = { overview: "总览", watchlist: "监控列表", reports: "扫描报告", settings: "设置" };
const packages = [
  ["lodash", "4.17.21", "98", "安全", "safe"],
  ["axios", "1.7.2", "64", "需关注", "warn"],
  ["react", "18.3.1", "96", "安全", "safe"],
  ["event-stream", "4.0.1", "12", "高风险", "danger"]
];
const toast = document.querySelector("#toast");
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setView(view) {
  views.forEach((name) => document.querySelector(`#${name}View`).classList.toggle("hidden", name !== view));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelector("#pageTitle").textContent = titles[view];
  if (view === "watchlist") renderWatchlist();
}

function renderWatchlist(filter = "") {
  const target = document.querySelector("#watchRows");
  const filtered = packages.filter(([name]) => name.includes(filter.toLowerCase()));
  target.innerHTML = filtered.map(([name, version, score, status, kind]) => `
    <div class="watch-row">
      <span class="package-name"><i class="pkg-icon ${kind === "danger" ? "red" : kind === "warn" ? "orange" : "blue"}">${name[0].toUpperCase()}</i><b>${name}</b></span>
      <span>${version}</span><span class="score ${kind === "warn" ? "warn-score" : kind === "danger" ? "danger-score" : ""}">${score} <small>/ 100</small></span>
      <span>今天</span><span class="badge ${kind === "safe" ? "safe-badge" : kind === "warn" ? "warn-badge" : "danger-badge"}">${status}</span>
    </div>`).join("") || `<div class="report-empty"><h2>没有匹配的包</h2><p>尝试搜索其他包名。</p></div>`;
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-view-link]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewLink)));
document.querySelector("#packageSearch").addEventListener("input", (event) => renderWatchlist(event.target.value));
document.querySelector("#themeButton").addEventListener("click", () => {
  document.body.classList.toggle("light-mode");
  showToast(document.body.classList.contains("light-mode") ? "已切换到浅色主题" : "已切换到深色主题");
});
document.querySelector("#scanButton").addEventListener("click", () => document.querySelector("#scanDialog").showModal());
document.querySelector("#reportScanButton").addEventListener("click", () => document.querySelector("#scanDialog").showModal());
document.querySelector("#addPackageButton").addEventListener("click", () => document.querySelector("#scanDialog").showModal());
document.querySelector("#runScan").addEventListener("click", (event) => {
  const input = document.querySelector("#scanInput");
  if (!input.value.trim()) {
    event.preventDefault();
    showToast("请输入包名");
    input.focus();
    return;
  }
  showToast(`已开始扫描 ${input.value.trim()}`);
  input.value = "";
});
document.querySelector("#saveSettings").addEventListener("click", () => showToast("设置已保存"));
document.querySelector("#profileButton").addEventListener("click", () => showToast("当前为本地工作区"));
document.querySelectorAll(".setting-tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".setting-tab").forEach((item) => item.classList.remove("active"));
  tab.classList.add("active");
  showToast(`${tab.textContent}设置已加载`);
}));
renderWatchlist();
