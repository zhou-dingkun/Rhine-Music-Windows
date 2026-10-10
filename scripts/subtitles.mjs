import path from 'node:path'
import { promises as fs } from 'node:fs'
import { decodeTextBuffer } from './music-library.mjs'

/**
 * Subtitle discovery and WebVTT conversion. Chromium only renders WebVTT tracks, so SRT and
 * ASS/SSA files are converted on the fly. Legacy Chinese encodings are repaired on read,
 * because most subtitle files shipped beside GBK-era releases are not UTF-8.
 */

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa'])
const SUBTITLE_DIRECTORIES = ['', 'subs', 'sub', 'subtitles', '字幕']
const LANGUAGE_LABELS = [
  [/(?:^|[.\-_\[( ])(?:chs|sc|zh-?cn|zh-?hans|简体|简中|中文简体)(?:$|[.\-_\]) ])/i, '简体中文'],
  [/(?:^|[.\-_\[( ])(?:cht|tc|zh-?tw|zh-?hk|zh-?hant|繁体|繁中|中文繁体)(?:$|[.\-_\]) ])/i, '繁体中文'],
  [/(?:^|[.\-_\[( ])(?:zh|chi|chinese|中文)(?:$|[.\-_\]) ])/i, '中文'],
  [/(?:^|[.\-_\[( ])(?:eng|en|english|英语|英文)(?:$|[.\-_\]) ])/i, 'English'],
  [/(?:^|[.\-_\[( ])(?:jpn|jp|ja|japanese|日语|日本語)(?:$|[.\-_\]) ])/i, '日本語'],
  [/(?:^|[.\-_\[( ])(?:kor|ko|korean|韩语|한국어)(?:$|[.\-_\]) ])/i, '한국어'],
]

function labelFor(fileName, stem) {
  const tail = path.parse(fileName).name.slice(stem.length)
  for (const [pattern, label] of LANGUAGE_LABELS) if (pattern.test(tail)) return label
  const cleaned = tail.replace(/[.\-_\[\]()]/g, ' ').trim()
  return cleaned || path.parse(fileName).name
}

/** Subtitle files that belong to a video: same name beside it, or in a conventional subfolder. */
export async function findSubtitles(videoPath) {
  const directory = path.dirname(videoPath)
  const stem = path.parse(videoPath).name.normalize('NFKC').toLocaleLowerCase('en-US')
  const found = []
  for (const subdirectory of SUBTITLE_DIRECTORIES) {
    const target = subdirectory ? path.join(directory, subdirectory) : directory
    const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLocaleLowerCase('en-US')
      if (!SUBTITLE_EXTENSIONS.has(extension)) continue
      const base = path.parse(entry.name).name.normalize('NFKC').toLocaleLowerCase('en-US')
      if (base !== stem && !base.startsWith(stem)) continue
      found.push({
        path: path.join(target, entry.name),
        name: entry.name,
        format: extension.slice(1),
        label: labelFor(entry.name, stem),
      })
    }
  }
  return found.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }))
}

const pad = (value, length = 2) => String(value).padStart(length, '0')

function timestamp(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor(safe / 60) % 60
  const secs = Math.floor(safe % 60)
  const millis = Math.round((safe - Math.floor(safe)) * 1000)
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`
}

function parseClock(value) {
  const match = /(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000
}

/** ASS uses centisecond stamps and inline override tags; both are rewritten for WebVTT. */
function assClock(value) {
  const match = /(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,2})/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(2, '0')) / 100
}

const cue = (start, end, text) => `${timestamp(start)} --> ${timestamp(end)}\n${text}\n`

function convertSrt(text) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length)
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue
    const times = lines[timeIndex].split('-->')
    const start = parseClock(times[0] ?? '')
    const end = parseClock(times[1] ?? '')
    if (start === null || end === null) continue
    cues.push(cue(start, end, lines.slice(timeIndex + 1).join('\n')))
  }
  return cues.join('')
}

function convertAss(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  const cues = []
  for (const raw of lines) {
    const line = raw.trim()
    if (/^Format:/i.test(line)) {
      fields = line.slice(line.indexOf(':') + 1).split(',').map((field) => field.trim().toLocaleLowerCase('en-US'))
      continue
    }
    if (!/^Dialogue:/i.test(line)) continue
    const payload = line.slice(line.indexOf(':') + 1)
    const parts = payload.split(',')
    const textIndex = fields.indexOf('text')
    if (textIndex < 0 || parts.length <= textIndex) continue
    const values = parts.slice(0, textIndex)
    const body = parts.slice(textIndex).join(',')
    while (values.length < textIndex) values.push('')
    const record = Object.fromEntries(fields.slice(0, textIndex).map((field, index) => [field, values[index] ?? '']))
    const start = assClock(record.start ?? '')
    const end = assClock(record.end ?? '')
    if (start === null || end === null) continue
    const clean = body
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .trim()
    if (!clean) continue
    cues.push(cue(start, end, clean))
  }
  return cues.join('')
}

/** Converts any supported subtitle payload into a WebVTT document. */
export function toWebVtt(text, format) {
  const header = 'WEBVTT\n\n'
  if (format === 'vtt') return /^WEBVTT/.test(text.trimStart()) ? text : header + text
  if (format === 'srt') return header + convertSrt(text)
  if (format === 'ass' || format === 'ssa') return header + convertAss(text)
  return header + text
}

export async function readSubtitleAsVtt(subtitlePath, format) {
  const text = decodeTextBuffer(await fs.readFile(subtitlePath))
  return toWebVtt(text, format)
}
