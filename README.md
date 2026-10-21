# Rhine Music · Windows

这是 [RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) 的 Windows 桌面移植版。项目在三维音乐档案界面和本机播放基础上，添加了同步歌词显示，并扩展了 Windows 曲库、歌单和播放队列管理。

**当前版本：0.7.0** · **维护者：** [Bong712](https://github.com/Bong712)

> **本仓库是 [Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows) 的分支（Rhine Player）**，由 [zhou-dingkun](https://github.com/zhou-dingkun) 继续开发（上方维护者为上游作者），按原仓库 **MIT 许可**开源，保留全部上游署名与资源说明（见 [NOTICE.md](NOTICE.md)、[LICENSE](LICENSE)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）。相对上游的改动见下方“本分支的改动”与 [CHANGELOG.md](CHANGELOG.md)。

## 本分支的改动

### 新增：本地视频播放器

- 扫描与音乐库相同的文件夹中的视频（MP4/M4V/MOV/MKV/WebM/AVI/FLV/TS/M2TS/MPG/WMV/OGV/3GP），封面取同名图片或目录内 `cover/poster/folder`；视频以 HTTP Range 流式播放，拖到哪播到哪，不复制文件。
- 播放界面接近常见在线播放器：进度条（已播/缓冲/悬停时间/十分之一刻度）、音量与滚轮调节、倍速菜单、网页全屏与全屏、播放列表侧栏、自动连播、断点续播、静置自动隐藏控制条、状态提示；单击画面暂停、双击画面全屏。
- 键盘：`空格`/`K` 播放暂停，`←` `→` 短按 ±5 秒，**长按 `→` 三倍速快进**，长按 `←` 三倍速倒带，`↑` `↓` 音量，`M` 静音，`F` 全屏，`W` 网页全屏，`V` 字幕，`N`/`PageDown` 下一个，`[` `]` 调速，数字键跳百分比，`ESC` 逐级退出。
- 视频信息面板：文件名、位置、容器格式、文件大小、修改时间、时长、平均码率、视频编码、分辨率、帧率、音频编码与声道/采样率、字幕轨，可一键复制。元数据由本地容器解析得出（ISO-BMFF 的 `mvhd/tkhd/stsd/stts`，Matroska 的 `Info/Tracks/Video/Audio`），不依赖 ffmpeg。
- 与三维档案架一致的动效语言：面板裁切展开 + 扫描线 + 角标，播放页虹膜展开 + 锁定准星 + 栏位滑入。

### 新增：字幕

- 自动发现同名字幕（同目录及 `subs`/`sub`/`subtitles`/`字幕` 子目录），支持 `.srt`/`.vtt`/`.ass`/`.ssa`，服务端转换为 WebVTT 交由内核渲染；ASS/SSA 解析 `Format`/`Dialogue` 并剥离覆盖标签；语言标签识别（简体/繁体/English/日本語/한국어）。
- 字幕文件与音乐标签一样做多编码修复，GBK 字幕可直接显示。

### 新增：Windows 集成

- **打开方式**：在 `HKCU\Software\Classes` 注册 `Applications\…`、`SupportedTypes`（26 种音视频扩展名）与 ProgID `RhineMusic.Media`，只加入“打开方式”候选，**从不设为默认**；旧版本条目会在启动时清理。
- **快捷方式**：启动时维护桌面与开始菜单的 `Rhine Player.lnk`（指向当前构建与图标，路径变化时自动更新）。
- **直接打开**：视频直接进入播放页播放；音乐库内的音频进入专辑详情页并播放；库外文件通过 `/api/media` 直接播放且**不写入资料库**；此类启动跳过开场动画，载入提示为“正在打开 …”。
- **单实例交接**：再次打开文件时交由已运行窗口处理，请求消费一次即删除，普通启动不会重放上一次的文件。
- **窗口**：无边框，标题栏并入界面（顶部拖动条 + 最小化/最大化/关闭按钮，层级置于所有面板之上；窗口边缘缩放）；最大化使用工作区不遮挡任务栏；**真正的全屏**覆盖任务栏且无内边距/相框残留（`F11` 与播放器全屏按钮同一实现）。
- **应用图标**：由共享标识生成 16–256 px 多尺寸 ICO 打包进 exe（`scripts/build-app-icon.ps1`，构建脚本 `/win32icon`），窗口、任务栏与“打开方式”均使用。

### 新增：播放与渲染优化

- 播放视频时暂停三维档案架的渲染循环（实测 2 秒内 draw call 从 12,101 降到 0），消除卡顿来源；关闭播放页后恢复。
- **解码方式可选**：设置面板提供 `自动 / 硬件优先 / 软件解码`，写入 `player-settings.json`，宿主在创建 WebView2 环境时转换为启动参数（如 `--disable-accelerated-video-decode`），并提供“重启应用”按钮。
- 专辑封面切换加入 240 ms 交叉溶解，结束后回绑图集分页，保持零上传的快速路径。
- 开场动画使用内置模板封面，不再使用本机专辑封面。

### 新增：文本编码修复

- 音乐标签与 LRC 歌词支持 UTF-8（含 BOM）、UTF-16LE、GBK、Big5、Shift-JIS、EUC-KR 与 CP1252 回退；仅对成对高位字节触发，`Björk`、`Café` 这类合法西文不会被改写。实测 484 张专辑 0 条乱码。

### 其他

- 软件名由 Rhine Music 改为 **Rhine Player**（窗口标题、可执行文件名、程序集信息、打开方式条目、页面标题与 PWA 清单）；数据目录仍为 `%LOCALAPPDATA%\Rhine Music`，升级不会丢失曲库索引与设置。
- **视频列表封面**：没有同名封面文件的视频会从视频本体抓取一帧作为封面（本机缓存、卡片淡入显示）。
- **视频播放列表可编辑**：卡片右上角 `＋/✓` 加入或移出，侧栏每行 `×` 移除，另有“全部加入”“清空”；列表为空时回退显示整个视频库；上一个/下一个与自动连播按列表顺序。
- 标题栏与对话框、视频档案保持间距，右上角窗口按钮不再压住面板内容；播放画面铺满画面框，消除半像素错位与相框残留。
- 新增 `scripts/video-library.mjs`、`scripts/subtitles.mjs`、`scripts/build-app-icon.ps1`；构建产物包含上述功能。

## 下载与运行

打开 [Releases](https://github.com/Bong712/Rhine-Music-Windows/releases)，下载对应版本的 Windows x64 `.exe`。需要 Windows 10/11 和 Microsoft Edge WebView2 Evergreen Runtime。程序首次启动时会解压运行资源到 `%LOCALAPPDATA%\Rhine Music\app-v<version>`。

在“音乐库”中添加本机音乐文件夹并扫描。播放器读取原位置的音频，不上传或复制歌曲。曲库索引、歌单、封面缓存和设置存放在 `%LOCALAPPDATA%\Rhine Music\music-data-v3`。还没有曲库时，可以直接进入演示封面。

每次升级都会解压一份新的运行资源（`app-v<version>`，约 120 MB），旧版本不会自动删除。需要回收空间时运行清理脚本（只删除 `app-v*` 目录，曲库数据不受影响；默认保留正在运行的版本和最新一份）：

```powershell
pwsh -NoProfile -File scripts/clean-payloads.ps1          # 清理
pwsh -NoProfile -File scripts/clean-payloads.ps1 -WhatIf  # 先预览
```

## 功能与 Windows 版改进

- 将 macOS／浏览器原型移植为 Windows x64 桌面程序，使用 WinForms 启动器、内置本机音乐服务和 WebView2 窗口。
- 将专辑标题经去首尾空白、Unicode NFC 规范化和忽略大小写后作为归档身份。同名专辑可以跨歌手标签、唱片编号和音乐根目录归并；曲目仍从各自原路径读取，多碟顺序保持稳定。
- 添加本机歌单管理、可编辑播放队列、上一首／下一首，以及与音频文件同名的 LRC 歌词、播放同步、偏移解析和歌词点击定位。
- 优化三维专辑架的封面传输：使用普通 2D 纹理图集和每张专辑独立的 UV 区域，专辑架采用实例化绘制；更新封面只上传变化的图块。冷切换时的选中封面和离场封面改用 CanvasTexture 路径，避免 GPU 纹理读回后再复制。
- 设置页提供专辑与画面偏好、音量和动效选项。支持 F11 无边框全屏及 Per-Monitor V2 DPI。
- 图形路径为 **WebView2 → Chromium/ANGLE → WebGL 2 → Three.js**，并请求高性能 GPU。实际 GPU 选择和呈现能力取决于 Windows、WebView2 与显卡驱动。

## 发行说明

当前发行使用 `0.7.0` 版本号。应用界面显示实际的 WebView2 / WebGL 2 图形路径及 Bong712 维护者信息。帧率由具体设备的显示器、显卡和驱动决定；项目不以开发原型数据代替最终用户设备上的性能承诺。

详细改动见 [发行说明](RELEASE_NOTES_0.7.0.md) 和 [CHANGELOG.md](CHANGELOG.md)。

## 开发与构建

需要 Windows 10/11、Node.js 22.12+、npm、.NET Framework 4.6.2+ x64 编译工具和 WebView2 Evergreen Runtime。仓库包含构建所需的 WebView2 SDK 程序集及对应许可文件。

```powershell
npm ci
$releaseDir = Join-Path (Get-Location) 'outputs'
./scripts/build-windows.ps1 -WebView2Dir (Join-Path (Get-Location) 'sdk/lib') -OutputDirectory $releaseDir
```

构建脚本会分配新的 `0.6.0-dev.N` 版本，保留已有发行文件，并将 EXE 与版本清单输出到 `outputs/`。前端开发模式可用 `npm run dev`；独立音乐服务可用 `npm run music`。音乐服务只绑定本机 `127.0.0.1`。

## 来源、署名与许可

Windows 版开发者：[Bong712](https://github.com/Bong712)；特别鸣谢：[RonaldDeng](https://github.com/RonaldDeng)，感谢其 Rhine-Music-Demo 项目。原版界面基础来自 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)。本项目保留各自作者署名与 MIT 许可。直接依赖包括 Three.js、Rolling Number、music-metadata、OpenCC-JS，另使用 WebView2 SDK 与 MiSans 字体，版本和许可见 [第三方开源库与许可清单](THIRD-PARTY-NOTICES.md)、[NOTICE.md](NOTICE.md) 及 `public/licenses/`、`sdk/lib/`。

代码许可不自动覆盖原作模型、图标、音频采样、字体或其他非代码素材。上游说明明确指出，部分原作相关素材不属于 MIT 授权范围，来源标注也不构成再分发许可。完整资源来源和适用边界见 [NOTICE.md](NOTICE.md)。

## English

Rhine Music for Windows is a Windows desktop port of [RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo), with synchronized LRC lyric display added alongside playlist and playback-queue management. It is developed by [Bong712](https://github.com/Bong712), with special thanks to RonaldDeng. The 3D archive UI builds on [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI). See the notices for third-party licenses and asset attribution.
