import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../desktop/resources/js/window-controls.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../../desktop/resources/index.html", import.meta.url), "utf8");

type Handler = (event?: any) => unknown;

function shell(initiallyMaximized = false, os = "Windows", nativeFrame = false) {
  let maximized = initiallyMaximized;
  let failing = "";
  let sizingBarrier: Promise<void> | undefined;
  let reportSizing: () => void = () => {};
  const sizingStarted = new Promise<void>((resolve) => { reportSizing = resolve; });
  const calls: string[] = [];
  const sizeUpdates: Record<string, unknown>[] = [];
  const warnings: unknown[] = [];
  const nativeEvents = new Map<string, Handler[]>();
  const domEvents = new Map<string, Handler[]>();
  const classes = new Set<string>(nativeFrame ? ["window-native"] : []);
  const elements: Record<string, any> = {};
  for (const id of ["title-bar-drag", "window-maximize", "window-minimize", "window-close"]) {
    const handlers = new Map<string, Handler[]>();
    elements[id] = {
      attributes: new Map<string, string>(),
      disabled: false,
      addEventListener(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      setAttribute(name: string, value: string) { this.attributes.set(name, value); },
      async emit(event: string, value?: unknown) {
        await Promise.all((handlers.get(event) ?? []).map((handler) => handler(value)));
      },
    };
  }
  async function operation(name: string) {
    calls.push(name);
    if (failing === name) throw new Error(`${name} failed`);
  }
  const context = vm.createContext({
    NL_OS: os,
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    document: {
      documentElement: {
        classList: {
          contains: (name: string) => classes.has(name),
          toggle(name: string, on: boolean) { on ? classes.add(name) : classes.delete(name); },
        },
      },
      getElementById: (id: string) => elements[id],
    },
    addEventListener(event: string, handler: Handler) {
      domEvents.set(event, [...(domEvents.get(event) ?? []), handler]);
    },
    Neutralino: {
      window: {
        setSize: async (options: Record<string, unknown>) => {
          sizeUpdates.push(JSON.parse(JSON.stringify(options)));
          reportSizing();
          await operation("setSize");
          await sizingBarrier;
        },
        isMaximized: async () => { await operation("isMaximized"); return maximized; },
        maximize: async () => { await operation("maximize"); maximized = true; },
        unmaximize: async () => { await operation("unmaximize"); maximized = false; },
        minimize: () => operation("minimize"),
        setDraggableRegion: (id: string) => operation(`drag:${id}`),
      },
      app: { exit: () => operation("exit") },
      events: {
        on: async (event: string, handler: Handler) => {
          nativeEvents.set(event, [...(nativeEvents.get(event) ?? []), handler]);
        },
      },
    },
  });
  vm.runInContext(source, context);
  return {
    calls, sizeUpdates, warnings, classes, elements, sizingStarted, nativeEvents, domEvents,
    init: () => vm.runInContext("NpmSafeWindowControls.init()", context) as Promise<void>,
    externalState: (value: boolean) => { maximized = value; },
    fail: (name: string) => { failing = name; },
    deferSizing: (barrier: Promise<void>) => { sizingBarrier = barrier; },
    native: async (event: string) => { await Promise.all((nativeEvents.get(event) ?? []).map((handler) => handler())); },
    resize: async () => { await Promise.all((domEvents.get("resize") ?? []).map((handler) => handler())); },
  };
}

describe("desktop native window controls", () => {
  it("delegates the default system frame to the OS without native API or event registrations", async () => {
    const app = shell(false, "Windows", true);
    await Promise.all([app.init(), app.init()]);
    await app.native("ready");
    await app.native("windowFocus");
    await app.resize();
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.sizeUpdates, []);
    assert.equal(app.nativeEvents.size, 0);
    assert.equal(app.domEvents.size, 0);
    assert.deepEqual(app.warnings, []);
  });

  it("does not intercept toolbar clicks or double clicks when the OS owns window controls", async () => {
    for (const os of ["Windows", "Linux", "Darwin"]) {
      const app = shell(false, os, true);
      await app.init();
      let prevented = false;
      await app.elements["title-bar-drag"].emit("dblclick", {
        button: 0,
        preventDefault: () => { prevented = true; },
      });
      for (const id of ["window-minimize", "window-maximize", "window-close"]) {
        await app.elements[id].emit("click");
      }
      assert.equal(prevented, false, os);
      assert.deepEqual(app.calls, [], os);
      assert.equal(app.classes.has("window-maximized"), false, os);
    }
  });

  it("restores native Windows edge resizing before reading the window state", async () => {
    const app = shell(false, "Windows");
    await app.init();
    assert.deepEqual(app.sizeUpdates, [{ resizable: true }]);
    assert.ok(app.calls.indexOf("setSize") < app.calls.indexOf("isMaximized"));
  });

  it("leaves non-Windows native window styles alone", async () => {
    for (const os of ["Linux", "Darwin"]) {
      const app = shell(false, os);
      await app.init();
      await app.elements["window-maximize"].emit("click");
      assert.deepEqual(app.sizeUpdates, [], os);
      assert.equal(app.classes.has("window-maximized"), true, os);
    }
  });

  it("does not reapply resizing on repeated init, ready, focus, or resize events", async () => {
    const app = shell();
    await Promise.all([app.init(), app.init()]);
    await Promise.all([app.native("ready"), app.native("windowFocus"), app.resize()]);
    await app.init();
    await app.elements["window-maximize"].emit("click");
    await app.elements["window-maximize"].emit("click");
    assert.deepEqual(app.sizeUpdates, [{ resizable: true }]);
  });

  it("shares pending Windows resize restoration with maximize", async () => {
    const app = shell();
    let releaseSizing: () => void = () => {};
    app.deferSizing(new Promise<void>((resolve) => { releaseSizing = resolve; }));
    const initialized = app.init();
    await app.sizingStarted;
    const maximized = app.elements["window-maximize"].emit("click");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(app.calls.includes("maximize"), false);
    assert.deepEqual(app.sizeUpdates, [{ resizable: true }]);
    releaseSizing();
    await Promise.all([initialized, maximized]);
    assert.equal(app.classes.has("window-maximized"), true);
    assert.deepEqual(app.sizeUpdates, [{ resizable: true }]);
  });

  it("retries failed resize restoration on ready or focus and preserves window controls", async () => {
    for (const event of ["ready", "windowFocus"]) {
      const app = shell();
      app.fail("setSize");
      await app.init();
      assert.equal(app.sizeUpdates.length, 1, event);
      assert.equal(app.warnings.length, 1, event);
      app.fail("");
      await app.native(event);
      assert.deepEqual(app.sizeUpdates, [{ resizable: true }, { resizable: true }], event);
      await app.elements["window-maximize"].emit("click");
      assert.equal(app.classes.has("window-maximized"), true, event);
      await app.elements["window-maximize"].emit("click");
      assert.equal(app.classes.has("window-maximized"), false, event);
      await app.elements["window-minimize"].emit("click");
      await app.elements["window-close"].emit("click");
      assert.ok(app.calls.includes("minimize"), event);
      assert.ok(app.calls.includes("exit"), event);
      assert.equal(app.sizeUpdates.length, 2, event);
    }
  });

  it("initializes once and keeps the draggable region separate from buttons", async () => {
    const app = shell();
    await Promise.all([app.init(), app.init()]);
    assert.deepEqual(app.calls.filter((call) => call.startsWith("drag:")), ["drag:title-bar-drag"]);
    const dragMarkup = markup.match(/<div class="title-bar-drag"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    assert.ok(dragMarkup);
    assert.doesNotMatch(dragMarkup, /<button\b/);
    await app.elements["window-maximize"].emit("click");
    assert.equal(app.calls.filter((call) => call === "maximize").length, 1);
  });

  it("maximizes and restores with accurate accessible labels and frame state", async () => {
    const app = shell();
    await app.init();
    const button = app.elements["window-maximize"];
    assert.equal(button.title, "最大化");
    assert.equal(button.attributes.get("aria-pressed"), "false");
    await button.emit("click");
    assert.equal(app.classes.has("window-maximized"), true);
    assert.equal(button.title, "还原窗口");
    assert.equal(button.attributes.get("aria-label"), "还原窗口");
    assert.equal(button.attributes.get("aria-pressed"), "true");
    await button.emit("click");
    assert.equal(app.classes.has("window-maximized"), false);
    assert.equal(button.attributes.get("aria-label"), "最大化");
    assert.equal(button.disabled, false);
    assert.deepEqual(app.calls.filter((call) => ["maximize", "unmaximize"].includes(call)), ["maximize", "unmaximize"]);
  });

  it("uses the current native state after OS maximize, restore, and resize", async () => {
    const app = shell(true);
    await app.init();
    assert.equal(app.classes.has("window-maximized"), true);
    app.externalState(false);
    await app.resize();
    assert.equal(app.classes.has("window-maximized"), false);
    app.externalState(true);
    await app.native("windowMaximize");
    assert.equal(app.classes.has("window-maximized"), true);
    app.externalState(false);
    await app.native("windowRestore");
    assert.equal(app.classes.has("window-maximized"), false);
  });

  it("supports title-bar double click and preserves minimize and close", async () => {
    const app = shell();
    await app.init();
    let prevented = false;
    await app.elements["title-bar-drag"].emit("dblclick", {
      button: 0,
      preventDefault: () => { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.equal(app.classes.has("window-maximized"), true);
    await app.elements["window-minimize"].emit("click");
    await app.elements["window-close"].emit("click");
    assert.ok(app.calls.includes("minimize"));
    assert.ok(app.calls.includes("exit"));
  });

  it("handles failed native actions and allows a subsequent retry", async () => {
    const app = shell();
    app.fail("isMaximized");
    await app.init();
    assert.equal(app.warnings.length, 1);
    app.fail("maximize");
    await app.elements["window-maximize"].emit("click");
    assert.equal(app.elements["window-maximize"].disabled, false);
    assert.equal(app.classes.has("window-maximized"), false);
    app.fail("");
    await app.elements["window-maximize"].emit("click");
    assert.equal(app.classes.has("window-maximized"), true);
    app.fail("minimize");
    await app.elements["window-minimize"].emit("click");
    app.fail("exit");
    await app.elements["window-close"].emit("click");
    assert.equal(app.warnings.length, 4);
  });
});
