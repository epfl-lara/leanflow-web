import { useState } from 'react'
import type { Preset } from './api'

export function useProjectEnvironment(
  templates: Preset[],
  initialPreset?: string,
) {
  const [libraries, setLibraries] = useState<string[]>(() =>
    initialPreset
      ? initialPreset === 'lean'
        ? []
        : [initialPreset]
      : templates.some(
            (template) => template.id === 'mathlib' && template.ready,
          )
        ? ['mathlib']
        : [],
  )
  const [leanVersion, setLeanVersion] = useState('')
  const [customLeanVersion, setCustomLeanVersion] = useState(false)
  const preset = libraries.includes('cslib')
    ? 'cslib'
    : libraries.includes('physlib')
      ? 'physlib'
      : libraries.length
        ? 'mathlib'
        : 'lean'
  const selected = templates.find((template) => template.id === preset)
  const unavailableLibrary = libraries.some(
    (id) => !templates.some((template) => template.id === id && template.ready),
  )
  function configuration() {
    if (!templates.length || unavailableLibrary)
      throw new Error('Choose an available Lean environment.')
    if (preset !== 'lean') return { libraries }
    let version = leanVersion.trim().replace(/^leanprover\/lean4:/, '')
    if (!version)
      version = selected?.toolchain?.replace('leanprover/lean4:', '') || ''
    if (version.startsWith('4.')) version = `v${version}`
    if (!/^v4\.\d+\.\d+(?:-rc\d+)?$/.test(version))
      throw new Error(
        'Choose a Lean release or enter an exact version, such as v4.35.0 or v4.36.0-rc1.',
      )
    return { libraries, toolchain: `leanprover/lean4:${version}` }
  }
  return {
    libraries,
    setLibraries,
    preset,
    selected,
    unavailableLibrary,
    leanVersion,
    setLeanVersion,
    customLeanVersion,
    setCustomLeanVersion,
    configuration,
  }
}

export function ProjectEnvironmentFields({
  templates,
  environment,
  disabled = false,
  idPrefix = '',
  afterImport = false,
}: {
  templates: Preset[]
  environment: ReturnType<typeof useProjectEnvironment>
  disabled?: boolean
  idPrefix?: string
  afterImport?: boolean
}) {
  const {
    libraries,
    setLibraries,
    preset,
    selected,
    unavailableLibrary,
    leanVersion,
    setLeanVersion,
    customLeanVersion,
    setCustomLeanVersion,
  } = environment
  const busy = disabled
  return (
    <>
      <p className="field-label" id={`${idPrefix}library-preset-label`}>
        Libraries <span>select one or more</span>
      </p>
      <div
        className="preset-list"
        role="group"
        aria-labelledby={`${idPrefix}library-preset-label`}
      >
        {templates.map((template) => (
          <label
            key={template.id}
            className={`preset-option ${(template.id === 'lean' ? !libraries.length : libraries.includes(template.id)) ? 'chosen' : ''}`}
          >
            <input
              type="checkbox"
              name="libraries"
              value={template.id}
              checked={
                template.id === 'lean'
                  ? !libraries.length
                  : libraries.includes(template.id)
              }
              onChange={() =>
                setLibraries((values) =>
                  template.id === 'lean'
                    ? []
                    : values.includes(template.id)
                      ? values.filter((id) => id !== template.id)
                      : [...values, template.id],
                )
              }
              disabled={
                busy ||
                (template.id !== 'lean' &&
                  !template.ready &&
                  !libraries.includes(template.id)) ||
                (template.id === 'cslib' && libraries.includes('physlib')) ||
                (template.id === 'physlib' && libraries.includes('cslib'))
              }
            />
            <div>
              <strong>{template.name}</strong>
              <p>{template.description}</p>
              {template.toolchain && (
                <code>
                  {template.toolchain.replace('leanprover/lean4:', '')}
                </code>
              )}
            </div>
            {template.ready && <span className="tag success">Prepared</span>}
            {!template.ready && template.id !== 'lean' && (
              <span className="tag" role="status">
                {template.preparationState === 'preparing'
                  ? 'Preparing…'
                  : template.preparationState === 'queued'
                    ? 'Queued'
                    : template.preparationState === 'failed'
                      ? 'Setup failed'
                      : 'Not installed'}
              </span>
            )}
          </label>
        ))}
      </div>
      {templates.length === 0 && (
        <p className="error-message">
          {afterImport
            ? 'No environments are available. Ask the administrator to prepare one, then reload this page.'
            : 'No presets are available. Import an existing repository instead.'}
        </p>
      )}
      {unavailableLibrary && (
        <p className="error-message" aria-live="polite">
          {selected?.preparationState === 'preparing' ||
          selected?.preparationState === 'queued'
            ? 'This library is being prepared automatically. You can select it as soon as setup finishes.'
            : afterImport
              ? 'This library is unavailable. Choose an available environment or ask the administrator to retry library preparation.'
              : selected?.preparationState === 'failed'
                ? 'Library setup failed. Ask the administrator to retry preparation. You can use another library or import a project.'
                : 'This library is not installed on this server. Choose an available library or import an existing repository.'}
        </p>
      )}
      {selected && (
        <>
          {libraries.length > 0 && (
            <p className="field-help" role="status">
              Uses Lean {selected.toolchain?.replace('leanprover/lean4:', '')}
              {preset === 'cslib' || preset === 'physlib'
                ? ` with ${preset === 'cslib' ? 'CSLib' : 'Physlib'}’s compatible Mathlib revision.`
                : ' with Mathlib.'}
            </p>
          )}
          <p className="field-help">
            Combine Mathlib with CSLib or Physlib. CSLib and Physlib currently
            require different Lean versions and cannot be selected together.
          </p>
        </>
      )}
      {preset === 'lean' && (
        <>
          <label className="field-label" htmlFor={`${idPrefix}lean-version`}>
            Lean version
          </label>
          <select
            id={`${idPrefix}lean-version`}
            value={customLeanVersion ? 'custom' : leanVersion}
            onChange={(event) => {
              const value = event.target.value
              setCustomLeanVersion(value === 'custom')
              setLeanVersion(value === 'custom' ? '' : value)
            }}
            disabled={busy}
            aria-describedby={`${idPrefix}lean-version-help`}
          >
            <option value="">
              {selected?.toolchain?.replace('leanprover/lean4:', '')} · Latest
              stable
            </option>
            {selected?.versions
              ?.filter(
                (version) =>
                  version !==
                  selected.toolchain?.replace('leanprover/lean4:', ''),
              )
              .map((version) => (
                <option key={version} value={version}>
                  {version}
                  {version.includes('-rc') ? ' · Release candidate' : ''}
                </option>
              ))}
            <option value="custom">Another exact version…</option>
          </select>
          {customLeanVersion && (
            <>
              <label
                className="field-label"
                htmlFor={`${idPrefix}custom-lean-version`}
              >
                Exact Lean version
              </label>
              <input
                id={`${idPrefix}custom-lean-version`}
                value={leanVersion}
                placeholder="e.g. v4.36.0-rc1"
                required
                onChange={(event) => setLeanVersion(event.target.value)}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </>
          )}
          <p id={`${idPrefix}lean-version-help`} className="field-help">
            Defaults to the latest stable Lean release. Choose another release
            or type an exact version, including a release candidate. The server
            installs and caches it when needed. Library presets use their
            compatible Lean versions; existing projects keep theirs.
          </p>
        </>
      )}
    </>
  )
}
