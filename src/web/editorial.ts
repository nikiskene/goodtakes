export type Cue = { id: number; start: number; end: number; text: string }
export type Range = { start: number; end: number }
export type Cut = Range & { opening: string; ranges?: Range[] }

export function montage(durations: number[], cues: Cue[], target: number, brief: string, voice: boolean): Cut {
  const frame = (seconds: number) => Math.round(seconds * 30) / 30
  const total = durations.reduce((sum, duration) => sum + duration, 0)
  // Leave room to cut within the footage, even when the source is shorter than the target.
  const budget = Math.min(target, Math.max(1, total * .78))
  const relevance = terms(brief)
  let offset = 0
  let remaining = Math.round(budget * 30)
  const ranges: Range[] = []
  for (const duration of durations) {
    const keep = Math.min(duration, budget * duration / total)
    const count = Math.max(1, Math.round(keep / 3.8))
    const window = duration / count
    for (let i = 0; i < count; i++) {
      const left = offset + i * window
      const right = left + window
      const span = keep / count
      let best = left + (window - span) / 2
      if (!voice) {
        let bestScore = 0
        for (const cue of cues) {
          if (cue.start < left || cue.end > right) continue
          const start = Math.max(left, Math.min(cue.start - .10, right - span))
          if (cue.end > start + span) continue
          const words = terms(cue.text)
          const complete = /[.!?。！？]$/.test(cue.text)
          const score = cue.end - cue.start + Number(complete) + 3 * [...relevance].filter(word => words.has(word)).length
          if (score > bestScore) { best = start; bestScore = score }
        }
      }
      const start = frame(best)
      const frames = Math.min(remaining, Math.round((frame(best + span) - start) * 30))
      if (frames > 0) {
        ranges.push({ start, end: start + frames / 30 })
        remaining -= frames
      }
    }
    offset += duration
  }
  const length = ranges.reduce((sum, range) => sum + range.end - range.start, 0)
  return length >= 1 - 1e-6 && ranges.length > 1
    ? { start: 0, end: length, ranges, opening: 'Quick-cut edit' }
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
