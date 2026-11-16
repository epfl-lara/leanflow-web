import {
  Component,
  lazy,
  Suspense,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import type { LeanWorkspace } from './LeanWorkspace'

// Sign-in and account setup should not download or initialize the editor.
const loadEditor = () =>
  lazy(() =>
    import('./LeanWorkspace').then(({ LeanWorkspace }) => ({
      default: LeanWorkspace,
    })),
  )

class EditorLoadBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="empty-state" role="alert">
        <p>The editor could not open. Check your connection and try again.</p>
        <button className="button secondary" onClick={this.props.onRetry}>
          Retry loading editor
        </button>
      </div>
    )
  }
}

export function LazyLeanWorkspace(props: ComponentProps<typeof LeanWorkspace>) {
  const [{ Editor, attempt }, setLoader] = useState(() => ({
    Editor: loadEditor(),
    attempt: 0,
  }))
  return (
    <EditorLoadBoundary
      key={attempt}
      onRetry={() => setLoader({ Editor: loadEditor(), attempt: attempt + 1 })}
    >
      <Suspense
        fallback={
          <div className="editor-loading">
            <span className="spinner" aria-hidden="true" />
            <output>Loading editor…</output>
          </div>
        }
      >
        <Editor {...props} />
      </Suspense>
    </EditorLoadBoundary>
  )
}
