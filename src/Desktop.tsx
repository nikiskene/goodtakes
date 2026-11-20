import { useEffect, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open, save } from '@tauri-apps/plugin-dialog'
import { Brand } from './Brand'
import { Profile } from './Profile'
import type { Edit, Preferences, Project, Role, Take } from './types'

const roleNames: Record<Role, string> = { a: 'Camera A', b: 'Camera B', mic: 'External mic' }
const videoExtensions = ['mov', 'mp4', 'm4v']
const micExtensions = ['wav', 'm4a', 'mp3']
const roles: Role[] = ['a', 'b', 'mic']
type Sources = Partial<Record<Role, string>>
type ProjectLink = { id: string; name: string }
type Models = { speech: boolean; ranking: boolean }

function localPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem('goodtake.preferences') ?? '{}')
    return { aspect: value.aspect === 'landscape' ? 'landscape' : 'vertical', style: value.style === 'emphasis' ? 'emphasis' : 'editorial' }
  } catch { return { aspect: 'vertical', style: 'editorial' } }
}

function clock(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

export default function Desktop() {
  const [preferences, setPreferences] = useState(localPreferences)
  const [profile, setProfile] = useState(false)
  const [files, setFiles] = useState<Sources>({})
  const [projects, setProjects] = useState<ProjectLink[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [models, setModels] = useState<Models | null>(null)
  const [brief, setBrief] = useState('')
  const [duration, setDuration] = useState(45)
  const [semantic, setSemantic] = useState(true)
  const [offsets, setOffsets] = useState<Partial<Record<Role, string>>>({})
  const [job, setJob] = useState<string | null>(null)
  const currentJob = useRef<string | null>(null)
  const initialized = useRef(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [exported, setExported] = useState('')
  const [burn, setBurn] = useState(true)
  const [srt, setSrt] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [syncClip, setSyncClip] = useState<{ path: string; start: number } | null>(null)
  const [syncPosition, setSyncPosition] = useState(0)
  const [syncTools, setSyncTools] = useState(false)
  const [trimTools, setTrimTools] = useState(true)
  const [captions, setCaptions] = useState(false)
  const [timing, setTiming] = useState(0)
  const player = useRef<HTMLVideoElement>(null)

  function storePreferences(value: Preferences) {
    setPreferences(value)
    localStorage.setItem('goodtake.preferences', JSON.stringify(value))
  }

  function report(problem: unknown) {
    setError(problem instanceof Error ? problem.message : String(problem))
  }

  async function native<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (currentJob.current) throw new Error('A job is already running.')
    const id = crypto.randomUUID().replaceAll('-', '')
    currentJob.current = id
    setJob(id)
    setStage('Working locally')
    try { return await invoke<T>('run_job', { id, action, payload }) }
    finally {
      currentJob.current = null
      setJob(null)
      setStage('')
    }
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void (async () => {
      try {
        setProjects(await native<ProjectLink[]>('list'))
        setModels(await native<Models>('models'))
      } catch (e) { report(e) }
    })()
  }, [])

  useEffect(() => {
    if (!job) return
    const poll = window.setInterval(() => {
      void invoke<{ stage?: string }>('job_status', { id: job }).then(result => {
        if (result.stage && currentJob.current === job) setStage(result.stage)
      }).catch(() => {})
    }, 250)
    return () => window.clearInterval(poll)
  }, [job])

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === 'over' || event.payload.type === 'enter') setDragging(true)
      if (event.payload.type === 'leave' || event.payload.type === 'drop') setDragging(false)
      if (event.payload.type !== 'drop' || project || currentJob.current) return
      const paths = event.payload.paths
      setFiles(current => {
        const next = { ...current }
        for (const path of paths) {
          const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
          if (!next.mic && micExtensions.includes(extension)) next.mic = path
          if (videoExtensions.includes(extension) && !next.a) next.a = path
          else if (videoExtensions.includes(extension) && !next.b && path !== next.a) next.b = path
        }
        return next
      })
    })
    return () => { void unlisten.then(stop => stop()).catch(() => {}) }
  }, [project])

  function show(next: Project) {
    setProject(next)
    setEdit(next.edit)
    setTiming(0)
  }

  async function selectFile(role: Role, relink = false) {
    setError('')
    try {
      const filename = await open({ multiple: false, filters: [{
        name: roleNames[role], extensions: role === 'mic' ? micExtensions : videoExtensions,
      }] })
      if (typeof filename !== 'string') return
      if (relink && project) {
        show(await native<Project>('relink', { id: project.id, role, path: filename }))
      } else setFiles({ ...files, [role]: filename })
    } catch (e) { report(e) }
  }

  async function model(kind: 'speech' | 'ranking') {
    setError('')
    try {
      await native('download', { kind })
      setModels(await native<Models>('models'))
    } catch (e) { report(e) }
  }

  async function analyze() {
    setError('')
    let id = project?.id
    try {
      if (!id) {
        const next = await native<Project>('create', { sources: files })
        id = next.id
        show(next)
        setProjects(items => [{ id: next.id, name: next.name }, ...items])
      }
      show(await native<Project>('analyze', {
        id, brief, duration, semantic: semantic && !!models?.ranking, aspect: project?.edit ? project.aspect : preferences.aspect,
        captionStyle: edit?.captionStyle ?? preferences.style,
        offsets: Object.fromEntries(Object.entries(offsets).filter(([, val]) => val.trim()).map(([role, val]) => [role, Number(val)])),
      }))
      setOffsets({})
      setSyncClip(null)
    } catch (e) {
      report(e)
      if (id) {
        try { show(await native<Project>('open', { id })) } catch { /* Keep the last readable state. */ }
      }
    }
  }

  function patch(change: Partial<Edit>) {
    setEdit(current => current ? { ...current, ...change } : current)
  }

  async function refresh(change = edit) {
    if (!project || !change) return
    setError('')
    try { show(await native<Project>('preview', { id: project.id, edit: change })) }
    catch (e) { report(e) }
  }

  function selectTake(take: Take) {
    if (!edit || take.id === edit.candidate) return
    void refresh({ ...edit, candidate: take.id, start: take.start, end: take.end })
  }

  async function reopen(link: ProjectLink) {
    setError('')
    setExported('')
    setOffsets({})
    setSyncClip(null)
    try {
      const next = await native<Project>('open', { id: link.id })
      show(next)
      setBrief(next.brief ?? '')
      setDuration(next.target ?? 45)
    } catch (e) { report(e) }
  }

  async function previewAlignment(role: Role) {
    if (!project) return
    setError('')
    const entered = offsets[role]?.trim()
    try {
      setSyncClip(await native('alignment', {
        id: project.id, role, start: syncPosition, useSuggested: !entered,
        offset: entered ? Number(entered) : project.sync[role]?.offset ?? 0,
      }))
    } catch (e) { report(e) }
  }

  async function exportReel() {
    if (!project || !edit) return
    setError('')
    try {
      const filename = await save({ defaultPath: `${project.name}-reel.mp4`, filters: [{ name: 'Video', extensions: ['mp4'] }] })
      if (!filename) return
      const result = await native<{ path: string }>('export', { id: project.id, edit, path: filename, burn, srt })
      setExported(result.path)
    } catch (e) { report(e) }
  }

  const dirty = !!edit && (JSON.stringify(edit) !== JSON.stringify(project?.edit) || !project?.preview)
  const total = project?.plan?.duration ?? (edit ? edit.end - edit.start : 0)
  const presentPhrases = project?.phrases.filter(line => edit && line.end > edit.start - 0.01 && line.start < edit.end + 0.01) ?? []
  const weak = roles.filter(role => project?.sync[role]?.mode === 'weak')
  const blocking = job !== null

  return <div className="desktop-app">
    <header className="app-bar">
      <Brand />
      <div className="actions">
        <button disabled={blocking} onClick={() => {
          showEmpty(); setError(''); setFiles({}); setBrief(''); setDuration(45)
        }}>New project</button>
        <button onClick={() => setProfile(!profile)} aria-expanded={profile}>Profile</button>
      </div>
    </header>
    <main className="app-shell">
      {profile && <Profile preferences={preferences} onChange={storePreferences} onClose={() => setProfile(false)} />}
      {job && <div className="notice working" role="status"><span><i /> {stage}</span>
        <button onClick={() => void invoke('cancel_job', { id: job }).catch(report)}>Cancel</button></div>}
      {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
      {exported && <div className="notice" role="status"><span>Saved {exported}</span>
        <button onClick={() => void invoke('reveal_export').catch(report)}>Show in Finder</button></div>}
      {(!project || !edit) && <div className="import-layout">
        <section className="surface stack">
          <div><span className="eyebrow">LOCAL REEL EDITOR</span><h1>{project ? project.name : 'Make a reel'}</h1>
            <p>Start with one talk or interview. Add a second angle or a separate microphone if you have one.</p></div>
          {!project && <div className={`drop-zone ${dragging ? 'dragging' : ''}`}>
            <p>Drop recordings here or choose files</p>
            {roles.map(role => <div className="file-row" key={role}>
              <span><strong>{roleNames[role]}</strong><small>{files[role]?.split(/[\\/]/).at(-1) ?? (role === 'a' ? 'MOV or MP4' : 'Optional')}</small></span>
              <button disabled={blocking} onClick={() => void selectFile(role)}>{files[role] ? 'Change' : 'Choose'}</button>
              {files[role] && <button disabled={blocking} aria-label={`Remove ${roleNames[role]}`} onClick={() => setFiles({ ...files, [role]: undefined })}>×</button>}
            </div>)}
          </div>}
          {project && syncPanel(project)}
          {settings()}
          <button className="primary" disabled={blocking || !models?.speech || (!files.a && !project)}
            onClick={() => void analyze()}>Find takes <span aria-hidden="true">→</span></button>
        </section>
        <aside className="stack">
          {!models?.speech && <section className="surface stack"><h2>Set up local speech recognition</h2>
            <p>Download the 78 MB Whisper model once. Allow around 150 MB free for setup.</p>
            <button disabled={blocking || !models} onClick={() => void model('speech')}>Install speech model</button>
          </section>}
          {models?.speech && !models.ranking && <section className="surface stack"><h2>Optional editorial ranking</h2>
            <p>Download a 398 MB local model for semantic ranking. Allow around 470 MB free for setup.</p>
            <button disabled={blocking} onClick={() => void model('ranking')}>Install ranking model</button>
          </section>}
          <section className="surface stack"><h2>Recent projects</h2>
            {projects.length ? projects.map(item => <button className="recent" key={item.id} disabled={blocking}
              onClick={() => void reopen(item)}>{item.name}<span aria-hidden="true">↗</span></button>) : <p>Your projects will appear here.</p>}
          </section>
          <section className="surface stack"><h2>Import from iPhone</h2>
            <p>AirDrop the original video to your Mac or export the unmodified original from Photos. Select the MOV or MP4 here.</p>
          </section>
        </aside>
      </div>}
      {project && edit && <div className="review">
        <section className="player-column surface">
          <div className="section-heading"><h1>{project.name}</h1><small>{project.aspect === 'vertical' ? '9:16' : '16:9'}</small></div>
          <div className={`player-frame ${project.aspect}`}>
            {project.preview ? <video key={project.preview} ref={player} src={convertFileSrc(project.preview)} playsInline controls preload="metadata"
              onTimeUpdate={event => setTiming(event.currentTarget.currentTime)}
              onError={() => report('Could not load the preview. Update the preview to recreate it.')} /> : <p>Update the preview to watch this cut.</p>}
          </div>
          <label className="scrub"><span>{clock(timing)}</span><input aria-label="Scrub preview" type="range" min={0} max={total || 1} step={0.02}
            value={Math.min(timing, total)} disabled={!project.preview} onChange={event => {
              const time = Number(event.target.value)
              if (player.current) player.current.currentTime = time
              setTiming(time)
            }} /><span>{clock(total)}</span></label>
          {project.plan && <div className="angle-track" aria-label="Camera angle timeline">
            {project.plan.video.map((part, index) => <button key={index} className={part.role} type="button"
              style={{ flexGrow: part.outputEnd - part.outputStart }} onClick={() => {
                if (player.current) player.current.currentTime = part.outputStart
                setTiming(part.outputStart)
              }}>{part.role.toUpperCase()}</button>)}</div>}
        </section>
        <section className="surface stack edit-panel">
          <div className="section-heading"><h2>Suggested takes</h2><small>{project.ranking}</small></div>
          {project.candidates.map(take => <button className="take-choice" key={take.id} disabled={blocking}
            aria-pressed={edit.candidate === take.id} onClick={() => selectTake(take)}>
            <span>{take.opening}</span><small>{clock(take.end - take.start)} · {take.reason}</small></button>)}
          <details open={trimTools} onToggle={e => setTrimTools(e.currentTarget.open)}>
            <summary>Trim and frame</summary>
            <div className="settings-row">
              <label>Start, sec<input type="number" min={project.sources.a?.start ?? 0} max={edit.end - 1} step="0.05" value={edit.start}
                onChange={e => patch({ start: Number(e.target.value) })} /></label>
              <label>End, sec<input type="number" min={edit.start + 1} max={project.sources.a?.duration} step="0.05" value={edit.end}
                onChange={e => patch({ end: Number(e.target.value) })} /></label>
            </div>
            <div className="actions">
              <button disabled={blocking || !project.phrases.some(line => line.start < edit.start - 0.12)}
                onClick={() => {
                  const previous = project.phrases.filter(line => line.start < edit.start - 0.12).at(-1)
                  if (previous) patch({ start: Math.max(project.sources.a?.start ?? 0, previous.start - 0.08) })
                }}>Restore previous line</button>
              <button disabled={blocking || !project.phrases.some(line => line.end > edit.end + 0.12)}
                onClick={() => {
                  const next = project.phrases.find(line => line.end > edit.end + 0.12)
                  if (next) patch({ end: Math.min(project.sources.a?.duration ?? next.end, next.end + 0.08) })
                }}>Restore next line</button>
            </div>
            <label>Camera angle<select value={edit.angle} onChange={e => patch({ angle: e.target.value as Edit['angle'] })}>
              <option value="auto">Automatic</option><option value="a">Camera A</option>
              {project.sources.b && <option value="b">Camera B where synced</option>}</select></label>
            <label>Crop position<input type="range" min={0} max={1} step={0.01} value={edit.crop} onChange={e => patch({ crop: Number(e.target.value) })} /></label>
            <label className="check"><input type="checkbox" checked={edit.tighten} onChange={e => patch({ tighten: e.target.checked })} /> Shorten long pauses</label>
          </details>
          <details open={captions} onToggle={e => setCaptions(e.currentTarget.open)}>
            <summary>Captions</summary>
            <label>Style<select value={edit.captionStyle} onChange={e => patch({ captionStyle: e.target.value as Preferences['style'] })}>
              <option value="editorial">Editorial</option><option value="emphasis">Word emphasis</option></select></label>
            <div className="caption-fields">{presentPhrases.map(line => <label key={line.id}>{clock(line.start)}
              <textarea rows={2} maxLength={180} value={edit.corrections[line.id] ?? line.text}
                onChange={e => patch({ corrections: { ...edit.corrections, [line.id]: e.target.value } })} /></label>)}</div>
          </details>
          <details open={syncTools || weak.length > 0 && !project.preview} onToggle={e => setSyncTools(e.currentTarget.open)}>
            <summary>Sources and sync {weak.length ? '· check alignment' : ''}</summary>
            {syncPanel(project)}
            <button disabled={blocking || !Object.values(offsets).some(value => value?.trim())} onClick={() => void analyze()}>Apply offsets and find takes</button>
          </details>
          <details><summary>Find different takes</summary>{settings()}
            <button disabled={blocking} onClick={() => void analyze()}>Analyze again</button></details>
          <div className="export-box stack">
            {dirty && <button disabled={blocking} onClick={() => void refresh()}>Update preview and save edits</button>}
            <div className="actions">
              <label className="check"><input type="checkbox" checked={burn} onChange={e => setBurn(e.target.checked)} /> Burn in captions</label>
              <label className="check"><input type="checkbox" checked={srt} onChange={e => setSrt(e.target.checked)} /> Save SRT</label>
            </div>
            <button className="primary" disabled={blocking || dirty} onClick={() => void exportReel()}>Export MP4 <span aria-hidden="true">↗</span></button>
          </div>
        </section>
      </div>}
    </main>
  </div>

  function showEmpty() {
    setProject(null); setEdit(null); setOffsets({}); setExported(''); setTiming(0); setSyncClip(null)
  }

  function syncPanel(source: Project) {
    return <div className="stack">
      <SyncPanel project={source} offsets={offsets} setOffsets={setOffsets} selectFile={selectFile}
        previewAlignment={previewAlignment} busy={blocking} />
      {(source.sources.b || source.sources.mic) && <label>Alignment preview start, sec
        <input type="number" min={0} step={0.1} value={syncPosition} onChange={e => setSyncPosition(Number(e.target.value))} /></label>}
      {syncClip && <div className="sync-preview">
        <small>Alignment preview from {clock(syncClip.start)}</small>
        <video key={syncClip.path} src={convertFileSrc(syncClip.path)} controls playsInline preload="metadata" />
      </div>}
    </div>
  }

  function settings() {
    return <div className="stack">
      <label>Creative brief <small>optional</small><textarea value={brief} maxLength={350} rows={2}
        placeholder="Find the moment I explain what surprised me in Shenzhen." onChange={e => setBrief(e.target.value)} /></label>
      <div className="settings-row">
        <label>Target length<select value={duration} onChange={e => setDuration(Number(e.target.value))}>
          <option value={30}>30 seconds</option><option value={45}>45 seconds</option><option value={60}>60 seconds</option></select></label>
        {!project?.edit && <label>Format<select value={preferences.aspect} onChange={e => storePreferences({ ...preferences, aspect: e.target.value as Preferences['aspect'] })}>
          <option value="vertical">Vertical · 9:16</option><option value="landscape">Landscape · 16:9</option></select></label>}
        {!project?.edit && <label>Caption style<select value={preferences.style} onChange={e => storePreferences({ ...preferences, style: e.target.value as Preferences['style'] })}>
          <option value="editorial">Editorial</option><option value="emphasis">Word emphasis</option></select></label>}
      </div>
      <label className="check"><input type="checkbox" checked={semantic && !!models?.ranking} disabled={!models?.ranking}
        onChange={e => setSemantic(e.target.checked)} /> {models?.ranking ? 'Use local semantic ranking' : 'Heuristic ranking · optional model not installed'}</label>
    </div>
  }
}

function SyncPanel({ project, offsets, setOffsets, selectFile, previewAlignment, busy }: {
  project: Project; offsets: Partial<Record<Role, string>>; setOffsets: (offsets: Partial<Record<Role, string>>) => void
  selectFile: (role: Role, relink: boolean) => Promise<void>; previewAlignment: (role: Role) => Promise<void>; busy: boolean
}) {
  return <div className="stack">
    {roles.filter(role => project.sources[role]).map(role => {
      const source = project.sources[role]
      const status = project.sync[role]
      return <div className="source-item" key={role}>
        <div className="file-row"><span><strong>{roleNames[role]}</strong><small>{source?.name}</small></span>
          <button disabled={busy} onClick={() => void selectFile(role, true)}>Relink</button></div>
        {role !== 'a' && <label>Offset in seconds
          <input type="number" step="0.005" value={offsets[role] ?? ''}
            placeholder={status ? status.offset.toFixed(3) : 'Auto'}
            onChange={e => setOffsets({ ...offsets, [role]: e.target.value })} />
          <small>{status?.mode === 'weak' ? 'No reliable audio match. Set the source timestamp that aligns with Camera A at 0:00.'
            : status?.mode === 'auto' ? `Audio match · ${Math.round(status.confidence * 100)}% correlation · ${((status.rate - 1) * 1000).toFixed(1)} ms/s drift`
            : 'Positive means this source starts before Camera A.'}</small>
        </label>}
        {role !== 'a' && <button disabled={busy} onClick={() => void previewAlignment(role)}>Preview alignment</button>}
      </div>
    })}
  </div>
}
