import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createClient, type Session } from '@supabase/supabase-js'
import type { Aspect, Preferences, Style } from './types'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const cloud = url && key ? createClient(url, key, {
  auth: { detectSessionInUrl: false, autoRefreshToken: true, persistSession: true },
}) : null

export function Profile({ preferences, onChange, onClose }: {
  preferences?: Preferences; onChange?: (prefs: Preferences) => void; onClose: () => void
}) {
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [name, setName] = useState('')
  const [isOwner, setIsOwner] = useState(false)
  const [exportAccess, setExportAccess] = useState(false)
  const [pick, setPick] = useState({ aspect: true, style: true })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const userId = session?.user.id
  const lastUser = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!cloud) return
    const { data: { subscription } } = cloud.auth.onAuthStateChange((_, next) => {
      if (lastUser.current !== next?.user.id) {
        lastUser.current = next?.user.id
        setName('')
        setIsOwner(false)
        setExportAccess(false)
      }
      setSession(next)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!cloud || !userId) return
    let active = true
    void cloud.from('goodtake_profiles').select('display_name').eq('user_id', userId).maybeSingle()
      .then(({ data }) => { if (active && data) setName(data.display_name) })
    void cloud.from('goodtake_account_roles').select('role').eq('user_id', userId).maybeSingle()
      .then(({ data }) => { if (active) setIsOwner(data?.role === 'owner') })
    void cloud.rpc('goodtake_has_export_access')
      .then(({ data }) => { if (active) setExportAccess(data === true) })
    return () => { active = false }
  }, [userId])

  async function run(operation: () => Promise<string>) {
    setBusy(true)
    setMessage('')
    try { setMessage(await operation()) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  function signIn(event: FormEvent) {
    event.preventDefault()
    if (!cloud) return
    const client = cloud
    void run(async () => {
      if (sent) {
        const { error } = await client.auth.verifyOtp({ email, token: code.trim(), type: 'email' })
        if (error) throw error
        return 'Signed in.'
      }
      const { error } = await client.auth.signInWithOtp({ email })
      if (error) throw error
      setSent(true)
      return 'Enter the code from your email.'
    })
  }

  return <div className="profile-card" role="region" aria-labelledby="profile-heading">
    <div className="section-heading"><h2 id="profile-heading">Your profile</h2><button onClick={onClose} aria-label="Close profile">Close</button></div>
    {!cloud ? <p>Sign-in is unavailable in this build.</p> :
      !userId ? <form className="stack" onSubmit={signIn}>
        <p>{preferences ? "Sign in to keep a profile and sync the preferences you choose between devices." : "Sign in with an email code to manage your GoodTake profile."}</p>
        <label>Email<input type="email" autoComplete="email" required value={email} disabled={sent} onChange={e => setEmail(e.target.value)} /></label>
        {sent && <label>Email code<input autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={e => setCode(e.target.value)} /></label>}
        <div className="actions"><button className="primary" disabled={busy}>{sent ? 'Verify code' : 'Email me a code'}</button>
          {sent && <button type="button" onClick={() => setSent(false)}>Use another email</button>}</div>
      </form> : <div className="stack">
        <p>{session.user.email}{isOwner && <small className="role-label">Owner</small>}</p>
        {exportAccess && <p>Paid export access is active.</p>}
        <label>Display name<input value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label>
        <button disabled={busy || !name.trim()} onClick={() => void run(async () => {
          const { error } = await cloud.from('goodtake_profiles').upsert({ user_id: userId, display_name: name.trim() })
          if (error) throw error
          return 'Profile saved.'
        })}>Save profile</button>
        {preferences && onChange && <>
        <fieldset><legend>Preferences to sync</legend>
          <label className="check"><input type="checkbox" checked={pick.aspect} onChange={e => setPick({ ...pick, aspect: e.target.checked })} /> Default format</label>
          <label className="check"><input type="checkbox" checked={pick.style} onChange={e => setPick({ ...pick, style: e.target.checked })} /> Caption style</label>
        </fieldset>
        <div className="actions">
          <button disabled={busy || !(pick.aspect || pick.style)} onClick={() => void run(async () => {
            const { error } = await cloud.from('goodtake_preferences').upsert({
              user_id: userId, aspect_ratio: pick.aspect ? preferences.aspect : null,
              caption_style: pick.style ? preferences.style : null,
            })
            if (error) throw error
            return 'Selected preferences saved to your account.'
          })}>Save to account</button>
          <button disabled={busy || !(pick.aspect || pick.style)} onClick={() => void run(async () => {
            const { data, error } = await cloud.from('goodtake_preferences').select('aspect_ratio, caption_style')
              .eq('user_id', userId).maybeSingle()
            if (error) throw error
            if (!data) return 'This account has no saved preferences yet.'
            onChange({
              aspect: (pick.aspect && data.aspect_ratio ? data.aspect_ratio : preferences.aspect) as Aspect,
              style: (pick.style && data.caption_style ? data.caption_style : preferences.style) as Style,
            })
            return 'Selected preferences applied on this device.'
          })}>Load from account</button>
        </div>
        </>}
        <div className="actions">
          <button disabled={busy} onClick={() => void run(async () => {
            const { error } = await cloud.auth.signOut({ scope: 'local' })
            if (error) throw error
            setSent(false)
            setCode('')
            setName('')
            setIsOwner(false)
            setExportAccess(false)
            return 'Signed out.'
          })}>Sign out</button>
        </div>
      </div>}
    {message && <p role="status">{message}</p>}
  </div>
}
