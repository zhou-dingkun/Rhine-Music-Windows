# Rhine Music Windows port changelog

## Rhine Player 分支：本仓库相对上游的改动（0.7.0，2026-10-10）

本分支由 [zhou-dingkun](https://github.com/zhou-dingkun) 在 [Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows)（上游为 [RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)、[LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)）基础上继续开发，按原仓库 MIT 许可开源，保留全部上游署名；非代码素材的授权边界见 [NOTICE.md](NOTICE.md)。

### 0.7.0 版本号

- 版本由 `0.6.0-dev.98` 提升为正式号 **0.7.0**：`version.json` 切换为 `channel: release`，`package.json`/`package-lock.json`、`src/build-version.ts`、`DesktopProgram.cs`（AssemblyVersion / AssemblyFileVersion / AssemblyInformationalVersion / AppVersion）、`app.manifest`、README 与发行产物名全部同步。
- 构建脚本新增 `-ReleaseVersion`：跳过开发序号分配、直接按 `version.json` 出包；上游脚本给正式版写的 `65535` 哨兵值在 `AssemblyVersion` 中非法，改为归一化为 `x.y.z.0`（Win32 清单与程序集信息一致）。
- 产物为 `Rhine-Player-Desktop-0.7.0.exe`（FileVersion 0.7.0.0 / ProductVersion 0.7.0），运行时标题 `Rhine Player 0.7.0`；数据目录仍为 `music-data-v3`，曲库、歌单与设置不受影响。

### 0.6.0-dev.98 修复

- **标题栏改为保留区**：桌面壳中顶部 40px 作为专属标题栏带（不透明底色 + 强调色下边界线，`z-index: 50`），除最小化/最大化/关闭按钮外**任何 UI 都不得进入**。
- 所有界面整体下移到该带之下：视频档案与播放页（`top: 40px`，播放器自身标题栏从 40px 开始）、对话框遮罩、专辑详情页；拖动条高度与保留区一致（40px）。
- 真全屏时该带隐藏（`display: none`）并把画面恢复为整屏（`top: 0`），把整块屏幕交还给画面。

### 0.6.0-dev.97 修复

- **标题栏与子窗口重叠**：对话框与视频档案整体下移（面板顶部 46px > 窗口按钮底部 33px），顶部拖动条与最小化/最大化/关闭按钮不再压住面板内容。
- **视频列表封面**：没有同名封面文件的视频会从视频本体抓取一帧（隐藏 `<video>` + canvas，取 12% 处、480px JPEG），缓存在本机并按 160 张滚动，卡片上淡入显示，不再只显示扩展名占位。
- **视频播放列表可编辑**：卡片右上角 `＋/✓` 加入/移出，侧栏每行 `×` 移除，另有“全部加入”“清空”。服务端存 `video-playlist.json`（只存条目标识，读取时用当前索引补全，失效条目自动忽略并提示数量）；列表为空时回退显示整个视频库并给出提示；上一个/下一个与自动连播按播放列表顺序。
- **画面与背景错位**：播放画面改为铺满 surface 框（`object-fit: contain`、透明底色、无边框与投影），消除半像素错位与相框残留；surface 内边距调整为 24/24/96。

### 新增：本地视频播放器（`src/video-app.ts`、`src/video.css`、`scripts/video-library.mjs`）

- 扫描音乐库文件夹内的视频（MP4/M4V/MOV/MKV/WebM/AVI/FLV/TS/M2TS/MPG/WMV/OGV/3GP），封面取同名图片或目录内 `cover/poster/folder`；`/api/video/<id>` 支持 HTTP Range，进度条定位即时生效，文件不被复制或修改。
- 播放器界面：进度条（已播/缓冲/悬停时间/十分之一刻度）、音量与滚轮调节、倍速菜单、网页全屏/全屏、播放列表侧栏、上一个/下一个、自动连播、断点续播、静置自动隐藏控制条、状态提示（HUD）、单击画面暂停、双击画面全屏。
- 键盘：`空格`/`K` 播放暂停；`←` `→` 短按 ±5 秒；**长按 `→` 三倍速快进、长按 `←` 三倍速倒带**（320 ms 触发，松手恢复）；`↑` `↓` 音量；`M` 静音；`F` 全屏；`W` 网页全屏；`V` 字幕；`N`/`PageDown` 下一个；`[` `]` 调速；数字键跳百分比；`ESC` 逐级退出。
- 视频信息面板：文件名、位置、容器格式、文件大小、修改时间、时长、平均码率、视频编码、分辨率、帧率、音频编码与声道/采样率、字幕轨，可一键复制。元数据由本地容器解析：ISO-BMFF 读取 `ftyp/mvhd/stsd/stts`，Matroska/WebM 走 EBML 的 `Info`、`Tracks`、`Video`、`Audio`（含帧率、采样率、声道、时长）。
- 动效沿用档案架语言：面板裁切展开 + 扫描线 + 角标，播放页虹膜展开 + 锁定准星 + 栏位滑入；受应用内“减少动态效果”与系统 `prefers-reduced-motion` 控制。

### 新增：字幕支持（`scripts/subtitles.mjs`）

- 自动发现同名字幕（同目录及 `subs`/`sub`/`subtitles`/`字幕` 子目录），支持 `.srt`/`.vtt`/`.ass`/`.ssa`；`/api/subtitles/<id>` 列出字幕轨，`/api/subtitle/<id>/<index>` 转换为 WebVTT 供内核渲染。
- ASS/SSA 解析 `Format`/`Dialogue`、剥离 `{\...}` 覆盖标签、`\N` 转换行；SRT 时间戳重写；语言标签识别（简体中文/繁体中文/English/日本語/한국어）。
- 字幕文件与音乐标签共用多编码修复，GBK 字幕可直接显示。

### 新增：Windows 集成（`DesktopProgram.cs`、`src/window-chrome.ts`）

- **打开方式**：`HKCU\Software\Classes` 下注册 `Applications\Rhine-Player-Desktop-<版本>.exe`、`SupportedTypes`（26 种音视频扩展名）与 ProgID `RhineMusic.Media`，仅加入“打开方式”候选，**不修改扩展名默认值**；启动时清理旧版本条目。
- **快捷方式**：启动时创建/更新桌面与开始菜单的 `Rhine Player.lnk`（目标、工作目录、图标、描述）。
- **直接打开**：`POST /api/open` 分派——视频进入播放页播放；音乐库内音频进入专辑详情页并播放；库外音频经 `/api/media` 直接播放，**不写入资料库、不修改库根目录**；此类启动跳过开场动画（载入提示为“正在打开 …”）。运行中再次打开文件由单实例交接处理，请求消费一次即删除，普通启动不复现上次文件。
- **窗口**：无边框窗口，顶部拖动条 + 最小化/最大化/关闭按钮（层级高于面板与播放层），窗口边缘缩放通过页面→宿主命令进入原生缩放循环；最大化使用工作区不遮挡任务栏；**真正的全屏**覆盖任务栏、无内边距与相框残留，`F11` 与播放器全屏按钮共用同一实现，退出播放器自动退出全屏。
- **应用图标**：`scripts/build-app-icon.ps1` 由共享标识生成 16–256 px 多尺寸 ICO，构建脚本以 `/win32icon` 打包，窗口/任务栏/打开方式均使用。

### 新增：播放与渲染优化

- 播放视频时暂停三维档案架渲染循环，关闭播放页后恢复（实测 2 秒内 draw call 12,101 → 0）。
- 设置面板新增**视频解码方式**：`自动 / 硬件优先 / 软件解码`，写入 `<数据目录>/player-settings.json`，宿主在创建 WebView2 环境前转换为启动参数（软件解码为 `--disable-accelerated-video-decode`），并提供“重启应用”动作。
- 专辑封面切换加入 240 ms 交叉溶解（`src/cover-atlas.ts`、`src/scene.ts`），完成后回绑图集分页保持零上传快路径。
- 开场动画改用内置模板封面，不再使用本机专辑封面。

### 新增：文本编码修复（`scripts/music-library.mjs`）

- 标签与 LRC 歌词支持 UTF-8（含 BOM）、UTF-16LE、GBK、Big5、Shift-JIS、EUC-KR 与 CP1252 回退；仅对成对高位字节触发，`Björk`、`Café` 等合法西文不受影响。实测 484 张专辑 0 条乱码。

### 其他

- 软件名改为 **Rhine Player**（窗口标题、可执行文件名、程序集信息、打开方式条目、页面标题、PWA 清单、设置页文案）；数据目录保持 `%LOCALAPPDATA%\Rhine Music`，升级不丢索引与设置。
- 构建脚本新增图标生成与 `/win32icon`，版本分配与产物命名同步为 `Rhine-Player-Desktop-<版本>.exe`。

## 0.6.0-dev.57 (2026-10-04)

- Leave the Windows executable CompanyName field blank so the independent developer is not presented as a company.
- Keep Bong712 in the in-app developer credit and copyright metadata.
- Package this correction as a new version; preserve all previous EXE files.

## 0.6.0-dev.56 (2026-10-04)

- Update the in-app developer panel to identify Bong712 as the Windows port maintainer and describe the actual WebView2 / WebGL 2 (ANGLE) renderer.
- Remove internal FPS acceptance wording from the user settings panel; retain upstream and asset attribution in the app and repository notices.
- Update the repository attribution and release documentation to name Bong712 as the Windows developer and RonaldDeng as the project receiving special thanks.
- Rebuild as a new versioned package; earlier executables remain untouched.

## 0.6.0-dev.39 (2026-10-04)

- Replace the custom `sampler2DArray` cover path with ordinary 2D texture pages and per-instance UV rectangles. Each album keeps its own atlas cell while the shelf remains instanced.
- Update a changed cover by copying its 256×256 cell into the existing page, keeping the same per-page GPU memory footprint as the previous array atlas.
- `npm run check:music` and the Windows package build pass. Automated visual confirmation remains pending because WebView2's GPU and render child processes fail to start on this machine (exit codes `-1073741790` and `49`); the same failure reproduces with dev.37 and SwiftShader. Genuine 4K displayed-frame performance acceptance remains pending.

## 0.6.0-dev.30 (2026-10-04)

- When the local music service is unavailable and the library is empty, show the empty-library panel so the bundled demo-cover action remains reachable. Keep the service-disconnected status visible.
- Add a scene check to prevent this demo-entry regression. `npm run check:music` passed; the production build and Windows package succeeded.
- Built `outputs/Rhine-Music-Desktop-0.6.0-dev.30.exe`; PE FileVersion `0.6.0.30`, ProductVersion `0.6.0-dev.30`, SHA-256 `9a6b1c62a2e37e34281253f9bea2948dd3430c0452176e4951ed971627e058f3`. Performance acceptance remains `PENDING`.
- The no-service demo page was closed before the fix; the WebView2 blank host still exits before scene startup with `STATUS_ACCESS_DENIED`, so displayed-frame performance is unverified.

## 0.6.0-dev.28 (2026-10-04)

- Replace the 5×4 canvas cover pages with WebGL2 texture-array pages. Each 256×256 cover now uploads as one 256 KiB layer instead of retransmitting its roughly 5 MiB page; 432 album slots use four instanced pages when the adapter supports 128 layers.
- Query the active GPU's array-layer limit and cap page depth at 128; retain the existing 256×256 shelf print and the 1024×1024 cold selected-cover path.
- Add checks for changed-layer isolation and vertical cover orientation. `npm run check:music` passes all 49 checks and `npm run build` succeeds.
- Direct visual and displayed-frame verification is still pending because the local WebView2 blank host exits with `STATUS_ACCESS_DENIED`. This remains a 0.6.0 development candidate.

## 0.6.0-dev.1 (2026-10-04)

- Merge albums across configured roots using normalized album title as the only identity; preserve each track's actual source path, cover owner, stable multi-disc order, and migrated manual genre rules.
- Add persistent custom playlists with edit, ordering, playback, and visible missing-track state; add an editable playback queue.
- Add same-folder LRC loading, common timestamp and offset parsing, synchronized lyrics, and click-to-seek.
- Use a device-pixel-ratio-aware original-quality buffer, including native 3840×2160 output at common 4K Windows display scales; remove the software-rendering 30 FPS cap.
- Add Per-Monitor V2 DPI awareness and F11 borderless full-screen support to the standalone Windows host.
- Keep 4K real displayed-frame performance acceptance pending. This development candidate is not the final 0.6.0 release.

## 0.5.0 (2026-10-04)

- Package the Windows desktop application as `Rhine-Music-Desktop-0.5.0.exe`.
- Keep the album-switch cover atlas reuse and 5×4 atlas pages from 0.4.1. The user reviewed the demo and reported that album changes no longer stutter.
- Instrumented present-frame performance acceptance and full native D3D11 scene integration remain pending; this remains a development candidate.

## 0.4.1 (2026-10-03)

- Set the Windows application version to 0.4.1 and synchronized package and UI metadata.
- Rebind the rising selected cover to its existing shelf-atlas tile when resident, avoiding a second 1024×1024 canvas upload on warm album switches; retain the full-size fallback for covers not yet in the shelf pool.
- Split the shelf atlas into 5×4 cover pages so updating a cover invalidates a roughly 5 MiB page instead of one very large atlas.
- Reuse the cover atlas for outgoing album covers and skip canvas texture creation for hidden music labels during album switches.
- Added album-switch frame, scene CPU, GPU, and cover readiness measurements; performance acceptance remains pending.

## 0.4.0-dev.1 (2026-10-03)

- Start the native Direct3D 11 renderer work from the 0.3.1 WebView2 build.
- Current graphics target and product integration are prototypes; 1080p/60 FPS acceptance is pending.

## 0.6.0-dev.2 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.3 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.4 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.5 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.6 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.7 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.8 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.9 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.10 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.11 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.12 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.13 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.14 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.15 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.16 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.17 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.18 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.19 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.20 (2026-10-03)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.21 (2026-10-03)

- Keeps the final 3840×2160 canvas while bounding transmission, SSAO, and depth-of-field buffers to about 2 MP; depth-of-field is upscaled into the full-resolution composer target.
- Added readable per-pass and longer-window switch diagnostics. Genuine displayed-frame acceptance remains pending.

## 0.6.0-dev.22 (2026-10-03)

- Split camera-visible album instances from off-camera shadow-only casters. The same shadow-frustum coverage remains in the shadow map while off-camera glass shells leave the main color and post-processing passes.
- Built as a local Windows development candidate. Real displayed-frame and visual comparison acceptance remains pending.

## 0.6.0-dev.23 (2026-10-03)

- Hide cover-atlas pages with no camera-visible album, reducing empty page draw calls without reducing cover texture resolution.
- Retain the dev22 shadow-caster split. WebView2/GPU initialization and real displayed-frame acceptance remain pending.

## 0.6.0-dev.24 (2026-10-04)

- Move off-camera shadow casters to a shadow-only Three.js layer. The main camera skips their otherwise unnecessary zero-write draw while the directional shadow camera retains them.
- Keep visual and 4K performance acceptance pending because WebView2 currently crashes before the demo scene initializes.

## 0.6.0-dev.25 (2026-10-04)

- Stage cover transforms for camera-visible albums and upload only atlas pages that contain visible covers. Visible pages still zero hidden slots so stale transforms cannot reappear.
- Real-scene visual comparison and 4K present-frame acceptance remain pending while the local WebView2 host fails before scene startup.

## 0.6.0-dev.26 (2026-10-04)

- Defer cover-atlas record lookup, canvas painting and texture invalidation for camera-hidden slots. Refresh each tile before it becomes visible; keep the visible shelf, selected artwork and 4K output resolution unchanged.
- `npm run check:music` passed all 49 checks before packaging. The Windows build succeeded, and the version check passed for this candidate.
- Visual and displayed-frame performance acceptance remain pending because the local WebView2 host fails before scene startup.


## 0.6.0-dev.31 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.32 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.33 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.34 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.35 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.36 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.37 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.38 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.


## 0.6.0-dev.40 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.41 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.42 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.43 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.44 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.45 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.46 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.47 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.48 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.49 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.50 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.51 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.52 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.53 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.54 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.55 (2026-10-04)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.58 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.59 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.60 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.61 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.62 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.63 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.64 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.65 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.66 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.67 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.68 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.69 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.70 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.71 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.72 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.73 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.74 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.75 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.76 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.77 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.78 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.79 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.80 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.81 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.82 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.83 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.84 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.85 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.86 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.87 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.88 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.89 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.90 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.91 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.92 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.93 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.94 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.95 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.96 (2026-10-10)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.97 (2026-10-11)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.

## 0.6.0-dev.98 (2026-10-11)

- Windows desktop development package; 3840×2160 real-present 60 FPS acceptance is pending.
