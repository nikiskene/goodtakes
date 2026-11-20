import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import coreUrl from '@ffmpeg/core?url'
import wasmUrl from '@ffmpeg/core/wasm?url'
import fontUrl from '../../assets/DejaVuSans-Bold.ttf?url'
import { ass, cutCues, groupCaptions, type Cue, type Range, type VisualBeat, type SpeechItem } from './editorial'

export const MAX_FILE = 220 * 1024 ** 2
export const MAX_DURATION = 180
const eastAsianFont = 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'

const FPS = 30
type Clip = { file: File; frames: number; audio: boolean; hdr: boolean; visuals: VisualBeat[] }
export type Sequence = { clips: Clip[]; voice: File | null; duration: number; cues: Cue[] }
type Work = (stage: string) => void
type Shape = 'vertical' | 'landscape'
type SpeechResponse = { stage?: string; chunks?: SpeechItem[]; error?: string }

function absolute(url: string) {
  return new URL(url, document.baseURI).href
}

export class BrowserSession {
  private media = new FFmpeg()
  private speech?: Worker
  private rejectSpeech?: (reason: Error) => void

  async ready(stage: Work) {
    if (this.media.loaded) return
    stage('Loading the local video engine')
    await this.media.load({ coreURL: absolute(coreUrl), wasmURL: absolute(wasmUrl) })
    await this.media.createDir('/input')
    await this.media.createDir('/fonts')
  }

  stop() {
    this.media.terminate()
    this.speech?.terminate()
    this.speech = undefined
    this.rejectSpeech?.(new Error('Canceled'))
    this.rejectSpeech = undefined
  }

  /** File-backed mount gives FFmpeg random access without copying the source into its heap. */
  private async withFile<T>(file: File, operation: (name: string) => Promise<T>) {
    const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? 'media'
    const name = `source.${extension}`
    const input = new File([file], name, { type: file.type })
    if (!await this.media.mount(FFFSType.WORKERFS, { files: [input] }, '/input')) {
      throw new Error('The local video engine could not open this file.')
    }
    try {
      return await operation(`/input/${name}`)
    } finally {
      await this.media.unmount('/input').catch(() => {})
    }
  }

  private async probe(file: File) {
    return await this.withFile(file, async name => {
      const lines: string[] = []
      const record = ({ type, message }: { type: string; message: string }) => {
        if (type === 'stdout') lines.push(message)
      }
      this.media.on('log', record)
      try {
        await this.media.ffprobe(['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration,color_transfer', '-of', 'json', '-i', name])
        if (!lines.length) throw new Error(`GoodTake couldn’t read ${file.name}.`)
        return JSON.parse(lines.join('\n')) as {
          format?: { duration?: string }
          streams?: { codec_type: string; duration?: string; color_transfer?: string }[]
        }
      } finally {
        this.media.off('log', record)
      }
    })
  }

  private async readAudio(file: File, start: number, duration: number, rate: number, channels: number) {
    const result = new Uint8Array(Math.round(duration * rate) * channels * 2)
    if (duration <= 0) return result
    try {
      await this.withFile(file, async name => {
        const complete = await this.media.exec([
          '-v', 'error', '-ss', start.toFixed(6), '-i', name, '-map', '0:a:0', '-vn',
          '-af', `aresample=${rate}:first_pts=0,apad`, '-ac', String(channels), '-ar', String(rate),
          '-t', duration.toFixed(6), '-f', 's16le', '/decode.pcm',
        ])
        if (complete !== 0) throw new Error(`GoodTake couldn’t decode the audio in ${file.name}.`)
        const pcm = await this.media.readFile('/decode.pcm')
        if (typeof pcm !== 'string') result.set(pcm.subarray(0, result.length))
      })
      return result
    } finally {
      await this.media.deleteFile('/decode.pcm').catch(() => {})
    }
  }

  private async soundtrack(clips: Clip[], voice: File | null, startFrame: number, endFrame: number, rate: number, channels: number) {
    const sample = (frame: number) => Math.round(frame * rate / FPS)
    const bytes = channels * 2
    const result = new Uint8Array((sample(endFrame) - sample(startFrame)) * bytes)
    if (voice) {
      return await this.readAudio(voice, startFrame / FPS, (endFrame - startFrame) / FPS, rate, channels)
    }
    let frame = 0
    for (const clip of clips) {
      const inFrame = Math.max(startFrame, frame)
      const outFrame = Math.min(endFrame, frame + clip.frames)
      if (clip.audio && inFrame < outFrame) {
        const pcm = await this.readAudio(clip.file, (inFrame - frame) / FPS, (outFrame - inFrame) / FPS, rate, channels)
        const offset = (sample(inFrame) - sample(startFrame)) * bytes
        const length = (sample(outFrame) - sample(inFrame)) * bytes
        result.set(pcm.subarray(0, length), offset)
      }
      frame += clip.frames
    }
    return result
  }

  private async visualBeats(file: File, duration: number): Promise<VisualBeat[]> {
    const pixels = 32 * 24
    try {
      return await this.withFile(file, async name => {
        const result = await this.media.exec([
          '-v', 'error', '-threads', '1', '-i', name, '-an', '-map', '0:V:0',
          '-t', String(duration), '-vf', 'fps=3,scale=32:24:flags=area,format=gray',
          '-threads', '1', '-c:v', 'rawvideo', '-f', 'rawvideo', '/scenes.gray',
        ])
        if (result !== 0) return []
        const bytes = await this.media.readFile('/scenes.gray')
        if (typeof bytes === 'string') return []
        const beats: VisualBeat[] = []
        for (let at = 0; at + pixels <= bytes.length; at += pixels) {
          let light = 0
          let edge = 0
          let delta = 0
          for (let j = 0; j < pixels; j++) {
            const value = bytes[at + j]
            light += value
            if (j % 32) edge += Math.abs(value - bytes[at + j - 1])
            if (at) delta += Math.abs(value - bytes[at + j - pixels])
          }
          const brightness = light / pixels
          const motion = delta / pixels
          const exposure = Math.min(1, brightness / 40, (255 - brightness) / 35)
          const detail = Math.min(1, edge / pixels / 18)
          beats.push({
            time: (at / pixels + .5) / 3,
            change: Math.min(1, motion / 36),
            quality: .72 * exposure + .35 * detail + Math.min(.3, motion / 40) - Math.max(0, motion - 38) / 70,
          })
        }
        return beats
      })
    } finally {
      await this.media.deleteFile('/scenes.gray').catch(() => {})
    }
  }

  async analyze(files: File[], voice: File | null, language: string, stage: Work): Promise<Sequence> {
    if (!files.length) throw new Error('Add at least one video clip.')
    if (files.reduce((size, file) => size + file.size, voice?.size ?? 0) > MAX_FILE) {
      throw new Error('Use up to 220 MiB of video and audio combined.')
    }
    await this.ready(stage)
    const clips: Clip[] = []
    let frames = 0
    for (const [index, file] of files.entries()) {
      stage(`Checking clip ${index + 1} of ${files.length}`)
      const metadata = await this.probe(file)
      const video = metadata.streams?.find(stream => stream.codec_type === 'video')
      const duration = Number(video?.duration) || Number(metadata.format?.duration)
      if (!video || !Number.isFinite(duration) || duration < 1 / FPS) {
        throw new Error(`Choose a playable video for ${file.name}.`)
      }
      const clipFrames = Math.max(1, Math.round(duration * FPS))
      frames += clipFrames
      if (frames > MAX_DURATION * FPS) throw new Error('Use up to three minutes of video in total.')
      clips.push({
        file, frames: clipFrames, visuals: [], audio: metadata.streams?.some(stream => stream.codec_type === 'audio') ?? false,
        hdr: ['arib-std-b67', 'smpte2084'].includes(video.color_transfer ?? ''),
      })
    }
    if (frames < FPS) throw new Error('Add at least one second of video in total.')
    if (voice) {
      stage('Checking the voice recording')
      const metadata = await this.probe(voice)
      if (!metadata.streams?.some(stream => stream.codec_type === 'audio')) {
        throw new Error('Choose a voice recording with an audio track.')
      }
    }
    for (const [index, clip] of clips.entries()) {
      stage(`Looking for visual changes · clip ${index + 1} of ${clips.length}`)
      clip.visuals = await this.visualBeats(clip.file, clip.frames / FPS)
    }
    const duration = frames / FPS
    if (!voice && !clips.some(clip => clip.audio)) return { clips, voice, duration, cues: [] }
    stage(voice ? 'Reading the voice recording' : 'Reading audio from the clips')
    const pcm = await this.soundtrack(clips, voice, 0, frames, 16000, 1)
    const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const audio = new Float32Array(samples.byteLength / 2)
    let peak = 0
    for (let i = 0; i < audio.length; i++) {
      audio[i] = samples.getInt16(i * 2, true) / 32768
      peak = Math.max(peak, Math.abs(audio[i]))
    }
    const cues = peak > .002 ? groupCaptions(await this.transcribe(audio, language, stage), duration) : []
    return { clips, voice, duration, cues }
  }

  private transcribe(audio: Float32Array<ArrayBuffer>, language: string, stage: Work) {
    stage('Preparing the local speech model')
    const worker = this.speech ??= new Worker(new URL('./speech.worker.ts', import.meta.url), { type: 'module' })
    return new Promise<SpeechItem[]>((resolve, reject) => {
      this.rejectSpeech = reject
      worker.onmessage = ({ data }: MessageEvent<SpeechResponse>) => {
        if (data.stage) stage(data.stage)
        else {
          this.rejectSpeech = undefined
          if (data.error) reject(new Error(`Speech recognition could not start. ${data.error}`))
          else resolve(data.chunks ?? [])
        }
      }
      worker.onerror = event => {
        this.rejectSpeech = undefined
        this.speech?.terminate()
        this.speech = undefined
        reject(new Error(event.message || 'The speech worker stopped. Keep this tab open and try again.'))
      }
      worker.postMessage({ audio, language }, [audio.buffer])
    })
  }

  async export(sequence: Sequence, options: {
    start: number; end: number; shape: Shape; captions: boolean; preview?: boolean; ranges?: Range[]
  }, stage: Work) {
    const { start, end, shape, captions, preview } = options
    const ranges = (options.ranges ?? [{ start, end }]).map(range => ({
      start: Math.round(range.start * FPS),
      zoom: range.zoom ?? 1,
      end: Math.min(Math.round(sequence.duration * FPS), Math.round(range.end * FPS)),
    }))
    const totalFrames = ranges.reduce((sum, range) => sum + range.end - range.start, 0)
    if (ranges.some(range => !Number.isFinite(range.start) || !(range.end > range.start) || range.start < 0)
        || totalFrames < FPS || totalFrames > 60 * FPS) {
      throw new Error('Choose a reel between 1 and 60 seconds.')
    }
    this.speech?.terminate()
    this.speech = undefined
    await this.ready(stage)
    const [long, short] = preview ? [640, 360] : [1280, 720]
    const [width, height] = shape === 'vertical' ? [short, long] : [long, short]
    const continuousVoice = Boolean(sequence.voice && options.ranges)
    const audioRanges = continuousVoice ? [{ start: 0, end: totalFrames }] : ranges
    let cueOffset = 0
    const outputCues = audioRanges.flatMap(range => {
      const cues = cutCues(sequence.cues, range.start / FPS, range.end / FPS)
        .map(cue => ({ ...cue, start: cue.start + cueOffset, end: cue.end + cueOffset }))
      cueOffset += (range.end - range.start) / FPS
      return cues
    })
    const burn = captions && outputCues.length > 0
    const tempFiles = ['/captions.ass', '/sequence.txt', '/soundtrack.pcm', '/reel.mp4']
    const parts: { file: string; frames: number }[] = []
    let renderedFrames = 0
    let fontFamily = 'DejaVu Sans'

    try {
      if (burn) {
        const useCjk = outputCues.some(cue => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(cue.text))
        if (useCjk) stage('Loading the caption font')
        const font = await fetch(useCjk ? eastAsianFont : fontUrl)
        if (!font.ok) throw new Error('The caption font could not load. Retry export or turn off burned captions and save the SRT.')
        fontFamily = useCjk ? 'Noto Sans CJK SC' : 'DejaVu Sans'
        const tempFont = useCjk ? '/fonts/NotoSansCJKsc-Regular.otf' : '/fonts/DejaVuSans-Bold.ttf'
        tempFiles.push(tempFont)
        await this.media.writeFile(tempFont, new Uint8Array(await font.arrayBuffer()))
      }

      for (const { start: startFrame, end: endFrame, zoom } of ranges) {
        let sourceOffset = 0
        for (const clip of sequence.clips) {
          const clipStart = sourceOffset
          sourceOffset += clip.frames
          const inFrame = Math.max(startFrame, clipStart)
          const outFrame = Math.min(endFrame, sourceOffset)
          if (outFrame <= inFrame) continue
          const frames = outFrame - inFrame
          const begin = renderedFrames / FPS
          renderedFrames += frames
          const finish = renderedFrames / FPS
          const number = parts.length + 1
          const part = `/part-${number}.mp4`
          parts.push({ file: part, frames })
          tempFiles.push(part)
          stage(`${preview ? 'Preparing preview' : 'Rendering'} · clip ${number}`)
          const clipCues = outputCues.flatMap(cue => {
            return cue.start < finish && cue.end > begin
              ? [{ ...cue, start: Math.max(0, cue.start - begin), end: Math.min(finish, cue.end) - begin }]
              : []
          })
          if (burn) await this.media.writeFile('/captions.ass', ass(clipCues, width, height, fontFamily))
          const filters = [
            `scale=${Math.ceil(width * zoom / 2) * 2}:${Math.ceil(height * zoom / 2) * 2}:force_original_aspect_ratio=increase:force_divisible_by=2${clip.hdr ? '' : ':out_color_matrix=bt709'}`,
            `crop=${width}:${height}`, 'setsar=1', 'fps=30', 'setpts=PTS-STARTPTS', 'tpad=stop_mode=clone:stop_duration=0.1',
            ...(clip.hdr ? ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=mobius:desat=1.5',
              'zscale=t=bt709:m=bt709:r=limited'] : []),
            'format=yuv420p', ...(burn && clipCues.length ? ['ass=/captions.ass:fontsdir=/fonts'] : []),
          ]
          const status = await this.withFile(clip.file, name => this.media.exec([
            '-v', 'error', '-ss', ((inFrame - clipStart) / FPS).toFixed(6), '-i', name,
            '-map', '0:V:0', '-an', '-frames:v', String(outFrame - inFrame), '-vf', filters.join(','),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '1',
            '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-video_track_timescale', '30000', part,
          ]))
          if (status !== 0) throw new Error(`GoodTake couldn’t render ${clip.file.name}.`)
        }
      }

      stage('Adding the soundtrack')
      const pcm = new Uint8Array(totalFrames * 6400)
      let audioOffset = 0
      for (const range of audioRanges) {
        const segment = await this.soundtrack(sequence.clips, sequence.voice, range.start, range.end, 48000, 2)
        pcm.set(segment, audioOffset)
        audioOffset += segment.length
      }
      await this.media.writeFile('/soundtrack.pcm', pcm)
      await this.media.writeFile('/sequence.txt', parts.map(part => `file '${part.file}'\nduration ${(part.frames / FPS).toFixed(6)}\n`).join(''))
      const status = await this.media.exec([
        '-v', 'error', '-f', 'concat', '-safe', '0', '-i', '/sequence.txt',
        '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', '/soundtrack.pcm',
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
        '-video_track_timescale', '30000', '-movflags', '+faststart', '/reel.mp4',
      ])
      if (status !== 0) throw new Error('GoodTake couldn’t combine the video and soundtrack.')
      const output = await this.media.readFile('/reel.mp4')
      if (typeof output === 'string' || !output.length) throw new Error('The export produced an empty video.')
      return { video: new Blob([new Uint8Array(output)], { type: 'video/mp4' }), cues: outputCues }
    } finally {
      for (const file of tempFiles) await this.media.deleteFile(file).catch(() => {})
    }
  }
}
