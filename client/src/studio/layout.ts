import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_LAYOUT = {
  sidebar: 238,
  assistant: 368,
  goals: 34,
  files: 65,
}
export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum))

export function useStoredSize(
  key: string,
  initial: number,
  minimum: number,
  maximum: number,
) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key)
      const parsed = saved === null ? initial : Number(saved)
      return Number.isFinite(parsed) ? clamp(parsed, minimum, maximum) : initial
    } catch {
      return initial
    }
  })
  const change = useCallback(
    (next: number) => {
      if (!Number.isFinite(next)) return
      const size = clamp(next, minimum, maximum)
      setValue(size)
      try {
        localStorage.setItem(key, String(size))
      } catch {
        /* Layout still works without storage. */
      }
    },
    [key, minimum, maximum],
  )
  return [value, change] as const
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

export function useElementSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight })
  useEffect(() => {
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [element])
  return size
}
