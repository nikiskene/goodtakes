export type Cue = { id: number; start: number; end: number; text: string }
export type Range = { start: number; end: number; zoom?: number }
export type Cut = Range & { opening: string; ranges?: Range[] }

export type VisualBeat = { time: number; quality: number; change: number }
type Footage = { duration: number; visuals: VisualBeat[] }

export function montage(clips: Footage[], cues: Cue[], target: number, brief: string, voice: boolean): Cut {
  const fps = 30
  const total = clips.reduce((sum, clip) => sum + clip.duration, 0)
  const budget = Math.min(target, Math.max(1, total * .81))
  const rhythm = [1.05, 1.65, 2.2, 1.35, 2.6, 1.75, 2.0]
  const relevant = terms(brief)
  const ranges: Range[] = []
  let remaining = Math.round(budget * fps)
  let sourceOffset = 0
  let output = 0
  const insideSpeech = (at: number) => cues.some(cue => cue.start + .07 < at && cue.end - .07 > at)

  for (const { duration, visuals } of clips) {
    const keep = Math.min(duration, budget * duration / total)
    const count = Math.max(1, Math.round(keep / 1.8))
    const beats = Array.from({ length: count }, (_, i) => rhythm[(ranges.length + i) % rhythm.length])
    const weight = beats.reduce((sum, beat) => sum + beat, 0)
    let position = 0
    for (const [i, beat] of beats.entries()) {
      const share = beat / weight
      const left = position
      const right = Math.min(duration, left + duration * share)
      position = right
      let span = Math.min(right - left, keep * share)
      if (voice && i < beats.length - 1) {
        const nearby = cues.map(cue => cue.end - output)
          .filter(gap => gap >= Math.max(.8, span - .24) && gap <= Math.min(right - left, span + .18))
          .sort((a, b) => Math.abs(a - span) - Math.abs(b - span))[0]
        if (nearby !== undefined) span = nearby
      }
      const center = left + (right - left - span) / 2
      const nearbyCues = !voice ? cues.filter(cue => cue.end > sourceOffset + left && cue.start < sourceOffset + right) : []
      const candidates = [center, left, ...visuals.filter(visual => visual.time >= left && visual.time <= right - span)
        .map(visual => visual.time), ...nearbyCues.map(cue => cue.start - sourceOffset - .08)]
      const score = (start: number) => {
        const begin = sourceOffset + start
        const end = begin + span
        const sampled = visuals.filter(visual => visual.time >= start && visual.time < start + span)
        const quality = sampled.reduce((sum, visual) => sum + visual.quality, 0) / Math.max(1, sampled.length)
        const opening = sampled[0]?.change ?? 0
        const speech = nearbyCues.filter(cue => cue.start >= begin && cue.end <= end)
        const words = terms(speech.map(cue => cue.text).join(' '))
        const matches = [...relevant].filter(word => words.has(word)).length
        return quality + .35 * opening - .13 * Math.abs(start - center)
          + .65 * speech.length + 1.5 * matches
          - (!voice ? 1.4 * (Number(insideSpeech(begin)) + Number(insideSpeech(end))) : 0)
      }
      const bounded = candidates.filter(start => start >= left && start <= right - span + 1e-6)
      const best = bounded.map(start => ({ start, score: score(start) })).sort((a, b) => b.score - a.score)[0]?.start ?? center
      const start = Math.max(Math.ceil((sourceOffset + left) * fps - 1e-6), Math.round((sourceOffset + best) * fps))
      const end = Math.min(Math.floor((sourceOffset + right) * fps + 1e-6), start + Math.round(span * fps), start + remaining)
      if (end <= start) continue
      const similar = visuals.filter(visual => visual.time >= left && visual.time < right).every(visual => visual.change < .22)
      ranges.push({ start: start / fps, end: end / fps, zoom: i % 2 && similar ? 1.12 : undefined })
      remaining -= end - start
      output += (end - start) / fps
    }
    sourceOffset += duration
  }
  return output >= 1 - 1e-6 && ranges.length > 1
    ? { start: 0, end: output, ranges, opening: 'Quick-cut edit' }
    : { start: 0, end: Math.min(total, target), opening: 'Start of recording' }
}
export type SpeechItem = { text: string; timestamp: [number, number | null] }

export function groupCaptions(words: SpeechItem[], sourceLength: number) {
  const cues: Cue[] = []
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
  for (const word of words) {
    const [from, stop] = word.timestamp
    const text = word.text.trim()
    const to = Math.min(sourceLength, stop ?? sourceLength)
    if (!text || !Number.isFinite(from) || to <= from) continue
    const previous = cues.at(-1)
    const joiner = previous && cjk.test(previous.text.at(-1) ?? '') && cjk.test(text[0]) ? '' : ' '
    const combined = previous ? previous.text + joiner + text : text
    const room = cjk.test(combined) ? 24 : 57
    if (previous && from - previous.end < .42 && to - previous.start < 5 && combined.length <= room
        && (previous.end - previous.start < 1.2 || !/[.!?。！？]$/.test(previous.text))) {
      previous.end = Math.max(previous.end, to)
      previous.text = combined
    } else {
      cues.push({ id: cues.length, start: Math.max(0, from), end: to, text })
    }
  }
  return cues
}
const stopWords = new Set('find take short clip reel with from that this what about seconds second make give tell showing looking'.split(' '))

function terms(text: string) {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !stopWords.has(word)))
}

export function suggest(cues: Cue[], length: number, sourceLength: number, brief: string): Cut[] {
  const relevant = terms(brief)
  const choices: (Cut & { score: number })[] = []
  for (const [i, first] of cues.entries()) {
    for (const [j, last] of cues.slice(i).entries()) {
      const start = Math.max(0, first.start - .08)
      const end = Math.min(sourceLength, last.end + .10)
      const duration = end - start
      if (duration > 60 || duration > length + 13) break
      if (duration < Math.min(12, sourceLength * .85)) continue
      const selection = cues.slice(i, i + j + 1)
      const text = selection.map(cue => cue.text).join(' ')
      const set = terms(text)
      const relevance = [...relevant].filter(word => set.has(word)).length / Math.max(1, relevant.size)
      const speech = selection.reduce((sum, cue) => sum + cue.end - cue.start, 0) / duration
      const boundary = i === 0 || /[.!?。！？][”’"']?$/.test(cues[i - 1].text)
      const payoff = /[.!?。！？][”’"']?$/.test(last.text)
      const dependent = /^(and|but|also|because)\b/i.test(first.text)
      const score = Math.min(1, speech) + 2 * relevance + Number(boundary) * .65 + Number(payoff) * .65
        - Number(dependent) * .45 - Math.abs(duration - length) / 10 - (duration < 28 ? 1.4 : 0)
      choices.push({ start, end, opening: first.text, score })
    }
  }
  const cuts: Cut[] = []
  for (const choice of choices.sort((a, b) => b.score - a.score || a.start - b.start)) {
    const duplicates = cuts.some(other => {
      const intersection = Math.min(other.end, choice.end) - Math.max(other.start, choice.start)
      return intersection / Math.min(other.end - other.start, choice.end - choice.start) >= .52
    })
    if (!duplicates) cuts.push(choice)
    if (cuts.length === 3) break
  }
  return cuts.length ? cuts : [{ start: 0, end: Math.min(sourceLength, length), opening: cues[0]?.text || 'Start of recording' }]
}

export function visibleCues(cues: Cue[], start: number, end: number) {
  return cues.filter(cue => Math.min(end, cue.end) - Math.max(start, cue.start) >= .18)
}

export function cutCues(cues: Cue[], start: number, end: number) {
  return visibleCues(cues, start, end).filter(cue => cue.text.trim())
    .map(cue => ({ ...cue, start: Math.max(0, cue.start - start), end: Math.min(end, cue.end) - start }))
}

function stamp(time: number, ass: boolean) {
  const unit = ass ? 100 : 1000
  const total = Math.max(0, Math.round(unit * time))
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(Math.floor(total / (3600 * unit)), ass ? 1 : 2)}:${pad(Math.floor(total / (60 * unit)) % 60)}:${pad(Math.floor(total / unit) % 60)}${ass ? '.' : ','}${pad(total % unit, ass ? 2 : 3)}`
}

export function srt(cues: Cue[]) {
  return cues.map((cue, i) => `${i + 1}\n${stamp(cue.start, false)} --> ${stamp(cue.end, false)}\n${cue.text.toUpperCase().replace(/\s+/g, ' ')}\n\n`).join('')
}

export function ass(cues: Cue[], width: number, height: number, fontFamily: string) {
  const vertical = height > width
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${vertical ? 720 : 1280}
PlayResY: ${vertical ? 1280 : 720}
WrapStyle: 0
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: GoodTake,${fontFamily},${vertical ? 37 : 33},&H00FFFFFF,&H00FFFFFF,&H00131313,&H90000000,-1,0,0,0,100,100,0,0,1,2,1,2,42,42,${vertical ? 142 : 66},1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`
  return header + cues.map(cue => {
    const text = cue.text.toUpperCase().replace(/\s+/g, ' ').replaceAll('\\', '＼').replaceAll('{', '｛').replaceAll('}', '｝')
    return `Dialogue: 0,${stamp(cue.start, true)},${stamp(cue.end, true)},GoodTake,,0,0,0,,${text}\n`
  }).join('')
}
