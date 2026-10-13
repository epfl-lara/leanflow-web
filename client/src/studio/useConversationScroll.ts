import { useLayoutEffect, useRef, useState } from 'react'

export function useConversationScroll(conversationId: string | null) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const lastTop = useRef(0)
  const [following, setFollowing] = useState(true)
  const pause = () => {
    followingRef.current = false
    setFollowing(false)
  }
  const jumpToLatest = () => {
    followingRef.current = true
    setFollowing(true)
    const element = viewport.current
    if (element) {
      element.scrollTop = element.scrollHeight
      lastTop.current = element.scrollTop
    }
  }
  const onScroll = () => {
    const element = viewport.current
    if (!element) return
    const atBottom =
      element.scrollHeight - element.clientHeight - element.scrollTop < 24
    if (atBottom) {
      followingRef.current = true
      setFollowing(true)
    } else if (element.scrollTop < lastTop.current - 1) pause()
    lastTop.current = element.scrollTop
  }
  useLayoutEffect(() => {
    followingRef.current = true
    setFollowing(true)
    const element = viewport.current
    const body = content.current
    if (!element || !body) return
    const follow = () => {
      if (!followingRef.current || !element.clientHeight) return
      // Scroll this viewport only, without smooth animations fighting the wheel
      // or moving its ancestors, the page, or the Monaco editor.
      element.scrollTop = element.scrollHeight
      lastTop.current = element.scrollTop
    }
    const observer = new ResizeObserver(follow)
    observer.observe(element)
    observer.observe(body)
    follow()
    return () => observer.disconnect()
  }, [conversationId])
  return { viewport, content, following, pause, jumpToLatest, onScroll }
}
