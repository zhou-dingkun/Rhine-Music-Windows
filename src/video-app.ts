import "./video.css";
import { escapeHtml as esc } from "./html";

/**
 * Local video archive and player. Video files are streamed from the local music service with
 * HTTP Range support, so seeking never copies a file. Playback follows the local video player
 * conventions users already know: single click pauses, double click goes fullscreen, and holding
 * the right arrow key fast-forwards at 3x until the key is released.
 */

interface VideoItem {
  id: string;
  title: string;
  fileName: string;
  folder: string;
  relativePath: string;
  size: number;
  mtime: string;
  duration: number | null;
  container?: string | null;
  codec: string | null;
  videoCodec?: string | null;
  width: number | null;
  height: number | null;
  fps?: number | null;
  audioCodec?: string | null;
  audioChannels?: number | null;
  audioSampleRate?: number | null;
  bitrate?: number | null;
  extension: string;
  hasPoster: boolean;
  external?: boolean;
}

interface SubtitleTrack {
  index: number;
  name: string;
  label: string;
  format: string;
}

interface VideoRoot {
  path: string;
  status: string;
  error?: string;
}

interface VideoSnapshot {
  version: number;
  scanning: boolean;
  startedAt?: string;
  error?: string;
  scannedAt: string | null;
  roots: VideoRoot[];
  videos: VideoItem[];
}

export interface VideoArchiveOptions {
  notify?: (message: string) => void;
}

export interface VideoArchive {
  open(): void;
  close(): void;
  /** Opens a file handed over by the shell (Explorer "打开方式"). */
  openExternal(item: VideoItem): void;
}

const STORAGE_KEY = "rhine-video-preferences";
const POSITION_KEY = "rhine-video-positions";
const POSTER_KEY = "rhine-video-thumbnails";
/** A one-pixel transparent GIF keeps the card layout while a thumbnail is captured. */
const BLANK_THUMB = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const HOLD_DELAY = 320;
const TAP_SEEK = 5;
const FAST_RATE = 3;
const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, FAST_RATE];
const EMPTY_SNAPSHOT: VideoSnapshot = { version: 1, scanning: false, scannedAt: null, roots: [], videos: [] };

const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  film: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 12h18M3 8h4M3 16h4M17 8h4M17 16h4"/>'),
  play: svg('<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  prev: svg('<path d="M18 6v12L9 12zM6 5v14"/>'),
  next: svg('<path d="M6 6v12l9-6zM18 5v14"/>'),
  volume: svg('<path d="M4 9h3l4-3v12l-4-3H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18 7a7 7 0 0 1 0 10"/>'),
  muted: svg('<path d="M4 9h3l4-3v12l-4-3H4z"/><path d="m16 10 4 4M20 10l-4 4"/>'),
  web: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>'),
  expand: svg('<path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/>'),
  collapse: svg('<path d="M9 4v5H4M15 20v-5h5M15 4v5h5M9 20v-5H4"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  list: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  subtitles: svg('<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M6.5 14h5M14 14h3.5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.9"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  check: svg('<path d="m5 13 4 4 10-10"/>'),
  scan: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
};

function clock(value: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function fileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const rateLabel = (value: number) => `${Number(value.toFixed(2))}×`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is optional: a full or blocked quota must never break playback.
  }
}

/**
 * Panel motion for the video surfaces. Same easing family as the archive's SurfaceTransition,
 * plus a small scale so a dialog visibly settles instead of blinking into place.
 */
class PanelMotion {
  private animations: Animation[] = [];
  private revision = 0;

  constructor(
    private root: HTMLElement,
    private panel: HTMLElement,
    private enterDuration = 460,
    private exitDuration = 220,
  ) {}

  show(reduced: boolean) {
    this.run(true, reduced);
  }

  hide(reduced: boolean) {
    this.run(false, reduced);
  }

  private run(show: boolean, reduced: boolean) {
    const revision = ++this.revision;
    const wasHidden = this.root.hidden;
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
    this.root.hidden = false;
    this.root.dataset.transition = show ? "opening" : "closing";
    const complete = () => {
      if (revision !== this.revision) return;
      this.root.hidden = !show;
      this.root.dataset.transition = show ? "open" : "closed";
      this.animations.forEach((animation) => animation.cancel());
      this.animations = [];
    };
    if (reduced || (!show && wasHidden)) {
      complete();
      return;
    }
    const options: KeyframeAnimationOptions = {
      duration: show ? this.enterDuration : this.exitDuration,
      easing: show ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.4, 0, 1, 1)",
      fill: "both",
    };
    this.animations.push(
      this.root.animate([{ opacity: wasHidden ? 0 : 1 }, { opacity: show ? 1 : 0 }], options),
      this.panel.animate(
        show
          ? [
              { transform: "translateY(26px) scale(0.982)" },
              { transform: "translateY(0) scale(1)" },
            ]
          : [
              { transform: "translateY(0) scale(1)" },
              { transform: "translateY(14px) scale(0.99)" },
            ],
        options,
      ),
    );
    void Promise.all(this.animations.map((animation) => animation.finished)).then(complete).catch(() => {});
  }
}

class VideoArchiveController implements VideoArchive {
  private readonly topnav: HTMLElement;
  private readonly notify: (message: string) => void;
  private readonly root: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly browser: HTMLElement;
  private readonly theater: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly countLabel: HTMLElement;
  private readonly rootsLabel: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly playlistBody: HTMLElement;
  private readonly playlistCount: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly spinner: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressTip: HTMLElement;
  private readonly playedBar: HTMLElement;
  private readonly bufferBar: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly currentLabel: HTMLElement;
  private readonly durationLabel: HTMLElement;
  private readonly titleLabel: HTMLElement;
  private readonly subtitleLabel: HTMLElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly rateButton: HTMLButtonElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly webFullscreenButton: HTMLButtonElement;
  private readonly playlistPanel: HTMLElement;
  private readonly rateMenu: HTMLElement;
  private readonly subtitleButton: HTMLButtonElement;
  private readonly subtitleMenu: HTMLElement;
  private readonly infoPanel: HTMLElement;
  private readonly infoBody: HTMLElement;
  private readonly infoStatus: HTMLElement;
  private readonly surface: HTMLElement;
  private archiveMotion!: PanelMotion;
  private theaterMotion!: PanelMotion;
  private frameTimer = 0;
  private snapshot: VideoSnapshot = EMPTY_SNAPSHOT;
  /** Files opened from the shell, listed ahead of the scanned library for this session. */
  private externals: VideoItem[] = [];
  /** Curated playlist served by /api/video-playlist; falls back to the whole library when empty. */
  private playlist: VideoItem[] = [];
  private playlistMissing = 0;
  private posterCache: Record<string, string> = readJson(POSTER_KEY, {});
  private posterQueue: VideoItem[] = [];
  private posterBusy = false;
  private subtitleTracks: SubtitleTrack[] = [];
  private subtitleMode = -1;
  private subtitleToken = 0;
  private currentId: string | null = null;
  private rate = 1;
  private volume = 1;
  private muted = false;
  private filter = "";
  private opened = false;
  private theaterOpen = false;
  private webFullscreen = false;
  private playlistBeforeFullscreen = true;
  private scrubbing = false;
  private holdTimer = 0;
  private holdMode: "none" | "forward" | "rewind" = "none";
  private rewindFrame = 0;
  private rewindLast = 0;
  private rewindWasPlaying = false;
  private idleTimer = 0;
  private hudTimer = 0;
  private pollTimer = 0;
  private clickTimer = 0;
  private saveClock = 0;
  private pointerHold: { ratio: number; x: number; y: number; timer: number } | null = null;
  private holdDirection: "forward" | "rewind" | null = null;
  private positions: Record<string, number> = readJson(POSITION_KEY, {});

  constructor(topnav: HTMLElement, notify: (message: string) => void) {
    this.topnav = topnav;
    this.notify = notify;
    const preferences = readJson(STORAGE_KEY, { volume: 1, muted: false, rate: 1, playlist: true });
    this.volume = Math.min(1, Math.max(0, preferences.volume ?? 1));
    this.muted = !!preferences.muted;
    this.rate = RATE_PRESETS.includes(preferences.rate) ? preferences.rate : 1;
    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.dataset.action = "videos";
    launcher.setAttribute("aria-label", "视频档案");
    launcher.innerHTML = `${icons.film}<span>视频</span>`;
    const settings = topnav.querySelector('[data-action="settings"]');
    topnav.insertBefore(launcher, settings);
    launcher.addEventListener("click", () => this.open());

    this.root = document.createElement("div");
    this.root.className = "video-archive";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="video-veil" data-video-close></div>
      <section class="video-browser" aria-label="本地视频">
        <header class="video-browser-head">
          <div class="video-browser-copy">
            <small class="video-browser-eyebrow">VIDEO ARCHIVE ／ 本机视频</small>
            <h2>视频档案</h2>
            <p class="video-browser-meta" id="video-meta">正在读取本地视频索引</p>
          </div>
          <div class="video-browser-actions">
            <input id="video-filter" type="search" placeholder="筛选标题或目录" aria-label="筛选视频" autocomplete="off" />
            <button type="button" data-video-action="scan">${icons.scan}<span>重新扫描</span></button>
            <button type="button" data-video-action="close" class="video-close" aria-label="关闭视频档案">×</button>
          </div>
        </header>
        <div class="video-grid" id="video-grid"></div>
        <div class="video-empty" id="video-empty" hidden></div>
        <span class="video-hud-frame" aria-hidden="true"></span>
        <footer class="video-browser-foot">
          <span>LOCAL VIDEO <i>·</i> <span id="video-count">0 FILES</span></span>
          <span id="video-roots"></span>
        </footer>
      </section>
      <section class="video-theater" id="video-theater" aria-label="视频播放器" hidden>
        <div class="video-surface" id="video-surface">
          <video id="video-element" class="video-element" playsinline preload="metadata"></video>
          <div class="video-spinner" id="video-spinner" hidden><span class="loading-orbit"></span></div>
          <span class="video-reticle" aria-hidden="true"></span>
          <div class="video-hud" id="video-hud" role="status" aria-live="polite" hidden></div>
          <div class="video-topbar">
            <button type="button" data-video-action="browser" aria-label="返回视频列表">← 视频列表</button>
            <div class="video-heading"><strong id="video-title">—</strong><small id="video-subtitle"></small></div>
            <div class="video-topbar-tools">
              <button type="button" data-video-action="info" aria-label="视频信息" title="视频信息">${icons.info}</button>
              <button type="button" data-video-action="prev" aria-label="上一个视频">${icons.prev}</button>
              <button type="button" data-video-action="next" aria-label="下一个视频">${icons.next}</button>
              <button type="button" data-video-action="playlist" id="video-playlist-toggle" aria-pressed="true" aria-label="播放列表">${icons.list}</button>
              <button type="button" data-video-action="close" aria-label="关闭播放器">${icons.close}</button>
            </div>
          </div>
          <div class="video-controls" id="video-controls">
            <button type="button" class="video-icon" id="video-toggle" data-video-action="toggle" aria-label="播放">${icons.play}</button>
            <span class="video-clock"><b id="video-current">0:00</b> / <span id="video-duration">0:00</span></span>
            <div class="video-progress" id="video-progress" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div class="video-progress-track">
                <div class="video-progress-buffer" id="video-buffer"></div>
                <div class="video-progress-played" id="video-played"></div>
                <i class="video-progress-thumb" id="video-thumb"></i>
              </div>
              <span class="video-progress-tip" id="video-tip" hidden>0:00</span>
            </div>
            <div class="video-volume">
              <button type="button" id="video-mute" data-video-action="mute" aria-label="静音">${icons.volume}</button>
              <input type="range" id="video-volume" min="0" max="1" step="0.01" value="1" aria-label="音量" />
            </div>
            <button type="button" id="video-rate" data-video-action="rate" aria-label="播放速度">1.0×</button>
            <button type="button" id="video-subtitles" data-video-action="subtitles" aria-label="字幕">${icons.subtitles}</button>
            <button type="button" id="video-webfull" data-video-action="web-fullscreen" aria-label="网页全屏">${icons.web}</button>
            <button type="button" id="video-fullscreen" data-video-action="fullscreen" aria-label="全屏">${icons.expand}</button>
            <div class="video-menu" id="video-rate-menu" hidden></div>
            <div class="video-menu" id="video-subtitle-menu" hidden></div>
          </div>
        </div>
        <aside class="video-playlist" id="video-playlist">
          <header><strong>播放列表</strong><span id="video-playlist-count"></span></header>
          <div class="video-playlist-tools">
            <button type="button" data-video-action="playlist-fill">全部加入</button>
            <button type="button" data-video-action="playlist-clear">清空</button>
          </div>
          <div class="video-playlist-body" id="video-playlist-body"></div>
        </aside>
        <aside class="video-info" id="video-info" aria-label="视频信息" hidden>
          <header><strong>视频信息</strong><button type="button" data-video-action="info" aria-label="关闭视频信息">×</button></header>
          <div class="video-info-body" id="video-info-body"></div>
          <footer>
            <button type="button" data-video-action="copy-info">复制信息</button>
            <span id="video-info-status" role="status" aria-live="polite"></span>
          </footer>
        </aside>
      </section>`;
    (document.querySelector("#stage") ?? document.body).append(this.root);

    const pick = <T extends HTMLElement>(selector: string) => this.root.querySelector<T>(selector)!;
    this.browser = pick(".video-browser");
    this.theater = pick("#video-theater");
    this.grid = pick("#video-grid");
    this.empty = pick("#video-empty");
    this.meta = pick("#video-meta");
    this.countLabel = pick("#video-count");
    this.rootsLabel = pick("#video-roots");
    this.filterInput = pick<HTMLInputElement>("#video-filter");
    this.playlistBody = pick("#video-playlist-body");
    this.playlistCount = pick("#video-playlist-count");
    this.hud = pick("#video-hud");
    this.spinner = pick("#video-spinner");
    this.progress = pick("#video-progress");
    this.progressTip = pick("#video-tip");
    this.playedBar = pick("#video-played");
    this.bufferBar = pick("#video-buffer");
    this.thumb = pick("#video-thumb");
    this.currentLabel = pick("#video-current");
    this.durationLabel = pick("#video-duration");
    this.titleLabel = pick("#video-title");
    this.subtitleLabel = pick("#video-subtitle");
    this.volumeInput = pick<HTMLInputElement>("#video-volume");
    this.rateButton = pick<HTMLButtonElement>("#video-rate");
    this.toggleButton = pick<HTMLButtonElement>("#video-toggle");
    this.muteButton = pick<HTMLButtonElement>("#video-mute");
    this.fullscreenButton = pick<HTMLButtonElement>("#video-fullscreen");
    this.webFullscreenButton = pick<HTMLButtonElement>("#video-webfull");
    this.playlistPanel = pick("#video-playlist");
    this.rateMenu = pick("#video-rate-menu");
    this.subtitleButton = pick<HTMLButtonElement>("#video-subtitles");
    this.subtitleMenu = pick("#video-subtitle-menu");
    this.infoPanel = pick("#video-info");
    this.infoBody = pick("#video-info-body");
    this.infoStatus = pick("#video-info-status");
    this.surface = pick("#video-surface");
    this.video = pick<HTMLVideoElement>("#video-element");
    // Entrances reuse the archive's own surface motion so the overlay belongs to the terminal.
    this.archiveMotion = new PanelMotion(this.root, this.browser, 480, 220);
    this.theaterMotion = new PanelMotion(this.theater, this.surface, 420, 200);
    this.rateMenu.innerHTML = RATE_PRESETS.map((preset) => `<button type="button" data-rate="${preset}">${rateLabel(preset)}${preset === FAST_RATE ? "<i>长按 →</i>" : ""}</button>`).join("");
    if (readJson(STORAGE_KEY, { playlist: true }).playlist === false) this.setPlaylistVisible(false);
    this.applyVolume();
    this.updateRateLabel();
    this.bindEvents();
  }

  // ---------------------------------------------------------------- events

  private bindEvents() {
    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-video-close]")) return this.close();
      const action = target.closest<HTMLElement>("[data-video-action]")?.dataset.videoAction;
      const rate = target.closest<HTMLElement>("[data-rate]")?.dataset.rate;
      const subtitle = target.closest<HTMLElement>("[data-subtitle]")?.dataset.subtitle;
      if (rate) {
        this.setRate(Number(rate));
        this.rateMenu.hidden = true;
        return;
      }
      if (subtitle) {
        this.applySubtitle(Number(subtitle));
        this.subtitleMenu.hidden = true;
        return;
      }
      if (!action) return;
      switch (action) {
        case "close": return this.close();
        case "browser": return this.showBrowser();
        case "scan": return void this.refresh(true);
        case "toggle": return this.toggle();
        case "prev": return this.step(-1);
        case "next": return this.step(1);
        case "mute": return this.toggleMute();
        case "rate": this.rateMenu.hidden = !this.rateMenu.hidden; this.subtitleMenu.hidden = true; return;
        case "subtitles": this.subtitleMenu.hidden = !this.subtitleMenu.hidden; this.rateMenu.hidden = true; return;
        case "info": return this.toggleInfo();
        case "copy-info": return void this.copyInfo();
        case "playlist-fill": return void this.playlistAction("fill");
        case "playlist-clear": return void this.playlistAction("clear");
        case "playlist": return this.setPlaylistVisible(this.playlistPanel.hidden);
        case "web-fullscreen": return this.toggleWebFullscreen();
        case "fullscreen": return void this.toggleFullscreen();
      }
    });
    this.grid.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const add = target.closest<HTMLElement>("[data-add-video]")?.dataset.addVideo;
      if (add) {
        event.stopPropagation();
        void this.playlistAction(this.playlistKey(add) ? "remove" : "add", add);
        return;
      }
      const card = target.closest<HTMLElement>("[data-video-id]");
      if (card?.dataset.videoId) this.play(card.dataset.videoId);
    });
    this.playlistBody.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const remove = target.closest<HTMLElement>("[data-remove-video]")?.dataset.removeVideo;
      if (remove) {
        event.stopPropagation();
        void this.playlistAction("remove", remove);
        return;
      }
      const row = target.closest<HTMLElement>("[data-video-id]");
      if (row?.dataset.videoId) this.play(row.dataset.videoId);
    });
    this.filterInput.addEventListener("input", () => {
      this.filter = this.filterInput.value.trim().toLocaleLowerCase("en-US");
      this.renderGrid();
    });
    document.addEventListener("keydown", (event) => this.onKeyDown(event), true);
    document.addEventListener("keyup", (event) => this.onKeyUp(event), true);
    document.addEventListener("fullscreenchange", () => {
      this.fullscreenButton.innerHTML = document.fullscreenElement ? icons.collapse : icons.expand;
    });
    // The desktop host owns true full screen; keep the button in step with it.
    document.addEventListener("rhine:window-state", (event) => {
      const fullscreen = (event as CustomEvent<{ fullscreen?: boolean }>).detail?.fullscreen === true;
      this.fullscreenButton.innerHTML = fullscreen ? icons.collapse : icons.expand;
      this.fullscreenButton.setAttribute("aria-label", fullscreen ? "退出全屏" : "全屏");
    });
    this.theater.addEventListener("pointermove", () => this.wakeControls());
    this.theater.addEventListener("pointerleave", () => this.scheduleIdle());
    this.theater.addEventListener("wheel", (event) => {
      if (!this.theaterOpen) return;
      event.preventDefault();
      event.stopPropagation();
      this.setVolume(this.volume + (event.deltaY < 0 ? 0.05 : -0.05));
      this.showHud(`音量 ${Math.round(this.volume * 100)}%`);
    }, { passive: false });
    this.bindSurface();
    this.bindProgress();
    this.volumeInput.addEventListener("input", () => this.setVolume(Number(this.volumeInput.value)));
    this.video.addEventListener("click", () => this.onSurfaceTap());
    this.video.addEventListener("dblclick", (event) => {
      event.preventDefault();
      clearTimeout(this.clickTimer);
      void this.toggleFullscreen();
    });
    this.video.addEventListener("play", () => this.syncTransport());
    this.video.addEventListener("pause", () => this.syncTransport());
    this.video.addEventListener("waiting", () => { this.spinner.hidden = false; });
    this.video.addEventListener("playing", () => { this.spinner.hidden = true; });
    this.video.addEventListener("canplay", () => { this.spinner.hidden = true; });
    this.video.addEventListener("loadedmetadata", () => this.onLoadedMetadata());
    this.video.addEventListener("timeupdate", () => this.onTimeUpdate());
    this.video.addEventListener("progress", () => this.syncBuffered());
    this.video.addEventListener("durationchange", () => { this.durationLabel.textContent = clock(this.video.duration); });
    this.video.addEventListener("ended", () => this.step(1));
    this.video.addEventListener("error", () => {
      this.spinner.hidden = true;
      const name = this.currentItem()?.fileName ?? "";
      this.showHud("无法播放该视频");
      this.notify(`${name} 无法解码：WebView2 需要 H.264/AAC、VP9/Opus 或 AV1 编码，可尝试转码为 MP4。`);
    });
  }

  // ---------------------------------------------------------------- information

  /** Stream details for the current video: container, codecs, bitrate, subtitles. */
  private infoRows(item: VideoItem): Array<[string, string]> {
    const seconds = item.duration && item.duration > 0 ? item.duration : null;
    const bitrate = item.bitrate ?? (seconds ? Math.round((item.size * 8) / seconds) : null);
    const audio = item.audioCodec
      ? `${item.audioCodec}${item.audioChannels ? ` · ${item.audioChannels === 1 ? "单声道" : item.audioChannels === 2 ? "立体声" : `${item.audioChannels} 声道`}` : ""}${item.audioSampleRate ? ` · ${(item.audioSampleRate / 1000).toFixed(item.audioSampleRate % 1000 ? 1 : 0)} kHz` : ""}`
      : "无音轨或未识别";
    return [
      ["文件名", item.fileName],
      ["位置", item.external ? "外部文件（未加入资料库）" : item.relativePath],
      ["容器格式", item.container || item.extension.replace(".", "").toUpperCase()],
      ["文件大小", `${fileSize(item.size)}（${item.size.toLocaleString("en-US")} 字节）`],
      ["修改时间", new Date(item.mtime).toLocaleString("zh-CN")],
      ["时长", seconds ? `${clock(seconds)}（${seconds.toFixed(2)} 秒）` : "未解析"],
      ["平均码率", bitrate ? `${(bitrate / 1e6).toFixed(2)} Mbps（${Math.round(bitrate / 1000)} kbps）` : "未解析"],
      ["视频编码", item.videoCodec || item.codec || "未识别"],
      ["分辨率", item.width && item.height ? `${item.width} × ${item.height}` : "未解析"],
      ["帧率", item.fps ? `${item.fps} fps` : "未解析"],
      ["音频编码", audio],
      ["字幕轨", this.subtitleTracks.length ? this.subtitleTracks.map((track) => `${track.label}（${track.format.toUpperCase()}）`).join("、") : "无外挂字幕"],
      ["视频 ID", item.id],
    ];
  }

  private toggleInfo() {
    if (!this.infoPanel.hidden) {
      this.infoPanel.hidden = true;
      return;
    }
    if (!this.currentItem()) return;
    this.infoStatus.textContent = "";
    this.infoPanel.hidden = false;
    this.renderInfo();
  }

  private renderInfo() {
    const item = this.currentItem();
    if (!item || this.infoPanel.hidden) return;
    this.infoBody.innerHTML = this.infoRows(item)
      .map(([label, value]) => `<div class="video-info-row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
      .join("");
  }

  private async copyInfo() {
    const item = this.currentItem();
    if (!item) return;
    const text = this.infoRows(item).map(([label, value]) => `${label}: ${value}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      this.infoStatus.textContent = "已复制到剪贴板";
    } catch {
      this.infoStatus.textContent = "复制失败，请手动选择文本";
    }
    window.setTimeout(() => { this.infoStatus.textContent = ""; }, 2400);
  }

  // ---------------------------------------------------------------- information end

  // ---------------------------------------------------------------- subtitles

  /** Discovers subtitle files beside the video and turns the first one on. */
  private async loadSubtitles(item: VideoItem) {
    const token = ++this.subtitleToken;
    this.subtitleTracks = [];
    this.subtitleMode = -1;
    this.renderSubtitleMenu();
    try {
      const response = await fetch(`/api/subtitles/${item.id}`);
      // A manual toggle or another video must win over a slower discovery response.
      if (token !== this.subtitleToken || this.currentId !== item.id) return;
      if (response.ok) this.subtitleTracks = ((await response.json()) as { subtitles: SubtitleTrack[] }).subtitles ?? [];
    } catch {
      this.subtitleTracks = [];
    }
    if (token !== this.subtitleToken || this.currentId !== item.id) return;
    this.renderSubtitleMenu();
    if (this.subtitleTracks.length) {
      this.applySubtitle(this.subtitleTracks[0].index);
      this.showHud(`字幕：${this.subtitleTracks[0].label}`);
    }
    this.renderInfo();
  }

  private renderSubtitleMenu() {
    const rows = [`<button type="button" data-subtitle="-1" class="${this.subtitleMode === -1 ? "is-active" : ""}">关闭<i>V</i></button>`];
    for (const track of this.subtitleTracks) {
      rows.push(`<button type="button" data-subtitle="${track.index}" class="${this.subtitleMode === track.index ? "is-active" : ""}">${esc(track.label)}<i>${esc(track.format.toUpperCase())}</i></button>`);
    }
    if (!this.subtitleTracks.length) rows.push(`<button type="button" disabled>未找到字幕文件</button>`);
    this.subtitleMenu.innerHTML = rows.join("");
    this.subtitleButton.classList.toggle("is-on", this.subtitleMode >= 0);
    this.subtitleButton.setAttribute("aria-pressed", String(this.subtitleMode >= 0));
  }

  private applySubtitle(index: number) {
    const entry = this.subtitleTracks.find((track) => track.index === index);
    this.subtitleMode = entry ? index : -1;
    for (const track of Array.from(this.video.querySelectorAll("track"))) track.remove();
    if (entry && this.currentId) {
      const element = document.createElement("track");
      element.kind = "subtitles";
      element.label = entry.label;
      element.srclang = /English/i.test(entry.label) ? "en" : /日本語/.test(entry.label) ? "ja" : /한국어/.test(entry.label) ? "ko" : "zh";
      element.src = `/api/subtitle/${this.currentId}/${entry.index}`;
      element.default = true;
      this.video.append(element);
      this.syncSubtitleMode();
      window.setTimeout(() => this.syncSubtitleMode(), 240);
    }
    this.renderSubtitleMenu();
  }

  /** Keeps the rendered track showing even when Chromium swaps the TextTrack while loading. */
  private syncSubtitleMode() {
    const tracks = this.video.textTracks;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      track.mode = this.subtitleMode >= 0 ? "showing" : "hidden";
    }
  }

  private toggleSubtitles() {
    this.subtitleToken += 1;
    if (!this.subtitleTracks.length) {
      this.showHud("未找到字幕文件");
      return;
    }
    if (this.subtitleMode >= 0) {
      this.applySubtitle(-1);
      this.showHud("字幕已关闭");
      return;
    }
    this.applySubtitle(this.subtitleTracks[0].index);
    this.showHud(`字幕：${this.subtitleTracks[0].label}`);
  }

  // ---------------------------------------------------------------- subtitles end

  /** Click, double click and long-press gestures on the picture, mirroring familiar video players. */
  private bindSurface() {
    const surface = this.root.querySelector<HTMLElement>("#video-surface")!;
    surface.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button, .video-controls, .video-topbar")) return;
      const rect = surface.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
      const timer = window.setTimeout(() => {
        this.pointerHold = null;
        if (ratio > 0.62) this.beginFastForward();
        else if (ratio < 0.38) this.beginRewind();
        else this.toggle();
      }, 420);
      this.pointerHold = { ratio, x: event.clientX, y: event.clientY, timer };
    });
    const release = () => {
      if (!this.pointerHold) return;
      clearTimeout(this.pointerHold.timer);
      this.pointerHold = null;
      if (this.holdMode !== "none") this.endHoldBoost();
    };
    surface.addEventListener("pointerup", release);
    surface.addEventListener("pointercancel", release);
    surface.addEventListener("pointerleave", release);
  }

  private bindProgress() {
    const seekFromEvent = (clientX: number) => {
      const rect = this.progress.getBoundingClientRect();
      const duration = this.video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return 0;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
      this.video.currentTime = ratio * duration;
      this.syncProgress();
      return ratio;
    };
    this.progress.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.scrubbing = true;
      this.progress.setPointerCapture(event.pointerId);
      seekFromEvent(event.clientX);
    });
    this.progress.addEventListener("pointermove", (event) => {
      this.progressTip.hidden = false;
      const rect = this.progress.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
      const duration = this.video.duration;
      this.progressTip.textContent = Number.isFinite(duration) && duration > 0 ? clock(ratio * duration) : "0:00";
      this.progressTip.style.left = `${(ratio * 100).toFixed(2)}%`;
      if (this.scrubbing) seekFromEvent(event.clientX);
    });
    this.progress.addEventListener("pointerleave", () => { this.progressTip.hidden = true; });
    this.progress.addEventListener("pointerup", (event) => {
      this.scrubbing = false;
      this.progress.releasePointerCapture?.(event.pointerId);
    });
    this.progress.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") this.seekBy(TAP_SEEK);
      else if (event.key === "ArrowLeft") this.seekBy(-TAP_SEEK);
    });
  }

  private bindKeyboardSet = new Set([
    "Space", "KeyK", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "KeyM", "KeyF",
    "KeyW", "Escape", "KeyN", "PageDown", "PageUp", "BracketLeft", "BracketRight", "Minus",
    "Equal", "NumpadAdd", "NumpadSubtract", "KeyV", "Digit0", "Digit1", "Digit2", "Digit3", "Digit4",
    "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
  ]);

  private onKeyDown(event: KeyboardEvent) {
    if (!this.opened) return;
    if (!this.theaterOpen) {
      if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
      return;
    }
    if (event.code === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!this.infoPanel.hidden) this.infoPanel.hidden = true;
      else if (!this.rateMenu.hidden || !this.subtitleMenu.hidden) {
        this.rateMenu.hidden = true;
        this.subtitleMenu.hidden = true;
      } else if (this.webFullscreen) this.toggleWebFullscreen();
      else if (document.fullscreenElement) void document.exitFullscreen();
      else if (document.documentElement.dataset.windowFullscreen === "1") this.exitFullscreen();
      else this.showBrowser();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select")) return;
    if (!this.bindKeyboardSet.has(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && !["ArrowUp", "ArrowDown", "Equal", "Minus", "NumpadAdd", "NumpadSubtract"].includes(event.code)) return;
    switch (event.code) {
      case "Space": case "KeyK": return this.toggle();
      case "ArrowRight": return this.beginHold("forward");
      case "ArrowLeft": return this.beginHold("rewind");
      case "ArrowUp": return this.nudgeVolume(0.05);
      case "ArrowDown": return this.nudgeVolume(-0.05);
      case "KeyM": return this.toggleMute();
      case "KeyV": return this.toggleSubtitles();
      case "KeyF": return void this.toggleFullscreen();
      case "KeyW": return this.toggleWebFullscreen();
      case "KeyN": case "PageDown": return this.step(1);
      case "PageUp": return this.step(-1);
      case "BracketLeft": case "Minus": case "NumpadSubtract": return this.setRate(this.shiftRate(-1));
      case "BracketRight": case "Equal": case "NumpadAdd": return this.setRate(this.shiftRate(1));
    }
    if (event.code.startsWith("Digit")) {
      const digit = Number(event.code.slice(5));
      const duration = this.video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        this.video.currentTime = (duration * digit) / 10;
        this.showHud(`${digit * 10}%`);
      }
    }
  }

  private onKeyUp(event: KeyboardEvent) {
    if (!this.theaterOpen) return;
    if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return;
    event.preventDefault();
    event.stopPropagation();
    this.endHoldFromKey();
  }

  /**
   * Short press seeks; holding past HOLD_DELAY switches to 3x fast-forward (or continuous rewind)
   * until the key is released, which is the behavior users expect from the right arrow key.
   */
  private beginHold(direction: "forward" | "rewind") {
    if (this.holdMode !== "none" || this.holdTimer) return;
    this.holdDirection = direction;
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = 0;
      if (direction === "forward") this.beginFastForward();
      else this.beginRewind();
    }, HOLD_DELAY);
  }

  private endHoldFromKey() {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = 0;
      const direction = this.holdDirection;
      this.holdDirection = null;
      this.seekBy(direction === "rewind" ? -TAP_SEEK : TAP_SEEK);
      return;
    }
    this.endHoldBoost();
  }

  private beginFastForward() {
    if (this.holdMode !== "none") return;
    this.holdMode = "forward";
    this.video.playbackRate = FAST_RATE;
    if (this.video.paused) void this.video.play().catch(() => {});
    this.showHud(`${FAST_RATE}× 快进`);
    this.rateButton.classList.add("is-boosting");
    this.theater.classList.add("is-boosting");
    this.wakeControls();
  }

  private beginRewind() {
    if (this.holdMode !== "none") return;
    this.holdMode = "rewind";
    this.rewindWasPlaying = !this.video.paused;
    this.video.pause();
    this.rewindLast = performance.now();
    const tick = () => {
      if (this.holdMode !== "rewind") return;
      const now = performance.now();
      const delta = Math.min(0.3, (now - this.rewindLast) / 1000);
      this.rewindLast = now;
      this.video.currentTime = Math.max(0, this.video.currentTime - delta * FAST_RATE);
      this.syncProgress();
      this.rewindFrame = requestAnimationFrame(tick);
    };
    this.rewindFrame = requestAnimationFrame(tick);
    this.showHud(`${FAST_RATE}× 快退`);
    this.wakeControls();
  }

  private endHoldBoost() {
    if (this.holdMode === "none") return;
    cancelAnimationFrame(this.rewindFrame);
    this.rewindFrame = 0;
    const wasRewinding = this.holdMode === "rewind";
    this.holdMode = "none";
    this.holdDirection = null;
    this.rateButton.classList.remove("is-boosting");
    this.theater.classList.remove("is-boosting");
    this.video.playbackRate = this.rate;
    if (wasRewinding && this.rewindWasPlaying) void this.video.play().catch(() => {});
    this.showHud(wasRewinding ? "恢复播放" : `恢复 ${rateLabel(this.rate)}`);
  }

  // ---------------------------------------------------------------- state

  private currentItem(): VideoItem | undefined {
    return this.allVideos().find((video) => video.id === this.currentId);
  }

  /** Scanned library plus any file the shell opened during this session. */
  private allVideos(): VideoItem[] {
    return [...this.externals, ...this.snapshot.videos];
  }

  /** Playback order: the curated playlist when it has entries, otherwise the whole library. */
  private queue(): VideoItem[] {
    return this.playlist.length ? this.playlist : this.snapshot.videos;
  }

  private playlistKey(id: string) {
    return this.playlist.some((item) => item.id === id);
  }

  // ---------------------------------------------------------------- thumbnails

  /** Videos without a poster file get a frame captured from the file itself, cached locally. */
  private queueThumbnails(items: VideoItem[]) {
    for (const item of items) {
      if (item.hasPoster) continue;
      const key = `${item.id}:${item.size}`;
      if (this.posterCache[key] || this.posterQueue.some((queued) => queued.id === item.id)) continue;
      this.posterQueue.push(item);
    }
    void this.pumpThumbnails();
  }

  private async pumpThumbnails() {
    if (this.posterBusy) return;
    this.posterBusy = true;
    while (this.posterQueue.length) {
      const item = this.posterQueue.shift()!;
      if (this.posterCache[`${item.id}:${item.size}`]) continue;
      const dataUrl = await this.captureFrame(item);
      if (!dataUrl) continue;
      this.posterCache[`${item.id}:${item.size}`] = dataUrl;
      this.saveThumbnails();
      const image = this.grid.querySelector<HTMLImageElement>(`img[data-thumb="${item.id}"]`);
      if (image) {
        image.src = dataUrl;
        image.classList.add("is-ready");
      }
    }
    this.posterBusy = false;
  }

  private captureFrame(item: VideoItem): Promise<string | undefined> {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      let settled = false;
      const finish = (value?: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        video.removeAttribute("src");
        video.load();
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(undefined), 15000);
      video.addEventListener("loadeddata", () => {
        const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(video.duration * 0.12, 8) : 1;
        try { video.currentTime = target; } catch { finish(undefined); }
      }, { once: true });
      video.addEventListener("seeked", () => {
        try {
          const width = 480;
          const height = Math.max(1, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * width));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")!.drawImage(video, 0, 0, width, height);
          finish(canvas.toDataURL("image/jpeg", 0.72));
        } catch {
          finish(undefined);
        }
      }, { once: true });
      video.addEventListener("error", () => finish(undefined), { once: true });
      video.src = `/api/video/${item.id}`;
    });
  }

  private saveThumbnails() {
    // Keep the newest captures; a thumbnail is a small JPEG data URL.
    const entries = Object.entries(this.posterCache).slice(-160);
    this.posterCache = Object.fromEntries(entries);
    writeJson(POSTER_KEY, this.posterCache);
  }

  private posterSource(item: VideoItem): string | undefined {
    if (item.hasPoster) return `/api/video-poster/${item.id}`;
    return this.posterCache[`${item.id}:${item.size}`];
  }

  private syncTransport() {
    const playing = !this.video.paused;
    this.toggleButton.innerHTML = playing ? icons.pause : icons.play;
    this.toggleButton.setAttribute("aria-label", playing ? "暂停" : "播放");
    this.scheduleIdle();
  }

  /** Lets the archive stop rendering its three-dimensional scene while a video plays. */
  private announceActive(active: boolean) {
    document.dispatchEvent(new CustomEvent("rhine:video-active", { detail: active }));
  }

  private wakeControls() {
    this.theater.classList.remove("idle");
    this.scheduleIdle();
  }

  private scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.video.paused) return;
    this.idleTimer = window.setTimeout(() => this.theater.classList.add("idle"), 2600);
  }

  private showHud(message: string) {
    this.hud.textContent = message;
    this.hud.hidden = false;
    clearTimeout(this.hudTimer);
    this.hudTimer = window.setTimeout(() => { this.hud.hidden = true; }, 900);
  }

  private applyVolume() {
    this.video.volume = this.volume;
    this.video.muted = this.muted;
    this.volumeInput.value = String(this.volume);
    this.muteButton.innerHTML = this.muted || this.volume === 0 ? icons.muted : icons.volume;
    this.muteButton.classList.toggle("is-off", this.muted || this.volume === 0);
  }

  private savePreferences() {
    writeJson(STORAGE_KEY, {
      volume: this.volume, muted: this.muted, rate: this.rate,
      playlist: !this.playlistPanel.hidden,
    });
  }

  private setVolume(value: number) {
    this.volume = Math.min(1, Math.max(0, Number(value.toFixed(2))));
    if (this.volume > 0) this.muted = false;
    this.applyVolume();
    this.savePreferences();
  }

  private nudgeVolume(delta: number) {
    this.setVolume(this.volume + delta);
    this.showHud(`音量 ${Math.round(this.volume * 100)}%`);
  }

  private toggleMute() {
    this.muted = !this.muted;
    this.applyVolume();
    this.savePreferences();
    this.showHud(this.muted ? "已静音" : "已恢复声音");
  }

  private toggle() {
    if (this.video.paused) void this.video.play().catch(() => {});
    else this.video.pause();
  }

  private setRate(value: number) {
    this.rate = RATE_PRESETS.includes(value) ? value : 1;
    if (this.holdMode === "none") this.video.playbackRate = this.rate;
    this.updateRateLabel();
    this.savePreferences();
    this.showHud(`${rateLabel(this.rate)} 播放`);
  }

  private shiftRate(direction: number) {
    const index = RATE_PRESETS.indexOf(this.rate);
    const target = Math.min(RATE_PRESETS.length - 1, Math.max(0, (index < 0 ? 2 : index) + direction));
    return RATE_PRESETS[target];
  }

  private updateRateLabel() {
    const text = `${this.rate}×`;
    this.rateButton.textContent = text;
    this.rateMenu.querySelectorAll<HTMLElement>("[data-rate]").forEach((option) => {
      option.classList.toggle("is-active", Number(option.dataset.rate) === this.rate);
    });
  }

  private seekBy(seconds: number) {
    const duration = this.video.duration;
    const limit = Number.isFinite(duration) ? duration : Number.MAX_SAFE_INTEGER;
    this.video.currentTime = Math.min(limit, Math.max(0, this.video.currentTime + seconds));
    this.syncProgress();
    this.showHud(seconds > 0 ? `快进 ${seconds} 秒` : `快退 ${Math.abs(seconds)} 秒`);
  }

  private onSurfaceTap() {
    clearTimeout(this.clickTimer);
    this.clickTimer = window.setTimeout(() => this.toggle(), 220);
  }

  private step(direction: number) {
    const list = this.queue();
    if (!list.length) return;
    const index = list.findIndex((video) => video.id === this.currentId);
    const next = list[(index + direction + list.length) % list.length];
    if (next) this.play(next.id);
  }

  // ---------------------------------------------------------------- playback

  private onLoadedMetadata() {
    this.durationLabel.textContent = clock(this.video.duration);
    const resume = this.currentId ? this.positions[this.currentId] ?? 0 : 0;
    if (resume > 15 && resume < this.video.duration - 20) {
      this.video.currentTime = resume;
      this.showHud(`从 ${clock(resume)} 继续`);
    }
    this.video.playbackRate = this.rate;
    this.applyVolume();
    this.syncSubtitleMode();
    this.syncProgress();
  }

  private onTimeUpdate() {
    this.syncProgress();
    if (!this.currentId) return;
    const now = performance.now();
    if (now - this.saveClock < 5000) return;
    this.saveClock = now;
    this.positions[this.currentId] = this.video.currentTime;
    const entries = Object.entries(this.positions).sort((a, b) => b[1] - a[1]).slice(0, 300);
    this.positions = Object.fromEntries(entries);
    writeJson(POSITION_KEY, this.positions);
  }

  private syncProgress() {
    const duration = this.video.duration;
    const ratio = Number.isFinite(duration) && duration > 0 ? this.video.currentTime / duration : 0;
    const percent = `${(ratio * 100).toFixed(3)}%`;
    this.playedBar.style.width = percent;
    this.thumb.style.left = percent;
    this.currentLabel.textContent = clock(this.video.currentTime);
    this.progress.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  }

  private syncBuffered() {
    const duration = this.video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !this.video.buffered.length) return;
    const end = this.video.buffered.end(this.video.buffered.length - 1);
    this.bufferBar.style.width = `${Math.min(100, (end / duration) * 100).toFixed(3)}%`;
  }

  // ---------------------------------------------------------------- views

  open() {
    if (this.opened) return;
    this.opened = true;
    document.querySelector<HTMLElement>("#stage")?.classList.add("video-open");
    // A local video takes the transport: the music player keeps its place but stops sounding.
    if (document.querySelector("#play-pause")?.getAttribute("aria-pressed") === "true") {
      document.querySelector<HTMLButtonElement>("#stop-playback")?.click();
    }
    this.showBrowser();
    this.archiveMotion.show(this.reduced());
    this.boot(this.browser, 1100);
    void this.refresh(false);
    void this.loadPlaylist();
  }

  close() {
    if (!this.opened) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    // Leaving the player also leaves true full screen, so the window comes back.
    if (document.documentElement.dataset.windowFullscreen === "1") this.exitFullscreen();
    this.webFullscreen = false;
    this.root.classList.remove("video-web-fullscreen");
    this.theaterOpen = false;
    this.theater.hidden = true;
    this.opened = false;
    this.subtitleToken += 1;
    this.subtitleTracks = [];
    this.subtitleMode = -1;
    this.renderSubtitleMenu();
    clearTimeout(this.pollTimer);
    clearTimeout(this.frameTimer);
    this.endHoldBoost();
    clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.holdDirection = null;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    const stage = document.querySelector<HTMLElement>("#stage");
    stage?.classList.remove("video-open");
    stage?.classList.remove("video-theater-open");
    // Releasing the archive render loop matters even when the player is closed directly.
    this.announceActive(false);
    this.archiveMotion.hide(this.reduced());
  }

  private reduced() {
    return document.querySelector("#stage")?.classList.contains("reduce-motion") === true ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private showBrowser() {
    this.theaterOpen = false;
    this.root.classList.remove("video-web-fullscreen");
    this.webFullscreen = false;
    this.video.pause();
    document.querySelector<HTMLElement>("#stage")?.classList.remove("video-theater-open");
    this.announceActive(false);
    if (this.theater.hidden) this.theater.hidden = true;
    else this.theaterMotion.hide(this.reduced());
    this.renderGrid();
  }

  /** Opens a file handed over by Explorer: it joins this session's list, then plays. */
  openExternal(item: VideoItem) {
    this.externals = [item, ...this.externals.filter((entry) => entry.id !== item.id)];
    this.opened = true;
    document.querySelector<HTMLElement>("#stage")?.classList.add("video-open");
    if (document.querySelector("#play-pause")?.getAttribute("aria-pressed") === "true") {
      document.querySelector<HTMLButtonElement>("#stop-playback")?.click();
    }
    this.archiveMotion.show(this.reduced());
    this.renderGrid();
    this.renderPlaylist();
    this.play(item.id);
    void this.refresh(false);
    void this.loadPlaylist();
  }

  private play(id: string) {
    const item = this.allVideos().find((video) => video.id === id);
    if (!item) return;
    if (this.currentId && this.currentId !== id) {
      this.positions[this.currentId] = this.video.currentTime;
      writeJson(POSITION_KEY, this.positions);
    }
    const first = this.theater.hidden;
    this.currentId = id;
    this.theaterOpen = true;
    clearTimeout(this.idleTimer);
    this.theater.classList.remove("idle");
    document.querySelector<HTMLElement>("#stage")?.classList.add("video-theater-open");
    this.announceActive(true);
    // The motion helper owns the hidden flag so the first frame can fade in.
    if (first) {
      this.theaterMotion.show(this.reduced());
      this.boot(this.theater, 900);
    } else {
      this.pulseFrame();
    }
    this.titleLabel.textContent = item.title;
    this.subtitleLabel.textContent = `${item.folder}／${item.fileName}`;
    this.spinner.hidden = false;
    this.infoPanel.hidden = true;
    for (const track of Array.from(this.video.querySelectorAll("track"))) track.remove();
    this.video.src = `/api/video/${item.id}`;
    if (item.hasPoster) this.video.poster = `/api/video-poster/${item.id}`;
    else this.video.removeAttribute("poster");
    this.video.playbackRate = this.rate;
    this.applyVolume();
    void this.video.play().catch(() => { this.spinner.hidden = true; });
    void this.loadSubtitles(item);
    this.syncPlaylist();
    this.syncTransport();
  }

  /** Replays the geometric boot sequence on a surface (the archive's 动效 switch disables it in CSS). */
  private boot(target: HTMLElement, duration: number) {
    target.classList.remove("is-booting");
    void target.offsetWidth;
    target.classList.add("is-booting");
    window.setTimeout(() => target.classList.remove("is-booting"), duration);
  }

  /** A short cross-fade marks the cut between two videos. */
  private pulseFrame() {
    this.surface.classList.remove("is-switching");
    void this.surface.offsetWidth;
    this.surface.classList.add("is-switching");
    clearTimeout(this.frameTimer);
    this.frameTimer = window.setTimeout(() => this.surface.classList.remove("is-switching"), 320);
  }

  private setPlaylistVisible(visible: boolean) {
    this.playlistPanel.hidden = !visible;
    this.theater.classList.toggle("playlist-hidden", !visible);
    this.root.querySelector("#video-playlist-toggle")?.setAttribute("aria-pressed", String(visible));
    this.savePreferences();
  }

  private toggleWebFullscreen() {
    this.webFullscreen = !this.webFullscreen;
    if (this.webFullscreen) {
      this.playlistBeforeFullscreen = !this.playlistPanel.hidden;
      this.setPlaylistVisible(false);
    } else if (this.playlistBeforeFullscreen) {
      this.setPlaylistVisible(true);
    }
    this.root.classList.toggle("video-web-fullscreen", this.webFullscreen);
    this.webFullscreenButton.innerHTML = this.webFullscreen ? icons.collapse : icons.web;
    this.showHud(this.webFullscreen ? "网页全屏：画面占满窗口" : "退出网页全屏");
  }

  private async toggleFullscreen() {
    // In the desktop shell "full screen" means the real thing: no frame, no taskbar.
    const bridge = (window as unknown as { chrome?: { webview?: { postMessage(message: string): void } } }).chrome?.webview;
    if (bridge) {
      bridge.postMessage("window:fullscreen");
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    await this.root.querySelector<HTMLElement>("#video-theater")?.requestFullscreen().catch(() => {
      this.notify("当前窗口不允许全屏，可改用网页全屏（W）。");
    });
  }

  private exitFullscreen() {
    const bridge = (window as unknown as { chrome?: { webview?: { postMessage(message: string): void } } }).chrome?.webview;
    if (bridge) bridge.postMessage("window:fullscreen");
    else if (document.fullscreenElement) void document.exitFullscreen();
  }

  // ---------------------------------------------------------------- data

  private async refresh(scan: boolean) {
    try {
      const snapshot = await this.request(scan ? "/api/videos/scan" : "/api/videos", scan ? {} : undefined);
      this.snapshot = snapshot;
      this.renderGrid();
      this.renderPlaylist();
      if (snapshot.scanning) this.schedulePoll();
      else if (scan) this.notify(`视频扫描完成：${snapshot.videos.length} 个视频`);
      // Files adopted from the shell keep playing even though they are not part of the listing.
    if (this.currentId && !this.allVideos().some((video) => video.id === this.currentId)) this.showBrowser();
    } catch (error) {
      this.meta.textContent = `视频索引不可用：${(error as Error).message}`;
    }
  }

  private schedulePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => void this.refresh(false), 2000);
  }

  private async request(path: string, body?: Record<string, unknown>): Promise<VideoSnapshot> {
    const response = await fetch(path, body === undefined
      ? undefined
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(payload.error ?? "请求失败");
    }
    return await response.json() as VideoSnapshot;
  }

  private visibleVideos() {
    // Files opened from the shell are played directly and never join the library listing.
    const all = this.snapshot.videos;
    if (!this.filter) return all;
    return all.filter((video) =>
      video.title.toLocaleLowerCase("en-US").includes(this.filter) ||
      video.folder.toLocaleLowerCase("en-US").includes(this.filter) ||
      video.relativePath.toLocaleLowerCase("en-US").includes(this.filter));
  }

  private renderGrid() {
    const videos = this.visibleVideos();
    const total = this.snapshot.videos.length;
    this.root.classList.toggle("is-scanning", this.snapshot.scanning);
    if (this.snapshot.scanning) this.meta.textContent = `正在扫描本地视频目录…（已发现 ${total} 个）`;
    else if (total) this.meta.textContent = `${total} 个视频 · ${this.snapshot.roots.filter((root) => root.status === "online").length}/${this.snapshot.roots.length} 个目录在线${this.snapshot.scannedAt ? ` · 更新于 ${new Date(this.snapshot.scannedAt).toLocaleString("zh-CN")}` : ""}`;
    else this.meta.textContent = this.snapshot.roots.length ? "扫描完成，但目录中没有视频文件" : "尚未配置音乐文件夹";
    this.countLabel.textContent = `${total} FILE${total === 1 ? "" : "S"}`;
    this.rootsLabel.textContent = this.snapshot.roots.map((root) => root.path).join("  ·  ");
    this.grid.innerHTML = videos.map((video, index) => {
      const poster = this.posterSource(video);
      const artwork = poster
        ? `<img src="${poster}" alt="" loading="lazy"${video.hasPoster ? "" : ` data-thumb="${video.id}" class="is-ready"`} />`
        : `<img src="${BLANK_THUMB}" alt="" data-thumb="${video.id}" />`;
      const shape = video.width && video.height ? `${video.width}×${video.height}` : "";
      const detail = [video.external ? "外部文件" : video.folder, video.duration ? clock(video.duration) : "", shape, fileSize(video.size)].filter(Boolean).join(" · ");
      const added = this.playlistKey(video.id);
      return `<button type="button" class="video-card" style="--i:${Math.min(index, 14)}" data-video-id="${video.id}" aria-label="播放 ${esc(video.title)}">
        <span class="video-card-poster">${poster ? "" : `<span class="video-card-placeholder">${esc(video.extension.replace(".", "").toUpperCase())}</span>`}${artwork}<i class="video-card-play">${icons.play}</i><span class="video-card-add${added ? " is-added" : ""}" data-add-video="${video.id}" role="button" tabindex="-1" aria-label="${added ? "已在播放列表" : "加入播放列表"}" title="${added ? "已在播放列表" : "加入播放列表"}">${added ? icons.check : icons.plus}</span></span>
        <span class="video-card-body"><strong>${esc(video.title)}</strong><small>${esc(detail)}</small></span>
      </button>`;
    }).join("");
    this.queueThumbnails(videos);
    const offline = this.snapshot.roots.filter((root) => root.status === "offline");
    this.empty.hidden = videos.length > 0;
    if (!videos.length) {
      this.empty.innerHTML = total
        ? `<strong>没有匹配的视频</strong><p>换一个关键词，或清空筛选框。</p>`
        : `<strong>还没有本地视频</strong><p>视频与音乐共用同一个文件夹设置：在“音乐库”中添加音乐文件夹后，这里的 MP4、MKV、WebM、MOV 等文件会出现在列表中。文件始终从原位置流式播放，不会被复制或修改。</p>${offline.length ? `<p class="video-empty-warn">${offline.map((root) => `${esc(root.path)}：${esc(root.error ?? "目录不可用")}`).join("<br />")}</p>` : ""}<div class="video-empty-actions"><button type="button" data-video-action="scan">${icons.scan}<span>重新扫描</span></button><button type="button" data-video-action="browser" class="video-quiet">返回</button></div>`;
    }
  }

  private renderPlaylist() {
    const curated = this.playlist.length > 0;
    const videos = this.queue();
    this.playlistCount.textContent = curated ? `${videos.length} 个` : `全部 ${videos.length} 个`;
    if (!videos.length) {
      this.playlistBody.innerHTML = `<p class="video-playlist-empty">播放列表为空。点视频卡片右上角的 ＋ 加入，或使用“全部加入”。</p>`;
      return;
    }
    const banner = curated ? "" : `<p class="video-playlist-hint">尚未挑选，正在显示整个视频库；用卡片上的 ＋ 建立自己的列表。</p>`;
    this.playlistBody.innerHTML = banner + videos.map((video, index) => `<div class="video-playlist-row${video.id === this.currentId ? " is-current" : ""}" style="--i:${Math.min(index, 16)}">
      <button type="button" class="video-playlist-play" data-video-id="${video.id}" aria-label="播放 ${esc(video.title)}">
        <strong>${esc(video.title)}</strong><small>${esc(video.external ? "外部文件" : video.folder)}${video.duration ? ` · ${clock(video.duration)}` : ""}</small>
      </button>
      ${curated ? `<button type="button" class="video-playlist-remove" data-remove-video="${video.id}" aria-label="从播放列表移除 ${esc(video.title)}" title="移除">×</button>` : ""}
    </div>`).join("");
    if (this.playlistMissing > 0) {
      this.playlistBody.insertAdjacentHTML("beforeend", `<p class="video-playlist-hint">有 ${this.playlistMissing} 个条目已不在视频库中，已自动忽略。</p>`);
    }
  }

  private syncPlaylist() {
    this.playlistBody.querySelectorAll<HTMLElement>(".video-playlist-row").forEach((row) => {
      const current = row.querySelector<HTMLElement>("[data-video-id]")?.dataset.videoId === this.currentId;
      row.classList.toggle("is-current", current);
      if (current) row.scrollIntoView({ block: "nearest" });
    });
  }

  // ---------------------------------------------------------------- playlist

  private async loadPlaylist() {
    try {
      const response = await fetch("/api/video-playlist");
      if (!response.ok) return;
      const payload = (await response.json()) as { items: VideoItem[]; missing?: number };
      this.playlist = payload.items ?? [];
      this.playlistMissing = payload.missing ?? 0;
    } catch {
      // A missing playlist simply keeps the library view.
    }
    this.renderPlaylist();
    this.renderGrid();
  }

  /** add / remove / fill / clear, mirrored from the server so every window agrees. */
  private async playlistAction(action: "add" | "remove" | "fill" | "clear", id?: string) {
    try {
      const response = await fetch("/api/video-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(payload.error ?? "操作失败");
      }
      const payload = (await response.json()) as { items: VideoItem[]; missing?: number };
      this.playlist = payload.items ?? [];
      this.playlistMissing = payload.missing ?? 0;
      this.renderPlaylist();
      this.renderGrid();
      const labels = { add: "已加入播放列表", remove: "已从播放列表移除", fill: "已把视频库全部加入", clear: "播放列表已清空" };
      this.showHud(labels[action]);
      if (action === "clear" || action === "remove") {
        const titles = { clear: "已清空播放列表", remove: "已从播放列表移除" };
        this.notify(titles[action]);
      }
    } catch (error) {
      this.notify(`播放列表操作失败：${(error as Error).message}`);
    }
  }
}

export function setupVideoArchive(options: VideoArchiveOptions = {}): VideoArchive | null {
  const topnav = document.querySelector<HTMLElement>("#stage .music-topnav") ?? document.querySelector<HTMLElement>(".music-topnav");
  if (!topnav || topnav.querySelector('[data-action="videos"]')) return null;
  const controller = new VideoArchiveController(topnav, options.notify ?? (() => {}));
  return controller;
}


