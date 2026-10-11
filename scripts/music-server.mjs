import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs, createReadStream } from 'node:fs'
import { MusicLibraryStore, safeRootList, decodeTextBuffer } from './music-library.mjs'
import { PlaylistStore } from './playlists.mjs'
import { VideoLibraryStore, VIDEO_MIME } from './video-library.mjs'
import { findSubtitles, readSubtitleAsVtt } from './subtitles.mjs'

const AUDIO_EXTENSIONS = new Set(['.flac', '.wav', '.m4a', '.mp4', '.alac', '.dsf', '.dff', '.mp3', '.aac', '.aiff', '.aif', '.ogg', '.opus'])
const VIDEO_EXTENSIONS = new Set(VIDEO_MIME.keys())
const PLAYER_SETTINGS_FILE = 'player-settings.json'
const DECODE_MODES = new Set(['auto', 'hardware', 'software'])

/** Playback preferences the desktop host reads before it creates the WebView2 environment. */
async function readPlayerSettings(dataDir) {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, PLAYER_SETTINGS_FILE), 'utf8'))
    return { decode: DECODE_MODES.has(stored.decode) ? stored.decode : 'auto' }
  } catch {
    return { decode: 'auto' }
  }
}

const VIDEO_PLAYLIST_FILE = 'video-playlist.json'

/** Video playlist: ordered ids only, hydrated from the live index so removals stay truthful. */
async function readVideoPlaylist(dataDir) {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, VIDEO_PLAYLIST_FILE), 'utf8'))
    return { version: 1, items: Array.isArray(stored.items) ? stored.items.filter((entry) => entry && typeof entry.id === 'string') : [] }
  } catch {
    return { version: 1, items: [] }
  }
}

async function writeVideoPlaylist(dataDir, value) {
  await fs.writeFile(path.join(dataDir, VIDEO_PLAYLIST_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return value
}

function videoPlaylistPayload(videos, stored) {
  const records = stored.items.map((entry) => videos?.record(entry.id)).filter(Boolean)
  return {
    version: 1,
    items: records.map((record) => videos.publicRecord(record)),
    missing: stored.items.length - records.length,
  }
}

/**
 * Resolves a track the user opened from the shell. Files inside a configured root only need a
 * rescan; files elsewhere are streamed directly for this session and never joined to the library.
 */async function openAudioFile(store, target) {
  const found = store.trackByPath(target)
  if (found) return { kind: 'audio', trackId: found.track.id, albumId: found.album.id }
  const roots = store.config.roots ?? []
  if (roots.some((root) => pathIsWithin(root, target))) {
    if (!store.scanPromise) void store.scan().catch(() => {})
    return { kind: 'audio', scanning: true }
  }
  return {
    kind: 'audioFile',
    name: path.parse(target).name,
    fileName: path.basename(target),
    format: path.extname(target).slice(1).toUpperCase(),
    url: `/api/media?path=${encodeURIComponent(target)}`,
  }
}

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LYRIC_LIMIT = 1024 * 1024

function pathIsWithin(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function readTrackLyrics(store, trackId) {
  const track = store.trackPath(trackId)
  if (!track) return { found: false, text: '' }
  const [audioPath, rootPath] = await Promise.all([fs.realpath(track.path), fs.realpath(track.root)])
  if (!pathIsWithin(rootPath, audioPath)) throw Object.assign(new Error('歌曲已移出配置的音乐目录'), { status: 403 })
  const directory = path.dirname(audioPath)
  const stem = path.parse(audioPath).name.normalize('NFKC').toLocaleLowerCase('en-US')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const candidate = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLocaleLowerCase('en-US') === '.lrc' && path.parse(entry.name).name.normalize('NFKC').toLocaleLowerCase('en-US') === stem)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))[0]
  if (!candidate) return { found: false, text: '' }
  const lyricPath = path.join(directory, candidate.name)
  const actualLyricPath = await fs.realpath(lyricPath)
  if (!pathIsWithin(rootPath, actualLyricPath) || path.dirname(actualLyricPath) !== directory) return { found: false, text: '' }
  const stat = await fs.stat(actualLyricPath)
  if (!stat.isFile()) return { found: false, text: '' }
  if (stat.size > LYRIC_LIMIT) throw Object.assign(new Error('LRC 文件超过 1 MiB 限制'), { status: 413 })
  // Lyric files come from the same taggers as the audio, so they get the same encoding repair.
  return { found: true, text: decodeTextBuffer(await fs.readFile(actualLyricPath)) }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

async function bodyJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('请使用 application/json 请求体'), { status: 415 })
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 128 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 请求体必须是对象')
  return value
}

/** Returns null for no Range; false for invalid or unsatisfiable single ranges. */
export function parseRange(header, size) {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

async function serveFile(request, response, descriptor, { cache = 'no-cache' } = {}) {
  const [actualPath, actualRoot] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  const relative = path.relative(actualRoot, actualPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('文件已移出配置的音乐目录'), { status: 403 })
  const stat = await fs.stat(actualPath)
  if (!stat.isFile()) throw Object.assign(new Error('文件不存在'), { status: 404 })
  const range = parseRange(request.headers.range, stat.size)
  const headers = {
    'Content-Type': descriptor.mime ?? MIME[path.extname(actualPath).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': cache,
    'Last-Modified': stat.mtime.toUTCString(), 'X-Content-Type-Options': 'nosniff',
  }
  if (range === false) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 })
    response.end()
    return
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    headers['Content-Length'] = range.end - range.start + 1
  } else headers['Content-Length'] = stat.size
  response.writeHead(range ? 206 : 200, headers)
  if (request.method === 'HEAD' || stat.size === 0) return response.end()
  const stream = createReadStream(actualPath, range ?? {})
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

export async function createMusicServer({
  dataDir = process.env.MUSIC_DATA_DIR ?? path.join(PROJECT_DIR, '..', 'music-data-v3'),
  distDir = path.join(PROJECT_DIR, 'dist'),
  defaultRoots = process.env.MUSIC_ROOTS ? process.env.MUSIC_ROOTS.split(path.delimiter).filter(Boolean) : [],
  store: providedStore,
  playlistStore: providedPlaylistStore,
  videoStore: providedVideoStore,
  autoScan = true,
} = {}) {
  const store = providedStore ?? await new MusicLibraryStore({ dataDir, defaultRoots }).init()
  const playlists = providedPlaylistStore ?? await new PlaylistStore({ dataDir: store.dataDir }).init()
  // Injected stores (tests) omit the video index entirely; the desktop runtime builds it beside the music index.
  const videos = providedVideoStore ?? (providedStore
    ? null
    : await new VideoLibraryStore({ dataDir: store.dataDir, roots: () => store.config.roots }).init())
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    try {
      const host = new URL(`http://${request.headers.host ?? ''}`)
      if (!LOOPBACK.has(host.hostname)) return json(response, 403, { error: '本服务仅接受 localhost 请求' })
      const url = new URL(request.url, host)
      if (request.headers.origin && request.headers.origin !== host.origin) return json(response, 403, { error: '不接受跨站点访问本地曲库' })
      const route = decodeURIComponent(url.pathname)
      if (route.includes('\0') || route.includes('\\')) return json(response, 400, { error: '无效路径' })
      const get = request.method === 'GET' || request.method === 'HEAD'
      if (route === '/api/health' && get) return json(response, 200, { service: 'rhine-local-music', projectDir: PROJECT_DIR, pid: process.pid })
      if (route === '/api/library' && get) {
        // A user or Codex can edit genre-rules.json while the player is running.
        await store.reloadRules()
        return json(response, 200, store.snapshot())
      }
      if (route === '/api/library/scan' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (store.scanPromise) return json(response, 202, store.snapshot())
        const roots = value.roots === undefined ? undefined : safeRootList(value.roots)
        void store.scan({ roots }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/genre-rules' && get) {
        await store.reloadRules()
        return json(response, 200, store.rules)
      }
      if (route === '/api/genre-rules' && request.method === 'POST') return json(response, 200, await store.updateRules(await bodyJson(request)))
      if (['/api/config', '/api/library/config'].includes(route)) {
        if (get) return json(response, 200, { ...store.config, musicBrainzConfigured: !!store.musicBrainzContact })
        if (request.method === 'POST') {
          const value = await bodyJson(request)
          if (value.roots !== undefined && store.scanPromise) return json(response, 409, { error: '正在扫描，请完成后再更改根目录' })
          return json(response, 200, { ...await store.updateConfig(value), musicBrainzConfigured: !!store.musicBrainzContact })
        }
      }
      if (route === '/api/library/enrich' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (!store.musicBrainzContact) return json(response, 400, { error: '在线资料库尚未配置：请在资料库设置填写自己的联系邮箱或项目网址。音乐仍可本地播放。' })
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        void store.enrich({ albumIds: value.albumIds, force: true }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/library/introductions' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.length > 10000 || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        if (value.force !== undefined && typeof value.force !== 'boolean') return json(response, 400, { error: 'force 必须为布尔值' })
        void store.updateIntroductions({ albumIds: value.albumIds, force: value.force ?? false }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/playlists' && get) return json(response, 200, { version: 1, playlists: await playlists.list(store) })
      if (route === '/api/playlists' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (typeof value.name !== 'string') return json(response, 400, { error: 'name 必须是文本' })
        const playlist = await playlists.create(value.name)
        return json(response, 201, { playlist: (await playlists.list(store)).find((entry) => entry.id === playlist.id) })
      }
      const playlistTrack = /^\/api\/playlists\/([0-9a-f-]{36})\/tracks(?:\/([a-f0-9]{24}))?$/.exec(route)
      const playlistRoute = /^\/api\/playlists\/([0-9a-f-]{36})$/.exec(route)
      if (playlistTrack) {
        const [, playlistId, itemId] = playlistTrack
        if (request.method === 'POST' && !itemId) {
          const value = await bodyJson(request)
          const result = await playlists.addTracks(playlistId, value.trackIds, store)
          return json(response, 200, { ...result, playlist: (await playlists.list(store)).find((entry) => entry.id === playlistId) })
        }
        if (request.method === 'PUT' && !itemId) {
          const value = await bodyJson(request)
          await playlists.reorder(playlistId, value.itemIds)
          return json(response, 200, { playlist: (await playlists.list(store)).find((entry) => entry.id === playlistId) })
        }
        if (request.method === 'DELETE' && itemId) {
          await playlists.removeTrack(playlistId, itemId)
          return json(response, 200, { playlist: (await playlists.list(store)).find((entry) => entry.id === playlistId) })
        }
      }
      if (playlistRoute) {
        const [, playlistId] = playlistRoute
        if (request.method === 'PATCH') {
          const value = await bodyJson(request)
          if (typeof value.name !== 'string') return json(response, 400, { error: 'name 必须是文本' })
          await playlists.rename(playlistId, value.name)
          return json(response, 200, { playlist: (await playlists.list(store)).find((entry) => entry.id === playlistId) })
        }
        if (request.method === 'DELETE') {
          await playlists.delete(playlistId)
          return json(response, 200, { ok: true })
        }
      }
      const audio = /^\/api\/audio\/([a-zA-Z0-9-]+)$/.exec(route)
      const artwork = /^\/api\/artwork\/([a-zA-Z0-9-]+)$/.exec(route)
      if ((audio || artwork) && get) {
        const file = audio ? store.trackFile(audio[1]) : store.artworkFile(artwork[1])
        if (!file) return json(response, 404, { error: '索引中没有此文件' })
        return await serveFile(request, response, file, { cache: artwork ? 'private, max-age=3600' : 'private, no-cache' })
      }
      const lyrics = /^\/api\/lyrics\/(track-[A-Za-z0-9-]+)$/.exec(route)
      if (lyrics && get) return json(response, 200, await readTrackLyrics(store, lyrics[1]))
      if (route === '/api/videos' && get) return json(response, 200, videos?.snapshot() ?? { version: 1, scanning: false, roots: [], videos: [] })
      if (route === '/api/videos/scan' && request.method === 'POST') {
        if (videos) void videos.scan().catch(() => {})
        return json(response, 202, videos?.snapshot() ?? { version: 1, scanning: false, roots: [], videos: [] })
      }
      const videoFile = /^\/api\/video\/(video-[a-f0-9]{16})$/.exec(route)
      const videoPoster = /^\/api\/video-poster\/(video-[a-f0-9]{16})$/.exec(route)
      if ((videoFile || videoPoster) && get) {
        const descriptor = videos?.[videoPoster ? 'poster' : 'file'](videoFile ? videoFile[1] : videoPoster[1])
        if (!descriptor) return json(response, 404, { error: '索引中没有此视频' })
        return await serveFile(request, response, descriptor, { cache: videoPoster ? 'private, max-age=3600' : 'private, no-cache' })
      }
      if (route === '/api/foobar/status' && get) return json(response, 200, { configured: !!store.config.foobarBaseUrl, baseUrl: store.config.foobarBaseUrl, connected: false, note: 'configured 仅代表已保存地址；连接状态需读取 /api/foobar/player 实际响应。' })
      if (route.startsWith('/api/foobar/')) {
        if (!store.config.foobarBaseUrl) return json(response, 503, { error: 'foobar2000 / Beefweb 尚未配置连接' })
        const suffix = route.slice('/api/foobar/'.length)
        if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(suffix) || !['GET', 'POST'].includes(request.method)) return json(response, 400, { error: '不支持的 Beefweb 请求' })
        const target = new URL(`/api/${suffix}`, store.config.foobarBaseUrl)
        target.search = url.search
        const payload = request.method === 'POST' ? JSON.stringify(await bodyJson(request)) : undefined
        const upstream = await fetch(target, { method: request.method, body: payload, headers: payload ? { 'Content-Type': 'application/json' } : {}, signal: AbortSignal.timeout(5000), redirect: 'error' })
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' })
        response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      // Playback preferences, persisted where the desktop host can read them before startup.
      if (route === '/api/player' && get) return json(response, 200, await readPlayerSettings(store.dataDir))
      if (route === '/api/player' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (value.decode !== undefined && !DECODE_MODES.has(value.decode)) return json(response, 400, { error: '不支持的解码方式' })
        const settings = { ...await readPlayerSettings(store.dataDir), ...(value.decode === undefined ? {} : { decode: value.decode }) }
        await fs.writeFile(path.join(store.dataDir, PLAYER_SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
        return json(response, 200, settings)
      }
      // Video playlist: add from the grid, remove from the sidebar, fill or clear in bulk.
      if (route === '/api/video-playlist' && get) {
        return json(response, 200, videoPlaylistPayload(videos, await readVideoPlaylist(store.dataDir)))
      }
      if (route === '/api/video-playlist' && request.method === 'POST') {
        if (!videos) return json(response, 503, { error: '视频索引不可用' })
        const value = await bodyJson(request)
        const stored = await readVideoPlaylist(store.dataDir)
        const exists = (id) => stored.items.some((entry) => entry.id === id)
        const push = (id) => { if (!exists(id)) stored.items.push({ id, addedAt: new Date().toISOString() }) }
        if (value.action === 'add' && typeof value.id === 'string') push(value.id)
        else if (value.action === 'remove' && typeof value.id === 'string') stored.items = stored.items.filter((entry) => entry.id !== value.id)
        else if (value.action === 'clear') stored.items = []
        else if (value.action === 'fill') for (const item of videos.snapshot().videos) push(item.id)
        else return json(response, 400, { error: '不支持的播放列表操作' })
        await writeVideoPlaylist(store.dataDir, stored)
        return json(response, 200, videoPlaylistPayload(videos, stored))
      }
      // Shell integration: a file handed over by Explorer opens in the matching surface.
      if (route === '/api/open' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (typeof value.path !== 'string' || !value.path.trim()) return json(response, 400, { error: '缺少文件路径' })
        const target = path.resolve(value.path)
        const stat = await fs.stat(target).catch(() => null)
        if (!stat?.isFile()) return json(response, 404, { error: '文件不存在或不可读' })
        const extension = path.extname(target).toLowerCase()
        if (videos && VIDEO_MIME.has(extension)) {
          const record = await videos.adopt(target)
          if (record) return json(response, 200, { kind: 'video', video: videos.publicRecord(record) })
        }
        if (AUDIO_EXTENSIONS.has(extension)) return json(response, 200, await openAudioFile(store, target))
        return json(response, 400, { error: '尚不支持这种文件类型' })
      }
      // One-off streaming for a file the shell opened from outside the library.
      if (route === '/api/media' && get) {
        const requested = url.searchParams.get('path')
        const target = requested ? path.resolve(requested) : ''
        const extension = path.extname(target).toLowerCase()
        if (!target || (!AUDIO_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension))) {
          return json(response, 400, { error: '不支持的媒体文件' })
        }
        return await serveFile(request, response, {
          path: target,
          allowedRoot: path.dirname(target),
          mime: VIDEO_MIME.get(extension) ?? MIME[extension],
        })
      }
      const subtitleList = /^\/api\/subtitles\/(video-[a-f0-9]{16})$/.exec(route)
      if (subtitleList && get) {
        const source = videos?.sourcePath(subtitleList[1])
        if (!source) return json(response, 404, { error: '索引中没有此视频' })
        const entries = await findSubtitles(source)
        return json(response, 200, { subtitles: entries.map((entry, index) => ({ index, name: entry.name, label: entry.label, format: entry.format })) })
      }
      const subtitleFile = /^\/api\/subtitle\/(video-[a-f0-9]{16})\/(\d+)$/.exec(route)
      if (subtitleFile && get) {
        const source = videos?.sourcePath(subtitleFile[1])
        const entries = source ? await findSubtitles(source) : []
        const entry = entries[Number(subtitleFile[2])]
        if (!entry) return json(response, 404, { error: '没有该字幕' })
        const body = await readSubtitleAsVtt(entry.path, entry.format)
        response.writeHead(200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(body)
        return
      }
      if (route.startsWith('/api/')) return json(response, 404, { error: 'API 不存在或请求方法不支持' })
      if (!get) return json(response, 405, { error: '只接受 GET/HEAD' })
      const asset = path.resolve(distDir, `.${route === '/' ? '/index.html' : route}`)
      return await serveFile(request, response, { path: asset, allowedRoot: distDir }, { cache: route.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 400), { error: error.message })
      else response.destroy()
    }
  })
  server.requestTimeout = 30_000
  if (autoScan) server.once('listening', () => {
    void store.scan().catch(() => {})
    void videos?.scan().catch(() => {})
  })
  return { server, store, videoStore: videos }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port')
  const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT ?? 5173)
  const { server, store } = await createMusicServer()
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => {
    console.log(`Rhine Local Music  http://127.0.0.1:${port}/`)
    console.log(`音乐索引：${store.dataDir}`)
    console.log(`音乐目录：${store.config.roots.join('、') || '尚未配置，在界面添加目录'}`)
  })
  const close = () => { server.close(() => process.exit()); server.closeAllConnections() }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
