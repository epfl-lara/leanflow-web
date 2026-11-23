import { useId, useState, type FormEvent } from 'react'
import {
  api,
  bindSessionUser,
  errorText,
  markSessionRestored,
  post,
  type Account,
  type Session,
} from './api'
import { Brand } from './Brand'
import { EntraButton } from './EntraButton'
import { Icon } from './Icons'
import { setRunEventTransport } from './runEventTransport'
import './login.css'

export function LoginScreen({
  onSession,
}: {
  onSession: (session: Session) => void
}) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [epflAvailable, setEpflAvailable] = useState(false)
  const headingId = useId()
  const signInId = useId()

  async function acceptSignIn(expectedUserId?: string) {
    bindSessionUser(expectedUserId ?? null)
    const session = await api<Session>('/api/session')
    bindSessionUser(session.user.id)
    setRunEventTransport(session.eventTransport)
    markSessionRestored()
    onSession(session)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const signedIn = await post<{ user: Account }>('/api/login', {
        token: token.trim(),
      })
      await acceptSignIn(signedIn.user.id)
    } catch (error) {
      bindSessionUser(null)
      setError(errorText(error))
      setBusy(false)
    }
  }

  return (
    <main className="lf-login" aria-labelledby={headingId}>
      <div className="lf-login__panel">
        <Brand />
        <div className="lf-login__content">
          <h1 id={headingId} className="lf-login__title">
            Your Lean workspace, with a proof partner.
          </h1>
          <p className="lf-login__lede">
            Write Lean proofs, inspect goals as you go, and work through them
            with Lemex.
          </p>

          <section className="lf-login__auth" aria-labelledby={signInId}>
            <h2 id={signInId} className="lf-login__auth-title">
              Sign in
            </h2>
            <div className="lf-login__epfl">
              <EntraButton
                className="button primary lf-login__action"
                disabled={busy}
                onBusyChange={setBusy}
                onAvailabilityChange={setEpflAvailable}
                onComplete={() => acceptSignIn()}
              />
              {epflAvailable && (
                <p className="lf-login__account-note">
                  If you already use an access token, sign in with it below and
                  link EPFL in Assistant settings to keep your projects.
                </p>
              )}
            </div>
            {epflAvailable && (
              <p className="lf-login__divider">
                <span>or use an access token</span>
              </p>
            )}
            <form className="lf-login__form" onSubmit={submit}>
              <label className="field-label" htmlFor="access-token">
                Access token
              </label>
              <input
                id="access-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Enter your collaborator token"
                required
                autoComplete="current-password"
                disabled={busy}
              />
              {error && (
                <p role="alert" className="error-message">
                  {error}
                </p>
              )}
              <button
                className={`button ${epflAvailable ? 'secondary' : 'primary'} lf-login__action`}
                disabled={busy || !token.trim()}
              >
                {busy ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="arrow" size={16} />
                )}
                {busy ? 'Signing in…' : 'Open workspace'}
              </button>
            </form>
          </section>

          <div className="lf-login__help">
            <p>
              Access tokens are personal and come with an invitation from an
              administrator. Confirm your name to open your workspace. You can
              add an API key whenever you want to use Lemex.
            </p>
            <p>
              {epflAvailable
                ? 'For access help, email '
                : 'Need access? Email '}
              <a href="mailto:lazar.milikic@epfl.ch">lazar.milikic@epfl.ch</a>
              {epflAvailable ? '.' : ' to request an invitation.'}
            </p>
          </div>
        </div>
      </div>

      <div className="lf-login__showcase">
        <ProofPreview />
      </div>
    </main>
  )
}

type TokenKind = 'keyword' | 'tactic' | 'name' | 'type' | 'plain'
type Token = readonly [kind: TokenKind, text: string]

// A complete core-Lean proof, so the sample stays true without Mathlib.
const PROOF_LINES: readonly (readonly Token[])[] = [
  [
    ['keyword', 'variable'],
    ['plain', ' (p q : '],
    ['type', 'Prop'],
    ['plain', ')'],
  ],
  [],
  [
    ['keyword', 'theorem'],
    ['plain', ' '],
    ['name', 'both'],
    ['plain', ' (hp : p) (hq : q) : p ∧ q := '],
    ['keyword', 'by'],
  ],
  [
    ['plain', '  '],
    ['tactic', 'constructor'],
  ],
  [
    ['plain', '  · '],
    ['tactic', 'exact'],
    ['plain', ' hp'],
  ],
  [
    ['plain', '  · '],
    ['tactic', 'exact'],
    ['plain', ' hq'],
  ],
]
const CURSOR_LINE = 3

const GOALS = [
  { name: 'left', target: 'p' },
  { name: 'right', target: 'q' },
] as const

function ProofPreview() {
  const captionId = useId()
  return (
    <figure className="lf-preview" aria-labelledby={captionId}>
      <div className="lf-preview__window">
        <div className="lf-preview__bar" aria-hidden="true">
          <span className="lf-preview__dots">
            <span />
            <span />
            <span />
          </span>
          <span className="lf-preview__file">Both.lean</span>
        </div>
        <div className="lf-preview__body">
          <pre className="lf-preview__code">
            <code>
              {PROOF_LINES.map((line, index) => (
                <span
                  key={index}
                  className={
                    index === CURSOR_LINE
                      ? 'lf-preview__line is-current'
                      : 'lf-preview__line'
                  }
                >
                  <span className="lf-preview__number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="lf-preview__text">
                    {line.length === 0
                      ? ' '
                      : line.map(([kind, text], part) => (
                          <span key={part} className={`lf-token-${kind}`}>
                            {text}
                          </span>
                        ))}
                  </span>
                </span>
              ))}
            </code>
          </pre>
          <div className="lf-preview__goals">
            <p className="lf-preview__goals-title">
              Goals <span>after constructor</span>
            </p>
            {GOALS.map((goal) => (
              <pre key={goal.name} className="lf-preview__goal">
                <span className="lf-preview__case">case {goal.name}</span>
                {'\np q : Prop\nhp : p\nhq : q\n'}
                <span className="lf-preview__turnstile">⊢</span> {goal.target}
              </pre>
            ))}
          </div>
        </div>
      </div>
      <figcaption id={captionId} className="lf-preview__caption">
        Example: a Lean proof beside its goals after <code>constructor</code>.
      </figcaption>
    </figure>
  )
}
