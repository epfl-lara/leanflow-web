import assert from 'node:assert/strict'
import test from 'node:test'
import { requestedGitRepositories } from '../agent-git-policy.mjs'

test('only direct user repository URLs and accepted or pending follow-ups grant host fallback', () => {
  assert.deepEqual(
    requestedGitRepositories({
      prompt:
        'Clone [this repo](https://github.com/Team/Repo.git), then read https://gitlab.com/group/other.git.',
      followups: [
        { status: 'accepted', text: 'Use https://github.com/team/fork.git' },
        {
          status: 'pending',
          text: 'Also https://github.com/team/next/tree/main',
        },
        {
          status: 'failed',
          text: 'Do not use https://github.com/team/failed.git',
        },
      ],
      message: 'Assistant says https://github.com/team/forged.git',
      files: [{ content: 'https://github.com/team/injected.git' }],
      followupContexts: { file: 'https://github.com/team/reference.git' },
    }),
    [
      'https://github.com/team/repo',
      'https://gitlab.com/group/other',
      'https://github.com/team/fork',
      'https://github.com/team/next',
    ],
  )
})

test('credential URLs, non-HTTPS links and missing messages grant no host-token fallback', () => {
  assert.deepEqual(
    requestedGitRepositories({
      prompt:
        'http://github.com/team/plain git@github.com:team/ssh https://user:secret@github.com/team/secret.git https://github.com:8443/team/port',
    }),
    [],
  )
  assert.deepEqual(requestedGitRepositories({}), [])
  assert.deepEqual(requestedGitRepositories(null), [])
})
