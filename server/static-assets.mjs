import path from 'node:path'
import express from 'express'

export function staticAssets(directory) {
  const assets = path.join(directory, 'assets') + path.sep
  return express.static(directory, {
    index: 'index.html',
    setHeaders(response, filename) {
      // Vite fingerprints the asset contents. Only these URLs are permanent;
      // the entry page, manifest, workers and public files must revalidate.
      const fingerprinted =
        filename.startsWith(assets) &&
        /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/.test(path.basename(filename))
      response.setHeader(
        'Cache-Control',
        fingerprinted ? 'public, max-age=31536000, immutable' : 'no-cache',
      )
    },
  })
}
