import {
  gitCredentialsRunner,
  gitHttpsArgs,
  gitHttpsEnv,
  redactGitCredentials,
  cleanupGitWorkerHome,
} from './git-credentials.mjs'

/** Only Git receives the one-use secret. No project code runs in this worker. */
export async function runAuthenticatedRepositoryGit({
  runtime,
  dataDir,
  root,
  args,
  credentials,
  signal,
  timeoutMs = 900000,
  emptyRepositoryClone = false,
}) {
  let child
  try {
    const result = await runtime.run(
      root,
      ['python3', '-c', gitCredentialsRunner, ...gitHttpsArgs, ...args],
      {
        input: JSON.stringify(credentials),
        env: gitHttpsEnv,
        signal,
        timeoutMs,
        network: 'bridge',
        emptyRepositoryClone,
        freshHome: true,
        cleanHome: true,
        readOnlyHome: true,
        maxOutputBytes: 1024 * 1024,
        onSpawn: (worker) => {
          child = worker
        },
        // Collect first, then redact: a secret can span output chunks.
      },
    )
    return {
      ...result,
      // Truncation can split a credential, leaving an unmatchable prefix.
      stdout: result.truncated
        ? ''
        : redactGitCredentials(result.stdout || '', credentials),
      stderr: result.truncated
        ? 'Git output exceeded the import limit. Check the repository and retry.'
        : redactGitCredentials(result.stderr || '', credentials),
    }
  } catch (error) {
    error.message = redactGitCredentials(error.message, credentials)
    throw error
  } finally {
    await cleanupGitWorkerHome(child, dataDir)
  }
}
