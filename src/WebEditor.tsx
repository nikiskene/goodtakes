import { useEffect, useRef, useState } from 'react'
import { Brand } from './Brand'
import { BrowserSession, MAX_FILE } from './web/session'
import { suggest, srt, visibleCues, type Cue, type Cut } from './web/editorial'

type Analysis = { duration: number; hdr: boolean; cues: Cue[] }
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
  const [source, setSource] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
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
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl) }, [sourceUrl])
  useEffect(() => () => {
    if (saved) {
      URL.revokeObjectURL(saved.url)
      if (saved.captionsUrl) URL.revokeObjectURL(saved.captionsUrl)
    }
  }, [saved])

  function choose(file: File) {
    setError('')
    if (file.size > MAX_FILE) {
      setError('This recording is over 220 MiB. Trim it in Photos and choose the shorter clip.')
      return
    }
    if (!/\.(mov|mp4|m4v)$/i.test(file.name)) {
      setError('Choose a MOV or MP4 recording from Photos or Files.')
      return
    }
    setSource(file)
    setSourceUrl(URL.createObjectURL(file))
    setPreviewUnavailable(false)
    setAnalysis(null)
    setCuts([])
    setSaved(null)
  }

  function select(cut: Cut, index: number) {
    setSelected(index)
    setStart(sliderTime(cut.start))
    setEnd(sliderTime(cut.end))
    setTime(cut.start)
    setSaved(null)
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
    if (!source) return
    void work('Preparing your recording', async (session, update, current) => {
      const result = await session.analyze(source, language, update)
      if (!current()) return
      const options = suggest(result.cues, length, result.duration, brief)
      setAnalysis(result)
      setCuts(options)
      select(options[0], 0)
    })
  }

  function exportReel() {
    if (!source || !analysis) return
    void work('Preparing export', async (session, update, current) => {
      const result = await session.export(source, {
        start, end, shape, cues: analysis.cues, captions: burn, hdr: analysis.hdr,
      }, update)
      if (!current()) return
      const name = `${source.name.replace(/\.[^.]+$/, '') || 'goodtake'}-reel`
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
  const currentCaptions = analysis ? visibleCues(analysis.cues, start, end) : []
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
    setSaved(null)
  }

  function sourcePlayer() {
    return <div className={`web-player ${shape}`}>
      {!previewUnavailable && <video key={sourceUrl} ref={preview} src={sourceUrl} controls playsInline preload="metadata"
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
        }} />}
      {!previewUnavailable && caption && <p className="web-caption">{caption}</p>}
      {previewUnavailable && <p className="web-playback-note">This browser can’t preview the original codec. You can review the trimmed MP4 after export.</p>}
    </div>
  }

  return <div className="desktop-app web-editor">
    <header className="app-bar"><a href="/" aria-label="GoodTake home"><Brand /></a>
      <button type="button" disabled={!!stage} onClick={() => picker.current?.click()}>Choose video</button></header>
    <main className="app-shell">
      <input ref={picker} type="file" accept="video/*,.mov,.mp4,.m4v" hidden
        onChange={e => { const file = e.target.files?.[0]; if (file) choose(file); e.target.value = '' }} />
      {stage && <div className="notice working" role="status"><span><i /> {stage}</span><button onClick={cancel}>Cancel</button></div>}
      {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
      {!reviewing && <div className="import-layout">
        <section className="surface stack">
          <div><span className="eyebrow">GOODTAKE WEB EDITOR</span><h1>Make a reel</h1>
            <p>Choose one recording from Photos or Files. GoodTake finds a short clip and adds captions on this device.</p></div>
          <div className="drop-zone" onDragOver={e => e.preventDefault()} onDrop={e => {
            e.preventDefault()
            if (!stage && e.dataTransfer.files[0]) choose(e.dataTransfer.files[0])
          }}>
            <div className="file-row"><span><strong>{source?.name || 'One MOV or MP4 recording'}</strong>
              <small>{source ? `${(source.size / 1024 ** 2).toFixed(1)} MiB` : 'Up to three minutes and 220 MiB'}</small></span>
              <button disabled={!!stage} onClick={() => picker.current?.click()}>{source ? 'Change' : 'Choose video'}</button></div>
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
          <button className="primary" disabled={!source || !!stage} onClick={find}>Find takes <span aria-hidden="true">→</span></button>
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
            <small>{clock(cut.start)} to {clock(cut.end)} · {Math.round(cut.end - cut.start)} seconds</small></button>)}
          <div className="settings-row">
            <label>Start, sec<input type="number" min={0} max={end - 1} step="0.01" inputMode="decimal" value={start}
              disabled={!!stage} onChange={e => updateTrim('start', Number(e.target.value))} /></label>
            <label>End, sec<input type="number" min={start + 1} max={sliderTime(analysis.duration)} step="0.01" inputMode="decimal" value={end}
              disabled={!!stage} onChange={e => updateTrim('end', Number(e.target.value))} /></label>
          </div>
          <label>Format<select value={shape} onChange={e => { setShape(e.target.value as Shape); setSaved(null) }} disabled={!!stage}>
            <option value="vertical">Vertical · 9:16</option><option value="landscape">Landscape · 16:9</option></select></label>
          {currentCaptions.length > 0 && <details><summary>Edit captions</summary><div className="caption-fields">
            {currentCaptions.map(cue => <label key={cue.id}>{clock(cue.start)}
              <textarea rows={2} maxLength={220} value={cue.text} disabled={!!stage} onChange={e => {
                const text = e.target.value
                setAnalysis({ ...analysis, cues: analysis.cues.map(item => item.id === cue.id ? { ...item, text } : item) })
                setSaved(null)
              }} /></label>)}</div></details>}
          <label className="check"><input type="checkbox" checked={burn} disabled={!!stage}
            onChange={e => { setBurn(e.target.checked); setSaved(null) }} /> Burn captions into video</label>
          {!valid && <p>Choose a clip between 1 and 60 seconds inside your recording.</p>}
          <button className="primary" disabled={!valid || !!stage} onClick={exportReel}>Export MP4</button>
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
