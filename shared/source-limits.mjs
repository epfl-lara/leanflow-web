// Limits apply to decoded UTF-8 source bytes, not JavaScript character counts.
export const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024
export const MAX_SOURCE_UPLOAD_BYTES = 32 * 1024 * 1024
export const SMALL_SOURCE_JSON_BYTES = 3 * 1024 * 1024

// JSON can escape one source byte as six bytes. Include room for file paths,
// hashes and the HTTP/LSP envelope without raising the decoded source limits.
export const MAX_SOURCE_JSON_BYTES = MAX_SOURCE_FILE_BYTES * 6 + 64 * 1024
// Up to 5,000 UTF-8 paths can add about 15 MiB at the permitted path length.
export const MAX_UPLOAD_JSON_BYTES =
  MAX_SOURCE_UPLOAD_BYTES * 6 + 16 * 1024 * 1024

// Dependency configuration stays small even when theorem files are large.
const configurationFiles = new Set([
  'lean-toolchain',
  'lake-manifest.json',
  'lakefile.toml',
  'lakefile.lean',
])
export function sourceFileByteLimit(filename) {
  return configurationFiles.has(filename.split('/').at(-1))
    ? 2 * 1024 * 1024
    : MAX_SOURCE_FILE_BYTES
}
