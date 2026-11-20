export type Aspect = 'vertical' | 'landscape'
export type Style = 'editorial' | 'emphasis'
export type Role = 'a' | 'b' | 'mic'
export type Angle = 'auto' | 'a' | 'b'
export type Take = { id: string; start: number; end: number; opening: string; reason: string }
export type Phrase = { id: string; start: number; end: number; text: string }
export type Edit = {
  candidate: string; start: number; end: number; angle: Angle; crop: number
  captionStyle: Style; tighten: boolean; corrections: Record<string, string>
}
export type Project = {
  id: string; name: string; preview: string | null; aspect: Aspect
  target?: number; brief?: string
  sources: Partial<Record<Role, { name: string; duration: number; start: number }>>
  sync: Partial<Record<Role, { mode: string; offset: number; confidence: number; rate: number }>>
  candidates: Take[]; phrases: Phrase[]; edit: Edit | null; ranking?: string
  plan?: { duration: number; video: { role: Role; outputStart: number; outputEnd: number }[] } | null
}
export type Preferences = { aspect: Aspect; style: Style }
