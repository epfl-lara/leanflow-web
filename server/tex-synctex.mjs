import { isTexFile, safeTexPath } from '../shared/tex.mjs'

export const TEX_SYNCTEX_MAX_BYTES = 1024 * 1024

const maxBoxes = 20000
const maxCoordinate = 65536
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)

// Accept only the compact map produced by the compiler worker and validate its
// destinations against the immutable source snapshot before publishing it.
export function validateTexSyncTex(content, files, pageCount) {
  if (!positiveInteger(pageCount)) return false
  try {
    const map = JSON.parse(content)
    if (
      map?.schema !== 1 ||
      !Array.isArray(map.paths) ||
      !map.paths.length ||
      map.paths.length > files.length ||
      new Set(map.paths).size !== map.paths.length ||
      !object(map.pages)
    )
      return false

    const known = new Set(files.map(({ path }) => path))
    if (
      !map.paths.every(
        (path) => isTexFile(safeTexPath(path)) && known.has(path),
      )
    )
      return false

    let total = 0
    for (const [page, boxes] of Object.entries(map.pages)) {
      if (
        !/^[1-9]\d{0,6}$/u.test(page) ||
        Number(page) > pageCount ||
        !Array.isArray(boxes) ||
        !boxes.length ||
        (total += boxes.length) > maxBoxes
      )
        return false
      for (const box of boxes) {
        if (!Array.isArray(box) || box.length !== 6) return false
        const [index, line, x, y, width, height] = box
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= map.paths.length ||
          !positiveInteger(line) ||
          ![x, y, width, height].every(Number.isFinite) ||
          x < 0 ||
          y < 0 ||
          width <= 0 ||
          height <= 0 ||
          x + width > maxCoordinate ||
          y + height > maxCoordinate
        )
          return false
      }
    }
    return total > 0
  } catch {
    return false
  }
}

// The manager checks the saved digest before decoding the validated map.
export function texSyncTexPage(content, page) {
  const { paths, pages } = JSON.parse(content)
  return (pages[page] || []).map(([index, line, x, y, width, height]) => ({
    path: paths[index],
    line,
    x,
    y,
    width,
    height,
  }))
}
