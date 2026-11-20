import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import manifest from './model-files.json'

let model: Promise<AutomaticSpeechRecognitionPipeline> | undefined
env.allowLocalModels = true
env.allowRemoteModels = false
env.localModelPath = `${self.location.origin}/models/${manifest.revision.slice(0, 12)}/`
env.backends.onnx.wasm!.numThreads = 1
delete env.backends.onnx.wasm!.wasmPaths

type Request = { audio: Float32Array; language: string }

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    const downloads = new Map<string, { loaded: number; total: number }>()
    model ??= pipeline('automatic-speech-recognition', manifest.name, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: event => {
        if (event.status === 'progress') {
          downloads.set(event.file, { loaded: event.loaded, total: event.total })
          const mb = Math.floor([...downloads.values()].reduce((n, item) => n + item.loaded, 0) / 1e6)
          self.postMessage({ stage: `Preparing speech model · ${mb} MB downloaded` })
        }
      },
    }).catch(error => {
      model = undefined
      throw error
    })
    const transcribe = await model
    self.postMessage({ stage: 'Transcribing on this device' })
    const result = await transcribe(data.audio, {
      return_timestamps: 'word',
      chunk_length_s: 27,
      stride_length_s: 4,
      task: 'transcribe',
      language: data.language,
    })
    const output = Array.isArray(result) ? result[0] : result
    self.postMessage({ chunks: output.chunks ?? [] })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
