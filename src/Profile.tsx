import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { createClient, type Session } from '@supabase/supabase-js'
import type { Aspect, Preferences, Style } from './types'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const callback = new URLSearchParams(window.location.hash.slice(1))
const callbackType = callback.get('type')
const emailConfirmed = callbackType === 'signup' && callback.has('access_token')
if (emailConfirmed) {
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
}
const cloud = url && key ? createClient(url, key, {
  auth: { flowType: 'implicit', autoRefreshToken: true, persistSession: true },
}) : null

type AuthState = { session: Session | null | undefined; recovering: boolean }
let authState: AuthState = { session: cloud ? undefined : null, recovering: callbackType === 'recovery' }
const authListeners = new Set<() => void>()
function setAuth(state: AuthState) {
  authState = state
  authListeners.forEach(listener => listener())
}
function subscribe(listener: () => void) {
  authListeners.add(listener)
  return () => { authListeners.delete(listener) }
}
function authSnapshot() { return authState }

cloud?.auth.onAuthStateChange((event, session) => {
  setAuth({ session, recovering: !!session && (event === 'PASSWORD_RECOVERY' || authState.recovering) })
})

export function useProfileAuth() {
  return useSyncExternalStore(subscribe, authSnapshot)
}

export async function verifyEditorSession() {
  if (!cloud || !authState.session || authState.recovering) throw new Error('Sign in to use the editor.')
  const { data, error } = await cloud.auth.getUser()
  if (error) throw error
  if (!data.user || data.user.id !== authState.session?.user.id || authState.recovering) {
    throw new Error('Sign in to use the editor.')
  }
}

type AuthMode = 'signin' | 'signup' | 'reset'

export function Profile({ preferences, onChange, onClose }: {
  preferences?: Preferences; onChange?: (prefs: Preferences) => void; onClose?: () => void
}) {
  const { session, recovering } = useProfileAuth()
  const [mode, setMode] = useState<AuthMode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [isOwner, setIsOwner] = useState(false)
  const [exportAccess, setExportAccess] = useState(false)
  const [pick, setPick] = useState({ aspect: true, style: true })
  const [message, setMessage] = useState(emailConfirmed && !session ? 'Email confirmed. Sign in with your password.' : '')
  const [busy, setBusy] = useState(false)
  const userId = session?.user.id
  const lastUser = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (lastUser.current !== userId) {
      lastUser.current = userId
      setName('')
      setIsOwner(false)
      setExportAccess(false)
    }
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

  function changeMode(next: AuthMode) {
    setMode(next)
    setPassword('')
    setMessage('')
  }

  function submitAuth(event: FormEvent) {
    event.preventDefault()
    if (!cloud) return
    const client = cloud
    const redirect = preferences ? undefined : new URL('/editor', window.location.origin).href
    void run(async () => {
      if (recovering) {
        const { error } = await client.auth.updateUser({ password })
        if (error) throw error
        setPassword('')
        setAuth({ ...authState, recovering: false })
        return 'Password updated.'
      }
      if (mode === 'reset') {
        const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirect })
        if (error) throw error
        return 'If this email has an account, you’ll receive a password reset link.'
      }
      if (mode === 'signup') {
        const { data, error } = await client.auth.signUp({
          email: email.trim(), password, options: { emailRedirectTo: redirect },
        })
        if (error) throw error
        setPassword('')
        setMode('signin')
        return data.session ? 'Account created.' : 'Check your email to confirm your address, then sign in with your password.'
      }
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password })
      if (error) throw error
      setPassword('')
      return 'Signed in.'
    })
  }

  const heading = recovering ? 'Choose a new password' : userId ? 'Your profile'
    : mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Sign in to GoodTake'
  return <div className="profile-card" role="region" aria-labelledby="profile-heading">
    <div className="section-heading"><h2 id="profile-heading">{heading}</h2>
      {onClose && <button onClick={onClose} aria-label="Close profile">Close</button>}</div>
    {!cloud ? <p>Sign-in is unavailable in this build.</p> : session === undefined ? <p role="status">Checking your session…</p> :
      !session || recovering ? <form className="stack" onSubmit={submitAuth}>
        {!recovering && <label>Email<input type="email" autoComplete="username" autoCapitalize="none" required value={email} disabled={busy} onChange={e => setEmail(e.target.value)} /></label>}
        {(recovering || mode !== 'reset') && <label>{recovering ? 'New password' : 'Password'}<input type="password" required
          autoComplete={recovering || mode === 'signup' ? 'new-password' : 'current-password'}
          minLength={recovering || mode === 'signup' ? 8 : undefined}
          value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>}
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{recovering ? 'Save new password'
            : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset email' : 'Sign in'}</button>
          {!recovering && (mode === 'signin'
            ? <><button type="button" disabled={busy} onClick={() => changeMode('signup')}>Create account</button>
              <button type="button" disabled={busy} onClick={() => changeMode('reset')}>Forgot password?</button></>
            : <button type="button" disabled={busy} onClick={() => changeMode('signin')}>Back to sign in</button>)}
        </div>
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
            changeMode('signin')
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
