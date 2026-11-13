/* Optional controls for the custom borderless shell; system frames need none. */
(() => {
  let initialization;

  function init() {
    if (initialization) return initialization;
    const root = document.documentElement;
    if (root.classList.contains("window-native")) {
      initialization = Promise.resolve();
      return initialization;
    }
    const native = globalThis.Neutralino;
    if (!native?.window) return Promise.resolve();

    const drag = document.getElementById("title-bar-drag");
    const maximize = document.getElementById("window-maximize");
    const minimize = document.getElementById("window-minimize");
    const close = document.getElementById("window-close");
    let stateRequest = 0;
    let changingState = false;
    let resizeSetup;

    // DOM event handlers must also handle rejected native API promises.
    const run = (action) => Promise.resolve().then(action).catch((error) => {
      console.warn("Window control failed:", error?.message ?? String(error));
    });

    function ensureResizable() {
      if (globalThis.NL_OS !== "Windows") return Promise.resolve();
      // Neutralino 6.9 applies borderless after resizable at startup. On
      // Windows that removes WS_THICKFRAME, including native edge resizing.
      // The client merges this with the current dimensions and size limits.
      if (!resizeSetup) {
        resizeSetup = Promise.resolve()
          .then(() => native.window.setSize({ resizable: true }))
          .catch((error) => {
            resizeSetup = undefined;
            throw error;
          });
      }
      return resizeSetup;
    }

    function render(maximized) {
      root.classList.toggle("window-maximized", maximized);
      if (!maximize) return;
      const label = maximized ? "还原窗口" : "最大化";
      maximize.title = label;
      maximize.setAttribute("aria-label", label);
      maximize.setAttribute("aria-pressed", String(maximized));
    }

    async function syncState() {
      const request = ++stateRequest;
      const maximized = await native.window.isMaximized();
      // A slower, earlier query must not overwrite a newer window state.
      if (request === stateRequest) render(Boolean(maximized));
    }

    async function toggleMaximized() {
      if (changingState) return;
      changingState = true;
      if (maximize) maximize.disabled = true;
      ++stateRequest;
      try {
        await ensureResizable();
        const maximized = await native.window.isMaximized();
        if (maximized) await native.window.unmaximize();
        else await native.window.maximize();
        await syncState();
      } finally {
        changingState = false;
        if (maximize) maximize.disabled = false;
      }
    }

    maximize?.addEventListener("click", () => run(toggleMaximized));
    drag?.addEventListener("dblclick", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      return run(toggleMaximized);
    });
    minimize?.addEventListener("click", () => run(() => native.window.minimize()));
    close?.addEventListener("click", () => run(() => native.app.exit()));

    const refreshState = () => run(async () => {
      await ensureResizable();
      await syncState();
    });
    // Resizing also catches restores initiated by the OS, which does not emit
    // a separate windowUnmaximize event on every supported platform.
    globalThis.addEventListener("resize", refreshState);
    const setup = [
      run(() => native.window.setDraggableRegion("title-bar-drag")),
      refreshState(),
    ];
    for (const event of ["ready", "windowMaximize", "windowRestore", "windowFocus"]) {
      setup.push(run(() => native.events.on(event, refreshState)));
    }
    initialization = Promise.all(setup).then(() => undefined);
    return initialization;
  }

  globalThis.NpmSafeWindowControls = { init };
})();
