import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { writeJsonAtomic } from './music-library.mjs'

/** Video containers the local service will index. MIME values feed the Range streaming endpoint. */
export const VIDEO_MIME = new Map(Object.entries({
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.flv': 'video/x-flv', '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.wmv': 'video/x-ms-wmv',
  '.3gp': 'video/3gpp', '.ogv': 'video/ogg',
}))
const IMAGE_MIME = new Map(Object.entries({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp',
}))
const POSTER_STEMS = ['poster', 'cover', 'folder', 'fanart', 'thumb', 'thumbnail', 'default']
const SKIP_DIRECTORIES = new Set(['node_modules', '$recycle.bin', 'system volume information', 'recycler', '.git', '.cache', '.trash'])
const MAX_DEPTH = 6
const MAX_VIDEOS = 4000
// Bumping this discards cached container metadata so improved parsers take effect on rescan.
const INDEX_VERSION = 3

const extensionOf = (name) => path.extname(name).toLocaleLowerCase('en-US')
const stemOf = (name) => path.parse(name).name.normalize('NFKC').toLocaleLowerCase('en-US')

export function videoId(filePath) {
  return `video-${createHash('sha1').update(path.resolve(filePath).toLocaleLowerCase('en-US')).digest('hex').slice(0, 16)}`
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Enumerates video files, remembering same-name or conventional poster images found beside them. */
async function walkVideos(directory, root, depth, found) {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  const posters = new Map()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const extension = extensionOf(entry.name)
    if (IMAGE_MIME.has(extension) && !posters.has(stemOf(entry.name))) posters.set(stemOf(entry.name), entry.name)
  }
  const conventional = POSTER_STEMS.map((stem) => posters.get(stem)).find(Boolean)
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))) await walkVideos(full, root, depth + 1, found)
      continue
    }
    if (!entry.isFile()) continue
    const extension = extensionOf(entry.name)
    if (!VIDEO_MIME.has(extension)) continue
    found.push({ file: full, root, posterName: posters.get(stemOf(entry.name)) ?? conventional })
    if (found.length >= MAX_VIDEOS) return
  }
}

/** Reads duration and the first video track's shape without decoding frames. */
const HEAD_BYTES = 2 * 1024 * 1024
const ISO_BASE_MEDIA = new Set(['.mp4', '.m4v', '.mov', '.3gp'])
const MATROSKA = new Set(['.webm', '.mkv'])

const ISO_VIDEO_CODECS = new Map(Object.entries({
  avc1: 'H.264 / AVC', avc3: 'H.264 / AVC', hvc1: 'H.265 / HEVC', hev1: 'H.265 / HEVC',
  vp09: 'VP9', av01: 'AV1', mp4v: 'MPEG-4 Visual', apch: 'ProRes',
}))
const ISO_AUDIO_CODECS = new Map(Object.entries({
  mp4a: 'AAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', alac: 'ALAC', Opus: 'Opus', opus: 'Opus',
  twos: 'PCM', sowt: 'PCM', lpcm: 'PCM', '.mp3': 'MP3', 'dtsc': 'DTS', 'dtsh': 'DTS', 'dtsl': 'DTS',
}))
const MATROSKA_CODECS = new Map(Object.entries({
  'V_MPEG4/ISO/AVC': 'H.264 / AVC', 'V_MPEGH/ISO/HEVC': 'H.265 / HEVC', V_VP8: 'VP8', V_VP9: 'VP9',
  V_AV1: 'AV1', 'V_MPEG4/ISO/ASP': 'MPEG-4 Visual', V_MPEG2: 'MPEG-2', V_THEORA: 'Theora',
  A_AAC: 'AAC', A_AC3: 'AC-3', A_EAC3: 'E-AC-3', A_FLAC: 'FLAC', A_OPUS: 'Opus', A_VORBIS: 'Vorbis',
  'A_MPEG/L3': 'MP3', A_DTS: 'DTS', 'A_PCM/INT/LIT': 'PCM', A_TRUEHD: 'TrueHD', A_MLP: 'MLP',
}))
const ISO_CONTAINERS = new Map(Object.entries({
  isom: 'MP4', iso2: 'MP4', iso4: 'MP4', iso5: 'MP4', iso6: 'MP4', mp41: 'MP4', mp42: 'MP4',
  avc1: 'MP4', M4V: 'M4V', M4A: 'M4A', qt: 'QuickTime (MOV)', '3gp4': '3GP', '3gp5': '3GP', dash: 'MP4 (DASH)',
}))

/** ISO base media (MP4/MOV): movie header, visual sample entry, audio entry and frame rate. */
export function parseIsoMedia(buffer) {
  const result = {}
  const brand = buffer.length > 12 && buffer.toString('latin1', 4, 8) === 'ftyp'
    ? buffer.toString('latin1', 8, 12)
    : null
  if (brand) result.container = ISO_CONTAINERS.get(brand) ?? brand.toUpperCase()
  const header = buffer.indexOf('mvhd', 0, 'latin1')
  if (header > 0) {
    const version = buffer[header + 4]
    const timescale = version === 1 ? buffer.readUInt32BE(header + 24) : buffer.readUInt32BE(header + 16)
    const duration = version === 1 ? Number(buffer.readBigUInt64BE(header + 28)) : buffer.readUInt32BE(header + 20)
    if (timescale > 0 && Number.isFinite(duration)) result.duration = duration / timescale
  }
  // The ftyp brand list also contains codec-like names, so only a sample entry with a
  // plausible picture size counts as the visual track.
  let fallback = null
  for (const codec of ISO_VIDEO_CODECS.keys()) {
    for (let at = buffer.indexOf(codec, 0, 'latin1'); at > 0; at = buffer.indexOf(codec, at + 1, 'latin1')) {
      if (at + 32 > buffer.length) break
      const width = buffer.readUInt16BE(at + 28)
      const height = buffer.readUInt16BE(at + 30)
      if (width > 0 && width <= 8192 && height > 0 && height <= 8192) {
        result.codec = codec
        result.videoCodec = ISO_VIDEO_CODECS.get(codec)
        result.width = width
        result.height = height
        break
      }
      fallback = fallback ?? codec
    }
    if (result.width) break
  }
  if (!result.videoCodec && fallback) {
    result.codec = fallback
    result.videoCodec = ISO_VIDEO_CODECS.get(fallback)
  }
  for (const codec of ISO_AUDIO_CODECS.keys()) {
    const at = buffer.indexOf(codec, 0, 'latin1')
    if (at <= 0 || at + 32 > buffer.length) continue
    const channels = buffer.readUInt16BE(at + 20)
    const sampleRate = buffer.readUInt32BE(at + 28) / 65536
    if (channels > 0 && channels <= 32 && sampleRate >= 8000 && sampleRate <= 384000) {
      result.audioCodec = ISO_AUDIO_CODECS.get(codec)
      result.audioChannels = channels
      result.audioSampleRate = Math.round(sampleRate)
      break
    }
  }
  // Frame rate: total sample count over the movie duration.
  const stts = buffer.indexOf('stts', 0, 'latin1')
  if (stts > 0 && stts + 16 < buffer.length && result.duration) {
    const entries = buffer.readUInt32BE(stts + 8)
    if (entries > 0 && entries < 4096) {
      let samples = 0
      for (let index = 0; index < entries; index += 1) {
        const at = stts + 12 + index * 8
        if (at + 8 > buffer.length) break
        samples += buffer.readUInt32BE(at)
      }
      if (samples > 0 && samples / result.duration < 1000) result.fps = Math.round((samples / result.duration) * 100) / 100
    }
  }
  return result
}

function ebmlHeader(buffer, offset) {
  const first = buffer[offset]
  if (!first) return null
  let length = 1
  for (let bit = 0x80; bit > 0 && !(first & bit); bit >>= 1) length += 1
  if (length > 8 || offset + length > buffer.length) return null
  let value = first & (0xff >> length)
  let allOnes = value === (0xff >> length)
  for (let index = 1; index < length; index += 1) {
    const byte = buffer[offset + index]
    if (byte !== 0xff) allOnes = false
    value = value * 256 + byte
  }
  return { value, length, unknown: allOnes }
}

function ebmlId(buffer, offset) {
  const first = buffer[offset]
  if (!first) return null
  let length = 1
  for (let bit = 0x80; bit > 0 && !(first & bit); bit >>= 1) length += 1
  if (length > 4 || offset + length > buffer.length) return null
  // Element ids keep their length descriptor, so the raw bytes are the id.
  return { value: buffer.readUIntBE(offset, length), length }
}
function ebmlSize(buffer, offset) { return ebmlHeader(buffer, offset) }

/** Matroska/WebM: walk EBML headers for duration, track codecs, resolution and frame rate. */
export function parseMatroska(buffer) {
  const result = {}
  let timecodeScale = 1_000_000
  let rawDuration = null
  let docType = null
  let track = null
  const commitTrack = () => {
    if (!track) return
    if (track.type === 1) {
      result.videoCodec = MATROSKA_CODECS.get(track.codecId) ?? track.codecId ?? null
      result.width = track.width ?? null
      result.height = track.height ?? null
      if (track.defaultDuration) result.fps = Math.round((1e9 / track.defaultDuration) * 100) / 100
    } else if (track.type === 2) {
      result.audioCodec = MATROSKA_CODECS.get(track.codecId) ?? track.codecId ?? null
      result.audioChannels = track.channels ?? null
      result.audioSampleRate = track.sampleRate ? Math.round(track.sampleRate) : null
    }
    track = null
  }
  const walk = (start, end, depth) => {
    let cursor = start
    while (cursor < end - 1) {
      const id = ebmlId(buffer, cursor)
      if (!id) return
      const size = ebmlSize(buffer, cursor + id.length)
      if (!size) return
      const payload = cursor + id.length + size.length
      const limit = size.unknown ? end : Math.min(end, payload + size.value)
      if (limit <= cursor) return
      const text = () => (size.unknown ? '' : buffer.toString('utf8', payload, limit).replace(/\0+$/, ''))
      const number = () => (size.value ? Number(buffer.readUIntBE(payload, Math.min(8, size.value))) : 0)
      switch (id.value) {
        case 0x18538067: if (depth < 2) walk(payload, limit, depth + 1); break
        case 0x1549a966: if (depth < 3) walk(payload, limit, depth + 1); break
        case 0x1654ae6b: if (depth < 3) walk(payload, limit, depth + 1); break
        case 0xae:
          commitTrack()
          track = { type: 0 }
          if (depth < 4) walk(payload, limit, depth + 1)
          commitTrack()
          break
        // Track shape lives one level deeper, inside the Video and Audio elements.
        case 0xe0:
        case 0xe1:
          if (track && depth < 5) walk(payload, limit, depth + 1)
          break
        case 0x4282: docType = docType ?? text(); break
        case 0x2ad7b1: timecodeScale = number() || timecodeScale; break
        case 0x4489: rawDuration = size.value === 4 ? buffer.readFloatBE(payload) : size.value === 8 ? buffer.readDoubleBE(payload) : null; break
        case 0x83: if (track) track.type = number(); break
        case 0x86: if (track) track.codecId = text(); break
        case 0xb0: if (track) track.width = number(); break
        case 0xba: if (track) track.height = number(); break
        case 0x23e383: if (track) track.defaultDuration = number(); break
        case 0xb5: if (track && size.value) track.sampleRate = size.value === 4 ? buffer.readFloatBE(payload) : buffer.readDoubleBE(payload); break
        case 0x9f: if (track) track.channels = number(); break
      }
      if (size.unknown) return
      cursor = limit
    }
  }
  walk(0, buffer.length, 0)
  commitTrack()
  const duration = rawDuration && timecodeScale ? (rawDuration * timecodeScale) / 1e9 : null
  if (duration && duration > 0) result.duration = duration
  if (result.videoCodec || result.audioCodec) {
    result.container = docType === 'webm' ? 'WebM' : docType === 'matroska' ? 'Matroska (MKV)' : (result.videoCodec && /VP8|VP9|AV1/.test(result.videoCodec) ? 'WebM' : 'Matroska (MKV)')
  }
  return result
}

async function readVideoMetadata(file, size, extension) {
  const handle = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES))
    await handle.read(head, 0, head.length, 0)
    if (ISO_BASE_MEDIA.has(extension)) {
      const headResult = parseIsoMedia(head)
      if (headResult.duration !== undefined || size <= head.length) return headResult
      // Non-faststart files keep the movie header at the end of the file.
      const tail = Buffer.alloc(Math.min(size, HEAD_BYTES))
      await handle.read(tail, 0, tail.length, size - tail.length)
      const tailResult = parseIsoMedia(tail)
      // The tail holds moov and is authoritative; the head only contributes the ftyp container.
      const merged = { ...headResult, ...tailResult }
      if (headResult.container) merged.container = headResult.container
      merged.duration = tailResult.duration ?? headResult.duration
      return merged
    }
    if (MATROSKA.has(extension)) return parseMatroska(head)
    return {}
  } catch {
    return {}
  } finally {
    await handle.close()
  }
}

/** Poster images that belong to a video: same name beside it, or a folder-level cover. */
async function posterBeside(file) {
  const directory = path.dirname(file)
  const stem = stemOf(path.basename(file))
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const images = new Map()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const extension = extensionOf(entry.name)
    if (IMAGE_MIME.has(extension) && !images.has(stemOf(entry.name))) images.set(stemOf(entry.name), entry.name)
  }
  const match = images.get(stem) ?? POSTER_STEMS.map((name) => images.get(name)).find(Boolean)
  return match ? path.join(directory, match) : undefined
}

/** One record shape for both scanned and shell-opened files. */
function videoRecord({ id, file, root, size, mtime, extension, metadata, poster, external }) {
  const seconds = Number.isFinite(metadata.duration) && metadata.duration > 0 ? metadata.duration : null
  return {
    id,
    title: path.parse(file).name,
    fileName: path.basename(file),
    folder: path.basename(path.dirname(file)) || path.basename(root),
    relativePath: path.relative(root, file).split(path.sep).join('/') || path.basename(file),
    size,
    mtime,
    extension,
    duration: seconds,
    container: metadata.container ?? extension.slice(1).toUpperCase(),
    codec: metadata.codec ?? null,
    videoCodec: metadata.videoCodec ?? null,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    fps: metadata.fps ?? null,
    audioCodec: metadata.audioCodec ?? null,
    audioChannels: metadata.audioChannels ?? null,
    audioSampleRate: metadata.audioSampleRate ?? null,
    bitrate: seconds ? Math.round((size * 8) / seconds) : null,
    ...(external ? { external: true } : {}),
    _path: file,
    _root: root,
    _poster: poster,
  }
}

/**
 * Persistent index of playable local videos discovered under the configured music roots.
 * Only paths and derived metadata are stored; video files are never copied or modified.
 */
export class VideoLibraryStore {
  constructor({ dataDir, roots = () => [], maxVideos = MAX_VIDEOS }) {
    this.dataDir = path.resolve(dataDir)
    this.getRoots = roots
    this.maxVideos = maxVideos
    this.index = { version: INDEX_VERSION, scannedAt: null, roots: [], videos: [] }
    this.status = { running: false }
    this.scanPromise = null
    // Files opened from the shell stay streamable for this session without joining the library.
    this.adopted = new Map()
  }

  /** Public shape of a record, shared by the library snapshot and shell-opened files. */
  publicRecord(video) {
    return {
      id: video.id, title: video.title, fileName: video.fileName, folder: video.folder,
      relativePath: video.relativePath, size: video.size, mtime: video.mtime,
      duration: video.duration ?? null, container: video.container ?? null,
      codec: video.codec ?? null, videoCodec: video.videoCodec ?? null,
      width: video.width ?? null, height: video.height ?? null, fps: video.fps ?? null,
      audioCodec: video.audioCodec ?? null, audioChannels: video.audioChannels ?? null,
      audioSampleRate: video.audioSampleRate ?? null, bitrate: video.bitrate ?? null,
      extension: video.extension, hasPoster: !!video._poster,
      ...(video.external ? { external: true } : {}),
    }
  }

  /** Absolute path backing an id, so subtitle lookup works for indexed and adopted files alike. */
  sourcePath(id) {
    const record = this.adopted.get(id) ?? (this.index.videos ?? []).find((entry) => entry.id === id)
    return record?._path ?? null
  }

  /** Adopts a file the user opened from Explorer so it can stream without a library root. */
  async adopt(file) {
    const resolved = path.resolve(file)
    const extension = extensionOf(resolved)
    if (!VIDEO_MIME.has(extension)) return null
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat?.isFile()) return null
    const id = videoId(resolved)
    const cached = this.adopted.get(id)
    if (cached && cached.size === stat.size && cached.mtime === stat.mtime.toISOString()) return cached
    const metadata = await readVideoMetadata(resolved, stat.size, extension)
    const record = videoRecord({
      id, file: resolved, root: path.dirname(resolved), size: stat.size,
      mtime: stat.mtime.toISOString(), extension, metadata,
      poster: await posterBeside(resolved), external: true,
    })
    this.adopted.set(id, record)
    return record
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true })
    try {
      const stored = JSON.parse(await fs.readFile(path.join(this.dataDir, 'video-index.json'), 'utf8'))
      if (stored?.version === INDEX_VERSION && Array.isArray(stored.videos)) this.index = stored
    } catch {
      // A missing or unreadable index simply means the first scan starts from scratch.
    }
    return this
  }

  async saveIndex() {
    await writeJsonAtomic(path.join(this.dataDir, 'video-index.json'), this.index)
  }

  snapshot() {
    return {
      version: INDEX_VERSION,
      scanning: this.status.running,
      startedAt: this.status.startedAt,
      error: this.status.error,
      scannedAt: this.index.scannedAt ?? null,
      roots: this.index.roots ?? [],
      videos: (this.index.videos ?? []).map((video) => this.publicRecord(video)),
    }
  }

  /** Range-streaming descriptor for a single indexed or shell-opened video. */
  file(id) {
    const video = this.adopted.get(id) ?? (this.index.videos ?? []).find((entry) => entry.id === id)
    if (!video?._path) return null
    return { path: video._path, allowedRoot: video._root, mime: VIDEO_MIME.get(video.extension) ?? 'video/mp4' }
  }

  poster(id) {
    const video = this.adopted.get(id) ?? (this.index.videos ?? []).find((entry) => entry.id === id)
    if (!video?._poster) return null
    return { path: video._poster, allowedRoot: video._root, mime: IMAGE_MIME.get(extensionOf(video._poster)) ?? 'image/jpeg' }
  }

  async scan() {
    if (this.scanPromise) return this.scanPromise
    this.status = { running: true, startedAt: new Date().toISOString() }
    this.scanPromise = (async () => {
      try {
        const previous = new Map()
        for (const video of this.index.videos ?? []) if (video._path) previous.set(video._path, video)
        const roots = [...new Set((this.getRoots() ?? []).map((root) => path.resolve(root)))]
        const found = []
        const rootStatus = []
        for (const root of roots) {
          try {
            const stat = await fs.stat(root)
            if (!stat.isDirectory()) throw new Error('根目录不是文件夹')
            await walkVideos(root, root, 0, found)
            rootStatus.push({ path: root, status: 'online' })
          } catch (error) {
            rootStatus.push({ path: root, status: 'offline', error: error.message })
          }
        }
        found.sort((a, b) => a.file.localeCompare(b.file, 'zh-CN', { numeric: true, sensitivity: 'base' }))
        const videos = await mapLimit(found.slice(0, this.maxVideos), 4, async (entry) => {
          const stat = await fs.stat(entry.file).catch(() => null)
          if (!stat?.isFile()) return null
          const cached = previous.get(entry.file)
          const extension = extensionOf(entry.file)
          const unchanged = cached && cached.size === stat.size && cached.mtime === stat.mtime.toISOString()
          // The cached record is already in final shape; a fresh read returns parser output.
          const stored = unchanged
            ? {
                duration: cached.duration ?? null, container: cached.container ?? null, codec: cached.codec ?? null,
                videoCodec: cached.videoCodec ?? null, width: cached.width ?? null, height: cached.height ?? null,
                fps: cached.fps ?? null, audioCodec: cached.audioCodec ?? null,
                audioChannels: cached.audioChannels ?? null, audioSampleRate: cached.audioSampleRate ?? null,
              }
            : await readVideoMetadata(entry.file, stat.size, extension)
          const metadata = {
            ...stored,
            duration: Number.isFinite(stored.duration) && stored.duration > 0 ? Math.round(stored.duration * 1000) / 1000 : null,
          }
          return videoRecord({
            id: videoId(entry.file), file: entry.file, root: entry.root, size: stat.size,
            mtime: stat.mtime.toISOString(), extension: extensionOf(entry.file), metadata,
            poster: entry.posterName ? path.join(path.dirname(entry.file), entry.posterName) : undefined,
          })
        })
        this.index = {
          version: INDEX_VERSION,
          scannedAt: new Date().toISOString(),
          roots: rootStatus,
          videos: videos.filter(Boolean),
        }
        await this.saveIndex()
      } catch (error) {
        this.status.error = error.message
      } finally {
        this.status.running = false
        this.scanPromise = null
      }
    })()
    return this.scanPromise
  }
}

