import "./window-chrome.css";

/**
 * The desktop shell draws no caption bar, so the archive header doubles as the title bar:
 * a slim strip that drags the window, plus minimise / maximise / close controls that speak
 * to the WebView2 host over postMessage. In a plain browser none of this is injected.
 */

interface WebViewBridge {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

const bridge = (): WebViewBridge | undefined =>
  (window as unknown as { chrome?: { webview?: WebViewBridge } }).chrome?.webview;

const ICONS = {
  minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>',
  maximize: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" /></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="8" width="10" height="10" /><path d="M9 8V5h10v10h-3" /></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>',
};

const DRAG_BAND = 74;
const CAPTION_BAND = 34;
const RESIZE_MARGIN = 7;
const RESIZE_ZONES: Array<[string, (x: number, y: number, w: number, h: number) => boolean]> = [
  ["topleft", (x, y) => x < RESIZE_MARGIN && y < RESIZE_MARGIN],
  ["topright", (x, y, w) => x >= w - RESIZE_MARGIN && y < RESIZE_MARGIN],
  ["bottomleft", (x, y, w, h) => x < RESIZE_MARGIN && y >= h - RESIZE_MARGIN],
  ["bottomright", (x, y, w, h) => x >= w - RESIZE_MARGIN && y >= h - RESIZE_MARGIN],
  ["left", (x) => x < RESIZE_MARGIN],
  ["right", (x, _y, w) => x >= w - RESIZE_MARGIN],
  ["top", (_x, y) => y < RESIZE_MARGIN],
  ["bottom", (_x, y, _w, h) => y >= h - RESIZE_MARGIN],
];

function resizeZone(x: number, y: number) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return RESIZE_ZONES.find(([, matches]) => matches(x, y, width, height))?.[0];
}

export function setupWindowChrome(): boolean {
  const webview = bridge();
  if (!webview) return false;
  const stage = document.querySelector<HTMLElement>("#stage");
  if (!stage) return false;

  const controls = document.createElement("div");
  controls.className = "window-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "窗口控制");
  controls.innerHTML = `
    <button type="button" data-window-action="minimize" aria-label="最小化" title="最小化">${ICONS.minimize}</button>
    <button type="button" data-window-action="toggle" aria-label="最大化" title="最大化">${ICONS.maximize}</button>
    <button type="button" data-window-action="close" aria-label="关闭" title="关闭">${ICONS.close}</button>`;
  stage.append(controls);

  const toggleButton = controls.querySelector<HTMLButtonElement>('[data-window-action="toggle"]')!;
  const setMaximized = (maximized: boolean) => {
    stage.classList.toggle("window-maximized", maximized);
    toggleButton.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
    toggleButton.setAttribute("aria-label", maximized ? "还原" : "最大化");
    toggleButton.title = maximized ? "还原" : "最大化";
  };
  const setFullscreen = (value: boolean) => {
    if (value) document.documentElement.dataset.windowFullscreen = "1";
    else delete document.documentElement.dataset.windowFullscreen;
    stage.classList.toggle("window-fullscreen", value);
    // Player surfaces listen for this so their own fullscreen control can follow along.
    document.dispatchEvent(new CustomEvent("rhine:window-state", { detail: { fullscreen: value } }));
  };

  controls.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-window-action]")?.dataset.windowAction;
    if (!action) return;
    event.stopPropagation();
    webview.postMessage(`window:${action}`);
  });

  webview.addEventListener("message", (event) => {
    if (event.data === "state:maximized") {
      setFullscreen(false);
      setMaximized(true);
    } else if (event.data === "state:normal") {
      setFullscreen(false);
      setMaximized(false);
    } else if (event.data === "state:fullscreen") {
      setFullscreen(true);
    }
    // The host hands over files opened from Explorer while this window is already running.
    else if (typeof event.data === "string" && event.data.startsWith("open:")) {
      document.dispatchEvent(new CustomEvent("rhine:open-file", { detail: event.data.slice(5) }));
    }
  });

  /** True full screen (no frame, no taskbar) is owned by the host, not the page. */
  (window as unknown as { rhineWindowFullscreen?: () => boolean }).rhineWindowFullscreen = () =>
    document.documentElement.dataset.windowFullscreen === "1";

  const draggable = (target: HTMLElement | null) =>
    !!target && !target.closest("button, a, input, select, textarea, label, [data-window-nodrag]");

  // The caption strip stays draggable in every view; the wider header band only when no
  // overlay owns the screen, so panel interactions never move the window by accident.
  const overlayOpen = () =>
    !!document.querySelector(".video-archive:not([hidden]), .music-panel-scrim:not([hidden])");
  const bandHeight = () => (overlayOpen() ? CAPTION_BAND : DRAG_BAND);

  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    // Window edges resize: the child view owns the pointer, so the request travels to the host.
    const zone = resizeZone(event.clientX, event.clientY);
    if (zone && !stage.classList.contains("window-maximized")) {
      webview.postMessage(`window:resize:${zone}`);
      return;
    }
    if (event.clientY > bandHeight()) return;
    if (!draggable(event.target as HTMLElement)) return;
    webview.postMessage("window:drag");
  }, true);
  document.addEventListener("dblclick", (event) => {
    if (event.clientY > bandHeight()) return;
    if (!draggable(event.target as HTMLElement)) return;
    webview.postMessage("window:toggle");
  });

  document.documentElement.classList.add("window-chrome");
  webview.postMessage("window:state");
  return true;
}
