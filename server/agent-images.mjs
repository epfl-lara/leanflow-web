import { promises as fs } from 'node:fs'
import path from 'node:path'
import { imageMimeType } from '../shared/file-previews.mjs'

const MAX_ATTACHED_IMAGES = 4
const MAX_ATTACHED_IMAGE_BYTES = 8 * 1024 * 1024
const nativeImage = (filename) =>
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
    imageMimeType(filename),
  )

export function modelSupportsImages(catalog, model) {
  const profile = catalog?.models?.find(
    (entry) => (entry.slug || entry.id) === model,
  )
  return (
    Array.isArray(profile?.input_modalities) &&
    profile.input_modalities.includes('image')
  )
}

export function agentImageInstructions(supportsImages) {
  const capability = supportsImages
    ? '\nImage input is available for this model. Use the native view_image tool to inspect raster images in your working project or temporary files. For scanned PDFs, render the relevant page to PNG in /tmp and inspect it with view_image. Convert SVG or other unsupported formats to PNG in /tmp before using that tool. Do not claim images are unavailable merely because they are not text files.\n'
    : '\nThe selected model does not advertise image input through this provider. Image file paths are reference context, not a visual attachment. Report this limitation honestly when visual inspection is required; do not change the selected model or reasoning effort.\n'
  return (
    capability +
    'To show an existing uploaded project image, use Markdown ![description](relative/project/path.png) or a relative file link. For a new diagram that should be shared, create editable SVG text in the project and link its .svg path. Keep raster/PDF rendering scratch in /tmp for inspection. New binary image files in your private copy are not published by source edits; do not claim they were saved in the shared project. Temporary paths, large base64 content, data URLs and external image URLs are not shared project images.\n'
  )
}

// Attach only files in the immutable capture, before the worker starts. Paths
// sent to Lemex use its mounted workspace; no host path or image bytes enter
// job history. Additional/larger images remain available through view_image.
export async function capturedImageInputs(job, snapshot, supportsImages) {
  if (!supportsImages || !snapshot?.root) return []
  const captured = new Set(snapshot.files?.map((file) => file.path) || [])
  const selected = [
    ...new Set([...(job.files || []), job.currentFile].filter(Boolean)),
  ]
  const input = []
  let bytes = 0
  for (const filename of selected) {
    if (input.length >= MAX_ATTACHED_IMAGES) break
    if (!nativeImage(filename) || !captured.has(filename)) continue
    const absolute = path.resolve(snapshot.root, filename)
    if (!absolute.startsWith(path.resolve(snapshot.root) + path.sep)) continue
    try {
      const stat = await fs.lstat(absolute)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size === 0 ||
        bytes + stat.size > MAX_ATTACHED_IMAGE_BYTES ||
        (await fs.realpath(absolute)) !== absolute
      )
        continue
      bytes += stat.size
      input.push({ type: 'localImage', path: `/workspace/${filename}` })
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
    }
  }
  return input
}
