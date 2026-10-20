import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons'

export function CopyButton({
  text,
  label = 'Copy',
  className = '',
}: {
  text: string
  label?: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])
  return (
    <button
      type="button"
      className={`copy-button ${className}`}
      title={
        state === 'failed'
          ? 'Clipboard unavailable. Select the text and copy it.'
          : label
      }
      onClick={() => {
        const copy = async () => {
          try {
            await navigator.clipboard.writeText(text)
            if (mounted.current) setState('copied')
          } catch {
            if (mounted.current) setState('failed')
          }
          if (!mounted.current) return
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setState('idle'), 2500)
        }
        void copy()
      }}
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={13} />
      <span aria-live="polite">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Select text to copy'
            : label}
      </span>
    </button>
  )
}
