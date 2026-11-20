import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import coreUrl from '@ffmpeg/core?url'
import wasmUrl from '@ffmpeg/core/wasm?url'
import fontUrl from '../../assets/DejaVuSans-Bold.ttf?url'
import { ass, cutCues, groupCaptions, type Cue, type SpeechItem } from './editorial'

export const MAX_FILE = 220 * 1024 ** 2
export const MAX_DURATION = 180
const eastAsianFont = 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'

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
    const name = /\.mov$/i.test(file.name) ? 'source.mov' : 'source.mp4'
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

  async analyze(file: File, language: string, stage: Work) {
    if (file.size > MAX_FILE) throw new Error('This recording is over 220 MiB. Trim it in Photos and try again.')
    await this.ready(stage)
    const data = await this.withFile(file, async name => {
      stage('Checking your recording')
      let duration = 0
      try {
        const lines: string[] = []
        const errors: string[] = []
        const record = ({ type, message }: { type: string; message: string }) => {
          if (type === 'stdout') lines.push(message)
          if (type === 'stderr') errors.push(message)
        }
        this.media.on('log', record)
        try {
          const status = await this.media.ffprobe(['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,color_transfer', '-of', 'json', '-i', name])
          if (!lines.length) throw new Error(`This video could not be read. ${errors.at(-1) || `Video engine status: ${status}`}`)
        } finally {
          this.media.off('log', record)
        }
        const metadata = JSON.parse(lines.join('\n')) as {
          format?: { duration?: string }
          streams?: { codec_type: string; color_transfer?: string; color_primaries?: string; color_space?: string }[]
        }
        duration = Number(metadata.format?.duration)
        if (!Number.isFinite(duration) || duration < 1) throw new Error('Choose a recording of at least one second.')
        if (duration > MAX_DURATION + .01) throw new Error('This recording is over three minutes. Trim it in Photos and try again.')
        if (!metadata.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('This video has no audio track.')
        const video = metadata.streams.find(stream => stream.codec_type === 'video')
        if (!video) throw new Error('Choose a file that contains a video track.')
        const hdr = ['arib-std-b67', 'smpte2084'].includes(video.color_transfer ?? '')
        stage('Reading audio')
        const complete = await this.media.exec(['-v', 'error', '-i', name, '-vn', '-af', 'aresample=16000:first_pts=0', '-ac', '1', '-ar', '16000', '-t', '180', '-f', 's16le', '/audio.pcm'])
        if (complete !== 0) throw new Error('The video engine could not decode the audio track.')
        const pcm = await this.media.readFile('/audio.pcm')
        if (typeof pcm === 'string' || pcm.length < 3200) throw new Error('There was not enough audio to transcribe.')
        const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        const audio = new Float32Array(Math.floor(samples.byteLength / 2))
        for (let i = 0; i < audio.length; i++) audio[i] = samples.getInt16(i * 2, true) / 32768
        return { audio, duration, hdr }
      } finally {
        await this.media.deleteFile('/audio.pcm').catch(() => {})
      }
    })
    const chunks = await this.transcribe(data.audio, language, stage)
    const cues = groupCaptions(chunks, data.duration)
    return { cues, duration: data.duration, hdr: data.hdr }
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

  async export(file: File, options: {
    start: number; end: number; shape: Shape; cues: Cue[]; captions: boolean; hdr: boolean
  }, stage: Work) {
    const { start, end, shape, cues, captions, hdr } = options
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 1 || end - start > 60.01) {
      throw new Error('Choose a clip between 1 and 60 seconds.')
    }
    // Speech model memory is no longer needed while the browser encodes the reel.
    this.speech?.terminate()
    this.speech = undefined
    await this.ready(stage)
    const [width, height] = shape === 'vertical' ? [720, 1280] : [1280, 720]
    const outputCues = cutCues(cues, start, end)
    const burn = captions && outputCues.length > 0
    let tempFont: string | undefined
    if (burn) {
      const useCjk = outputCues.some(cue => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(cue.text))
      if (useCjk) stage('Loading the caption font')
      const font = await fetch(useCjk ? eastAsianFont : fontUrl)
      if (!font.ok) throw new Error('The caption font could not load. Retry export or turn off burned captions and save the SRT.')
      tempFont = useCjk ? '/fonts/NotoSansCJKsc-Regular.otf' : '/fonts/DejaVuSans-Bold.ttf'
      await this.media.writeFile(tempFont, new Uint8Array(await font.arrayBuffer()))
      await this.media.writeFile('/captions.ass', ass(outputCues, width, height, useCjk ? 'Noto Sans CJK SC' : 'DejaVu Sans'))
    }
    stage('Rendering MP4 on this device')
    const duration = end - start
    const progress = ({ time }: { time: number }) => stage(`Rendering MP4 · ${Math.max(0, Math.min(99, Math.floor(time / 1e4 / duration)))}%`)
    this.media.on('progress', progress)
    try {
      return await this.withFile(file, async name => {
        const filters = [
          `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2`,
          `crop=${width}:${height}`, 'setsar=1', 'fps=30',
          ...(hdr ? ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=mobius:desat=1.5',
            'zscale=t=bt709:m=bt709:r=limited'] : []),
          'format=yuv420p', ...(burn ? ['ass=/captions.ass:fontsdir=/fonts'] : []),
        ]
        const status = await this.media.exec([
          '-v', 'error', '-ss', start.toFixed(3), '-i', name, '-t', duration.toFixed(3),
          '-map', '0:v:0', '-map', '0:a:0', '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'ultrafast',
          '-crf', '23', '-threads', '1', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
          ...(hdr ? ['-color_trc', 'bt709', '-colorspace', 'bt709', '-color_primaries', 'bt709'] : []),
          '/reel.mp4',
        ])
        if (status !== 0) throw new Error(hdr ? 'This HDR video could not export in the browser. Try an SDR version of the clip.' : 'The browser could not render this recording. Try a shorter MOV or MP4.')
        const output = await this.media.readFile('/reel.mp4')
        if (typeof output === 'string' || !output.length) throw new Error('The export produced an empty video.')
        return { video: new Blob([new Uint8Array(output)], { type: 'video/mp4' }), cues: outputCues }
      })
    } finally {
      this.media.off('progress', progress)
      await this.media.deleteFile('/reel.mp4').catch(() => {})
      if (burn) await this.media.deleteFile('/captions.ass').catch(() => {})
      if (tempFont) await this.media.deleteFile(tempFont).catch(() => {})
    }
  }
}
