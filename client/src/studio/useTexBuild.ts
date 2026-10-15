import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  errorText,
  post,
  SESSION_RESTORED_EVENT,
  type TexBuild,
  type TexStatus,
} from './api'
import { texBuildIsActive } from './texBuilds'

export function useTexBuild({
  projectId,
  rootFile,
  visible,
  dirty,
  saveVersion,
  save,
}: {
  projectId: string
  rootFile: string
  visible: boolean
  dirty: boolean
  saveVersion: number
  save: () => Promise<void>
}) {
  const [status, setStatus] = useState<TexStatus | null>(null)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [autoBuild, setAutoBuild] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [queued, setQueued] = useState(false)
  const [busyBlocked, setBusyBlocked] = useState(false)
  const requestEpoch = useRef(0)
  const mounted = useRef(true)
  const pendingSave = useRef<number | null>(null)
  const pendingWorkspace = useRef<string | null>(null)
  const startingRef = useRef(false)
  const stoppingRef = useRef(false)
  const observedSave = useRef(saveVersion)
  const observedWorkspace = useRef<string | undefined>(undefined)
  const manualPending = useRef(false)
  const conflictRetries = useRef(0)
  const latest = useRef({ saveVersion, dirty })
  const buildVersions = useRef(new Map<string, { saveVersion: number }>())
  const successVersion = useRef<{
    id: string
    saveVersion: number
  } | null>(null)
  latest.current = { saveVersion, dirty }
  const base = `/api/projects/${encodeURIComponent(projectId)}/tex`
  const statusPath = rootFile
    ? `${base}?rootFile=${encodeURIComponent(rootFile)}`
    : base
  const activeBuild = texBuildIsActive(status?.activeBuild)
    ? status?.activeBuild
    : texBuildIsActive(status?.build)
      ? status?.build
      : null
  const active = !!activeBuild
  const buildId = status?.build?.id
  const buildWorkspaceRevision = status?.build?.workspaceRevision

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const poll = async () => {
      const epoch = requestEpoch.current
      let delay = visible ? 5000 : 30000
      try {
        const value = await api<TexStatus>(statusPath, {
          signal: controller.signal,
        })
        delay =
          !visible || !value.available
            ? 30000
            : texBuildIsActive(value.activeBuild) ||
                texBuildIsActive(value.build)
              ? 1500
              : 5000
        if (!cancelled && epoch === requestEpoch.current) {
          if (
            observedWorkspace.current === undefined &&
            typeof value.workspaceRevision === 'string'
          )
            observedWorkspace.current = value.workspaceRevision
          setStatus(value)
          setPollError('')
          if (
            texBuildIsActive(value.activeBuild) ||
            texBuildIsActive(value.build)
          ) {
            conflictRetries.current = 0
            setBusyBlocked(false)
          } else if (conflictRetries.current <= 1) setBusyBlocked(false)
          const successful = value.lastSuccessful
          if (successful && successful.id !== successVersion.current?.id) {
            const versions =
              buildVersions.current.get(successful.id) ?? latest.current
            successVersion.current = {
              id: successful.id,
              saveVersion: versions.saveVersion,
            }
          }
        }
      } catch (error) {
        if (!cancelled && epoch === requestEpoch.current)
          setPollError(errorText(error))
      }
      if (!cancelled) timer = setTimeout(() => void poll(), delay)
    }
    void poll()
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [statusPath, visible, refresh, saveVersion])

  useEffect(() => {
    const retry = () => setRefresh((value) => value + 1)
    const visible = () => {
      if (document.visibilityState === 'visible') retry()
    }
    window.addEventListener(SESSION_RESTORED_EVENT, retry)
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener(SESSION_RESTORED_EVENT, retry)
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])

  const start = useCallback(
    async (saveFirst: boolean) => {
      if (
        startingRef.current ||
        stoppingRef.current ||
        active ||
        !rootFile ||
        !status?.available
      )
        return
      if (
        !saveFirst &&
        (latest.current.dirty ||
          (pendingSave.current === null && pendingWorkspace.current === null))
      )
        return
      startingRef.current = true
      if (saveFirst) {
        conflictRetries.current = 0
        setBusyBlocked(false)
      }
      setStarting(true)
      setError('')
      ++requestEpoch.current
      let submitted = false
      const manualRequest = saveFirst || manualPending.current
      const requestedWorkspace =
        pendingWorkspace.current || status?.workspaceRevision || null
      try {
        if (saveFirst) await save()
        if (!mounted.current) return
        // save() rejects conflicts and waits until all local buffers are saved.
        // Automatic builds only consume a completed save; they never save drafts.
        observedSave.current = latest.current.saveVersion
        pendingSave.current = null
        pendingWorkspace.current = null
        manualPending.current = false
        setQueued(false)
        const versions = { ...latest.current }
        submitted = true
        const build = await post<TexBuild>(`${base}/build`, {
          rootFile,
          engine: 'pdflatex',
        })
        if (!mounted.current) return
        ++requestEpoch.current
        conflictRetries.current = 0
        setBusyBlocked(false)
        buildVersions.current.set(build.id, versions)
        if (buildVersions.current.size > 64) {
          const oldest = buildVersions.current.keys().next().value
          if (oldest) buildVersions.current.delete(oldest)
        }
        setStatus((current) =>
          current ? { ...current, build, activeBuild: build } : current,
        )
        setRefresh((value) => value + 1)
      } catch (error) {
        if (mounted.current) {
          setError(errorText(error))
          if (submitted && error instanceof ApiError && error.status === 409) {
            // A build can claim the shared slot after our last status poll.
            // Keep the requested save and wait for a successful status read.
            // Only one idle retry is allowed until a new save or visible build.
            pendingSave.current = latest.current.saveVersion
            pendingWorkspace.current ||= requestedWorkspace
            manualPending.current = manualRequest
            conflictRetries.current += 1
            setBusyBlocked(true)
            setQueued(true)
            setRefresh((value) => value + 1)
          }
        }
      } finally {
        startingRef.current = false
        if (mounted.current) setStarting(false)
      }
    },
    [
      active,
      rootFile,
      status?.available,
      status?.workspaceRevision,
      save,
      base,
    ],
  )

  useEffect(() => {
    const saved = observedSave.current !== saveVersion
    observedSave.current = saveVersion
    const workspaceRevision = status?.workspaceRevision
    const externalSave =
      typeof workspaceRevision === 'string' &&
      observedWorkspace.current !== undefined &&
      workspaceRevision !== observedWorkspace.current
    if (
      typeof workspaceRevision === 'string' &&
      observedWorkspace.current !== undefined
    )
      observedWorkspace.current = workspaceRevision
    if ((!autoBuild && !manualPending.current) || !visible) {
      pendingSave.current = null
      pendingWorkspace.current = null
      setQueued(false)
      return
    }
    if (saved) pendingSave.current = saveVersion
    if (externalSave) pendingWorkspace.current = workspaceRevision
    if (saved || externalSave) {
      conflictRetries.current = 0
      setBusyBlocked(false)
    }
    // A local save and its later metadata poll describe the same source change.
    // The captured build stamp prevents that second observation from rebuilding
    // an input snapshot which is already running or has already finished.
    if (workspaceRevision && buildWorkspaceRevision === workspaceRevision)
      pendingWorkspace.current = null
    const captured = buildId && buildVersions.current.get(buildId)
    if (
      !manualPending.current &&
      conflictRetries.current === 0 &&
      captured &&
      pendingSave.current !== null &&
      captured.saveVersion >= pendingSave.current
    )
      pendingSave.current = null
    const pending =
      pendingSave.current !== null || pendingWorkspace.current !== null
    setQueued(pending)
    if (
      !pending ||
      active ||
      starting ||
      stopping ||
      busyBlocked ||
      dirty ||
      !rootFile ||
      !status?.available
    )
      return
    const timer = setTimeout(() => void start(false), 500)
    return () => clearTimeout(timer)
  }, [
    saveVersion,
    autoBuild,
    active,
    starting,
    stopping,
    busyBlocked,
    dirty,
    rootFile,
    visible,
    status?.available,
    status?.workspaceRevision,
    buildWorkspaceRevision,
    buildId,
    start,
  ])

  // Changing the root is an explicit choice. It must not compile a previously
  // queued save against a different document.
  useEffect(() => {
    pendingSave.current = null
    pendingWorkspace.current = null
    manualPending.current = false
    conflictRetries.current = 0
    setBusyBlocked(false)
    setQueued(false)
    observedWorkspace.current = undefined
    ++requestEpoch.current
    setRefresh((value) => value + 1)
  }, [rootFile])

  const stop = async () => {
    const build = activeBuild
    if (!build || !active || stoppingRef.current) return
    pendingSave.current = null
    pendingWorkspace.current = null
    manualPending.current = false
    conflictRetries.current = 0
    setBusyBlocked(false)
    setQueued(false)
    stoppingRef.current = true
    setStopping(true)
    setError('')
    ++requestEpoch.current
    try {
      await post(`${base}/builds/${encodeURIComponent(build.id)}/stop`)
      if (mounted.current) {
        ++requestEpoch.current
        setRefresh((value) => value + 1)
      }
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      stoppingRef.current = false
      if (mounted.current) setStopping(false)
    }
  }
  const previous = successVersion.current
  const savedSinceBuild = !!previous && saveVersion !== previous.saveVersion
  return {
    status,
    error: error || pollError,
    starting,
    stopping,
    active,
    activeBuild,
    queued,
    autoBuild,
    setAutoBuild,
    savedSinceBuild,
    start,
    stop,
    retry: () => {
      setError('')
      setRefresh((value) => value + 1)
    },
  }
}
