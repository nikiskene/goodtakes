import { useEffect, useRef, useState } from 'react'
import { Brand } from './Brand'
import { BrowserSession, MAX_FILE, type Sequence } from './web/session'
import { montage, suggest, srt, visibleCues, type Cut } from './web/editorial'

type Export = { url: string; file: File; captionsUrl: string | null }
type Shape = 'vertical' | 'landscape'

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

function sliderTime(seconds: number) {
  return Math.round(seconds * 100) / 100
}

export default function WebEditor() {
  const engine = useRef<BrowserSession | null>(null)
  const active = useRef<symbol | null>(null)
  const preview = useRef<HTMLVideoElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const voicePicker = useRef<HTMLInputElement>(null)
  const [sources, setSources] = useState<File[]>([])
  const [voice, setVoice] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [analysis, setAnalysis] = useState<Sequence | null>(null)
  const [brief, setBrief] = useState('')
  const [length, setLength] = useState(45)
  const [language, setLanguage] = useState('english')
  const [shape, setShape] = useState<Shape>('vertical')
  const [cuts, setCuts] = useState<Cut[]>([])
  const [selected, setSelected] = useState(0)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [time, setTime] = useState(0)
  const [burn, setBurn] = useState(true)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [previewUnavailable, setPreviewUnavailable] = useState(false)
  const [saved, setSaved] = useState<Export | null>(null)

  useEffect(() => () => engine.current?.stop(), [])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl) }, [sourceUrl])
  useEffect(() => () => {
    if (saved) {
      URL.revokeObjectURL(saved.url)
      if (saved.captionsUrl) URL.revokeObjectURL(saved.captionsUrl)
    }
  }, [saved])

  function clearReview() {
    setAnalysis(null)
    setCuts([])
    clearRender()
  }

  function clearRender() {
    setSaved(null)
    setPreviewUrl('')
  }

  function updateSources(next: File[]) {
    setSources(next)
    setSourceUrl(next.length === 1 ? URL.createObjectURL(next[0]) : '')
    setPreviewUnavailable(false)
    clearReview()
  }

  function fits(next: File[], recording: File | null) {
    if (next.reduce((total, file) => total + file.size, recording?.size ?? 0) <= MAX_FILE) return true
    setError('Use up to 220 MiB of video and audio combined.')
    return false
  }

  function addFiles(files: File[]) {
    if (!files.length) return
    setError('')
    if (files.some(file => !/\.(mov|mp4|m4v)$/i.test(file.name) && !/^video\/(quicktime|mp4|x-m4v)$/i.test(file.type))) {
      setError('Choose MOV or MP4 clips from Photos or Files.')
      return
    }
    const next = [...sources, ...files]
    if (fits(next, voice)) updateSources(next)
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...sources]
    const target = index + direction
    next[index] = next[target]
    next[target] = sources[index]
    updateSources(next)
  }

  function chooseVoice(file: File | null) {
    setError('')
    if (file && !file.type.startsWith('audio/') && !/\.(m4a|mp3|wav|aac|aif|aiff|caf|flac|ogg|opus|webm)$/i.test(file.name)) {
      setError('Choose an audio recording such as M4A, MP3 or WAV.')
      return
    }
    if (fits(sources, file)) {
      setVoice(file)
      clearReview()
    }
  }

  function select(cut: Cut, index: number) {
    setSelected(index)
    setStart(sliderTime(cut.start))
    setEnd(sliderTime(cut.end))
    setTime(cut.start)
    clearRender()
    if (preview.current) {
      preview.current.pause()
      preview.current.currentTime = cut.start
    }
  }

  async function work(initial: string, operation: (session: BrowserSession, update: (stage: string) => void, current: () => boolean) => Promise<void>) {
    if (active.current) return
    const job = Symbol()
    active.current = job
    const current = () => active.current === job
    const update = (message: string) => { if (current()) setStage(message) }
    setError('')
    update(initial)
    try {
      await operation(engine.current ??= new BrowserSession(), update, current)
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (current()) {
        active.current = null
        setStage('')
      }
    }
  }

  function cancel() {
    active.current = null
    engine.current?.stop()
    engine.current = null
    setStage('')
  }

  function find() {
    if (!sources.length) return
    void work('Preparing your recording', async (session, update, current) => {
      const result = await session.analyze(sources, voice, language, update)
      if (!current()) return
      const options = suggest(result.cues, length, result.duration, brief)
      const edited = montage(result.clips.map(clip => clip.frames / 30), result.cues, length, brief, Boolean(voice))
      if (edited.ranges) options.unshift(edited)
      setAnalysis(result)
      setCuts(options)
      select(options[0], 0)
    })
  }

  function renderReel(previewOnly: boolean) {
    if (!analysis) return
    void work(previewOnly ? 'Preparing preview' : 'Preparing export', async (session, update, current) => {
      const result = await session.export(analysis, {
        start, end, shape, captions: burn, preview: previewOnly, ranges: cuts[selected]?.ranges,
      }, update)
      if (!current()) return
      if (previewOnly) {
        setPreviewUrl(URL.createObjectURL(result.video))
        return
      }
      const name = `${sources[0].name.replace(/\.[^.]+$/, '') || 'goodtake'}-reel`
      setSaved({
        file: new File([result.video], `${name}.mp4`, { type: 'video/mp4' }),
        url: URL.createObjectURL(result.video),
        captionsUrl: result.cues.length
          ? URL.createObjectURL(new Blob([srt(result.cues)], { type: 'text/plain;charset=utf-8' })) : null,
      })
    })
  }

  async function share(exported: Export) {
    try {
      await navigator.share({ files: [exported.file], title: 'GoodTake reel' })
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError('The share menu did not open. Use Download MP4 to save the reel to Files.')
      }
    }
  }

  const reviewing = analysis !== null
  const editRanges = cuts[selected]?.ranges
  const currentCaptions = analysis ? (editRanges && !voice
    ? analysis.cues.filter(cue => editRanges.some(range => visibleCues([cue], range.start, range.end).length))
    : visibleCues(analysis.cues, start, end)) : []
  const caption = burn && currentCaptions.find(cue => cue.start <= time && cue.end > time)?.text
  const activeDuration = end - start
  const valid = Number.isFinite(activeDuration) && start >= 0 && !!analysis && end <= analysis.duration + .01 && activeDuration >= 1 && activeDuration <= 60.01

  function updateTrim(which: 'start' | 'end', value: number) {
    if (which === 'start') {
      setStart(value)
      if (preview.current) {
        preview.current.pause()
        preview.current.currentTime = value
      }
      setTime(value)
    } else setEnd(value)
    clearRender()
  }

  function sourcePlayer() {
    if (editRanges || sources.length > 1 || voice || previewUnavailable) {
      return <>
        {previewUrl && <video className="web-export-preview" src={previewUrl} controls playsInline preload="metadata" />}
        {!previewUrl && <button className="primary" disabled={!valid || !!stage} onClick={() => renderReel(true)}>Preview reel</button>}
      </>
    }
    return <div className={`web-player ${shape}`}>
      <video key={sourceUrl} ref={preview} src={sourceUrl} controls playsInline preload="metadata"
        onLoadedMetadata={e => { e.currentTarget.currentTime = start }}
        onError={() => setPreviewUnavailable(true)}
        onPlay={e => {
          const video = e.currentTarget
          if (video.currentTime < start || video.currentTime >= end - .08) video.currentTime = start
        }}
        onTimeUpdate={e => {
          const video = e.currentTarget
          if (!video.paused && video.currentTime >= end) video.pause()
          setTime(video.currentTime)
        }} />
      {caption && <p className="web-caption">{caption.toUpperCase()}</p>}
    </div>
  }

  return <div className="desktop-app web-editor">
    <header className="app-bar"><a href="/" aria-label="GoodTake home"><Brand /></a>
      {reviewing && <button type="button" disabled={!!stage} onClick={clearReview}>Edit sources</button>}</header>
    <main className="app-shell">
      <input ref={picker} aria-label="Video clips" type="file" accept="video/*,.mov,.mp4,.m4v" multiple hidden
        onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      <input ref={voicePicker} aria-label="Voice recording" type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.caf,.aiff" hidden
        onChange={e => { const file = e.target.files?.[0]; if (file) chooseVoice(file); e.target.value = '' }} />
      {stage && <div className="notice working" role="status"><span><i /> {stage}</span><button onClick={cancel}>Cancel</button></div>}
      {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
      {!reviewing && <div className="import-layout">
        <section className="surface stack">
          <div><span className="eyebrow">GOODTAKE WEB EDITOR</span><h1>Make a reel</h1>
            <p>Add clips from Photos or Files. GoodTake picks short excerpts and cuts them together into a reel.</p></div>
          <div className="drop-zone" onDragOver={e => e.preventDefault()} onDrop={e => {
            e.preventDefault()
            if (!stage) addFiles(Array.from(e.dataTransfer.files))
          }}>
            <div className="file-row">
              <span><strong>Video clips</strong><small>Up to three minutes of video and 220 MiB of files total</small></span>
              <button disabled={!!stage} onClick={() => picker.current?.click()}>Add clips</button>
            </div>
            {sources.map((file, index) => <div className="file-row" key={`${index}-${file.name}`}>
              <span><strong>{index + 1}. {file.name}</strong></span>
              <button disabled={!!stage || index === 0} aria-label={`Move clip ${index + 1} earlier`} onClick={() => move(index, -1)}>↑</button>
              <button disabled={!!stage || index === sources.length - 1} aria-label={`Move clip ${index + 1} later`} onClick={() => move(index, 1)}>↓</button>
              <button disabled={!!stage} aria-label={`Remove clip ${index + 1}`}
                onClick={() => updateSources(sources.filter((_, position) => position !== index))}>Remove</button>
            </div>)}
          </div>
          <div className="drop-zone">
            <div className="file-row">
              <span><strong>{voice?.name ?? 'Separate voice recording'}</strong><small>{voice ? 'Voice track selected' : 'Optional · e.g. an exported Voice Memo'}</small></span>
              <button disabled={!!stage} onClick={() => voicePicker.current?.click()}>{voice ? 'Change' : 'Add voice'}</button>
              {voice && <button disabled={!!stage} aria-label="Remove voice recording" onClick={() => chooseVoice(null)}>Remove</button>}
            </div>
            {voice && <p>Starts at the first clip and replaces the clips’ audio. Captions follow this recording.</p>}
          </div>
          <label>Creative brief <small>optional</small><textarea rows={2} maxLength={250} value={brief}
            placeholder="Find the moment I explain what surprised me in Shenzhen."
            onChange={e => setBrief(e.target.value)} disabled={!!stage} /></label>
          <div className="settings-row">
            <label>Target length<select value={length} onChange={e => setLength(Number(e.target.value))} disabled={!!stage}>
              <option value={30}>30 seconds</option><option value={45}>45 seconds</option><option value={60}>60 seconds</option></select></label>
            <label>Format<select value={shape} onChange={e => setShape(e.target.value as Shape)} disabled={!!stage}>
              <option value="vertical">Vertical · 9:16</option><option value="landscape">Landscape · 16:9</option></select></label>
            <label>Audio language<select value={language} onChange={e => setLanguage(e.target.value)} disabled={!!stage}>
              <option value="english">English</option><option value="german">German</option>
              <option value="spanish">Spanish</option><option value="french">French</option><option value="chinese">Chinese</option></select></label>
          </div>
          <button className="primary" disabled={!sources.length || !!stage} onClick={find}>Find takes <span aria-hidden="true">→</span></button>
        </section>
        <aside className="surface stack">
          <h2>First time on this device</h2>
          <p>GoodTake downloads the video engine and speech model when you click Find takes. Keep this tab open while it works.</p>
          <p>Your recordings stay on this device. The web editor saves a 720p MP4 you can share or download.</p>
        </aside>
      </div>}
      {analysis && <div className="review">
        <section className="surface player-column">
          <div className="section-heading"><h1>Review your reel</h1><small>{clock(Math.max(0, activeDuration))}</small></div>
          {sourcePlayer()}
        </section>
        <section className="surface stack">
          <h2>Suggested takes</h2>
          {!analysis.cues.length && <p>No clear speech was found. You can still trim and export the clip.</p>}
          {cuts.map((cut, index) => <button key={`${cut.start}-${cut.end}`} className="take-choice" aria-pressed={selected === index}
            disabled={!!stage} onClick={() => select(cut, index)}><span>{cut.opening}</span>
            <small>{cut.ranges ? `${cut.ranges.length} shots · ` : `${clock(cut.start)} to ${clock(cut.end)} · `}{Math.round(cut.end - cut.start)} seconds</small></button>)}
          {sources.length > 1 && analysis.duration <= 60 && <button disabled={!!stage}
            onClick={() => select({ start: 0, end: analysis.duration, opening: '' }, -1)}>Use full sequence</button>}
          {!editRanges && <div className="settings-row">
            <label>Start, sec<input type="number" min={0} max={end - 1} step="0.01" inputMode="decimal" value={start}
              disabled={!!stage} onChange={e => updateTrim('start', Number(e.target.value))} /></label>
            <label>End, sec<input type="number" min={start + 1} max={sliderTime(analysis.duration)} step="0.01" inputMode="decimal" value={end}
              disabled={!!stage} onChange={e => updateTrim('end', Number(e.target.value))} /></label>
          </div>}
          <label>Format<select value={shape} onChange={e => { setShape(e.target.value as Shape); clearRender() }} disabled={!!stage}>
            <option value="vertical">Vertical · 9:16</option><option value="landscape">Landscape · 16:9</option></select></label>
          {currentCaptions.length > 0 && <details><summary>Edit captions</summary><div className="caption-fields">
            {currentCaptions.map(cue => <label key={cue.id}>{clock(cue.start)}
              <textarea rows={2} maxLength={220} value={cue.text.toUpperCase()} disabled={!!stage} onChange={e => {
                const text = e.target.value
                setAnalysis({ ...analysis, cues: analysis.cues.map(item => item.id === cue.id ? { ...item, text } : item) })
                clearRender()
              }} /></label>)}</div></details>}
          <label className="check"><input type="checkbox" checked={burn} disabled={!!stage}
            onChange={e => { setBurn(e.target.checked); clearRender() }} /> Burn captions into video</label>
          {!valid && <p>Choose a clip between 1 and 60 seconds inside your recording.</p>}
          <button className="primary" disabled={!valid || !!stage} onClick={() => renderReel(false)}>Export MP4</button>
          {saved && <div className="stack export-box" role="region" aria-label="Finished reel">
            <h2>Your reel is ready</h2>
            <video className="web-export-preview" src={saved.url} controls playsInline preload="metadata" />
            <div className="actions">
              {navigator.canShare?.({ files: [saved.file] }) && <button onClick={() => void share(saved)}>Share reel</button>}
              <a className="web-download" href={saved.url} download={saved.file.name}>Download MP4</a>
              {saved.captionsUrl && <a className="web-download" href={saved.captionsUrl} download={saved.file.name.replace(/\.mp4$/, '.srt')}>Download SRT</a>}
            </div>
          </div>}
        </section>
      </div>}
    </main>
  </div>
}
