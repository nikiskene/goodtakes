import { useState } from 'react'
import { Brand } from './Brand'

const download = import.meta.env.VITE_DESKTOP_DOWNLOAD_URL ||
  'https://github.com/nikiskene/goodtakes/releases'

export default function Website() {
  const [playing, setPlaying] = useState(false)

  return <div className="website">
    <header className="site-header">
      <a href="#" aria-label="GoodTake home"><Brand /></a>
      <nav aria-label="Main navigation"><a href="#workflow">How it works</a><a className="header-cta" href={download}>Mac downloads <span aria-hidden="true">↗</span></a></nav>
    </header>

    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span className="live-dot" /> LOCAL REEL EDITOR FOR MAC</p>
          <h1>Find the part<br className="desktop-break" /> worth <em>sharing.</em></h1>
          <p className="hero-description">Drop in a talk or an interview. GoodTake finds the moments that work on their own and turns them into captioned reels you can review, adjust, and post.</p>
          <div className="hero-actions">
            <a className="primary hero-button" href={download}>Mac downloads <span aria-hidden="true">↗</span></a>
            <a className="text-link" href="#demo" onClick={() => setPlaying(true)}><span aria-hidden="true">▷</span> Watch sample cut</a>
          </div>
          <p className="hero-detail">Apple Silicon · Original iPhone MOV and MP4</p>
        </div>
        <div className="hero-demo" id="demo">
          <div className="monitor-bar"><span><i /> Sample reel</span><span>PRODUCT DEMO</span></div>
          <div className="monitor-body">
            <div className="monitor-grid" aria-hidden="true" />
            <span className="monitor-index" aria-hidden="true">GT / 01</span>
            {playing ? <video src="/sample-reel.mp4" poster="/sample-poster.jpg" controls playsInline autoPlay preload="metadata"
                aria-label="GoodTake captioned sample reel with synthesized narration" /> :
              <button className="demo-play" aria-label="Play sample reel" onClick={() => setPlaying(true)}>
                <img src="/sample-poster.jpg" alt="" width="360" height="640" />
                <span className="play-disc" aria-hidden="true">▶</span>
              </button>}
            <span className="monitor-format">9:16<br />VERTICAL</span>
          </div>
          <div className="monitor-footer"><span>SHENZHEN · SAMPLE CUT</span><span>CAPTIONED <i /></span></div>
        </div>
      </section>

      <section id="workflow" className="workflow">
        <h2>From recording to reel</h2>
        <div className="workflow-grid">
          <article><span className="workflow-icon" aria-hidden="true">↓</span><h3>Bring your footage</h3><p>AirDrop your original iPhone video to your Mac. Use one camera, a second angle, or a separate microphone.</p></article>
          <article><span className="workflow-icon" aria-hidden="true">▷</span><h3>Review the best takes</h3><p>Start with the strongest suggestion. Change the trim, angle, crop, or captions in one review screen.</p></article>
          <article><span className="workflow-icon" aria-hidden="true">↗</span><h3>Export when it’s ready</h3><p>Save a vertical or landscape MP4 and an optional SRT. Your recordings and edits stay on your Mac.</p></article>
        </div>
      </section>
    </main>
    <footer className="site-footer"><Brand /><a href="https://github.com/nikiskene/goodtakes">GitHub ↗</a></footer>
  </div>
}
