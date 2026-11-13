import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Auth } from '../auth.mjs'

const identity = {
  tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  objectId: '11111111-2222-3333-4444-555555555555',
  name: 'EPFL Collaborator',
}
const anotherIdentity = {
  ...identity,
  objectId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
}

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-entra-accounts-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const auth = new Auth(directory)
  await auth.init()
  return { auth, directory, owner: auth.users[0] }
}

test('EPFL sign-in requires an explicit link unless signup is enabled', async (t) => {
  const { auth, owner, directory } = await fixture(t)
  const { user: existing } = await auth.createUser(owner, {
    name: identity.name,
    role: 'admin',
  })
  await assert.rejects(auth.signInEntra(identity), { status: 403 })
  const created = await auth.signInEntra(identity, { allowSignup: true })
  assert.notEqual(created.id, existing.id)
  assert.equal(created.name, 'EPFL Collaborator 2')
  assert.equal(created.role, 'user')
  assert.equal(created.tokenHash, undefined)
  assert.deepEqual(auth.public(created), {
    id: created.id,
    name: created.name,
    role: 'user',
    profileComplete: false,
    entraLinked: true,
  })
  assert.equal(auth.public(existing).entraLinked, undefined)
  const reopened = new Auth(directory)
  await reopened.init()
  const signedIn = await reopened.signInEntra({
    ...identity,
    tenantId: identity.tenantId.toUpperCase(),
    objectId: identity.objectId.toUpperCase(),
    name: 'Changed EPFL Name',
  })
  assert.equal(signedIn.id, created.id)
  assert.equal(signedIn.name, created.name)
  assert.deepEqual(signedIn.entra, {
    tenantId: identity.tenantId,
    objectId: identity.objectId,
  })
})

test('EPFL signup cannot acquire owner or administrator privileges', async (t) => {
  const { auth } = await fixture(t)
  const created = await auth.signInEntra(
    { ...identity, name: 'Owner', id: 'owner', role: 'owner' },
    { allowSignup: true },
  )
  assert.equal(created.name, 'Owner 2')
  assert.notEqual(created.id, 'owner')
  assert.equal(auth.public(created).role, 'user')
  assert.throws(() => auth.requireAdmin(created), { status: 403 })
})

test('EPFL identity uses both tenant and object IDs', async (t) => {
  const { auth } = await fixture(t)
  const first = await auth.signInEntra(identity, { allowSignup: true })
  const second = await auth.signInEntra(
    { ...identity, tenantId: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb' },
    { allowSignup: true },
  )
  assert.notEqual(first.id, second.id)
  assert.equal(second.name, 'EPFL Collaborator 2')
  assert.equal((await auth.signInEntra(identity)).id, first.id)
})

test('EPFL-only accounts cannot sign in using an access token', async (t) => {
  const { auth } = await fixture(t)
  const created = await auth.signInEntra(identity, { allowSignup: true })
  for (const token of [undefined, null, '', created.id, identity.objectId])
    await assert.rejects(auth.login(token, 'fixture-ip'), { status: 401 })
  assert.equal(
    auth.identify({ headers: { authorization: `Bearer ${created.id}` } }),
    null,
  )
  assert.equal(
    auth.identify({ headers: { cookie: auth.cookie(created).split(';')[0] } })
      .id,
    created.id,
  )
})

test('explicit EPFL linking preserves the local identity, role and token', async (t) => {
  const { auth, owner, directory } = await fixture(t)
  const { user, token } = await auth.createUser(owner, {
    name: 'Existing Administrator',
    role: 'admin',
  })
  const before = { ...auth.users.find((current) => current.id === user.id) }
  const linked = await auth.linkEntra(user, identity)
  assert.deepEqual(linked, {
    ...before,
    entra: { tenantId: identity.tenantId, objectId: identity.objectId },
  })
  assert.equal((await auth.login(token, 'fixture-ip')).id, user.id)
  const reopened = new Auth(directory)
  await reopened.init()
  assert.equal((await reopened.signInEntra(identity)).id, user.id)
  assert.equal((await reopened.signInEntra(identity)).role, 'admin')
  assert.equal((await reopened.login(token, 'fixture-ip')).id, user.id)
})

test('linking rejects unavailable local accounts and conflicting EPFL identities', async (t) => {
  const { auth, owner } = await fixture(t)
  const { user } = await auth.createUser(owner, {
    name: 'Another Collaborator',
  })
  await assert.rejects(auth.linkEntra(null, identity), { status: 401 })
  await assert.rejects(auth.linkEntra({ id: 'removed' }, identity), {
    status: 401,
  })
  await auth.linkEntra(owner, identity)
  await auth.linkEntra(owner, {
    ...identity,
    objectId: identity.objectId.toUpperCase(),
  })
  await assert.rejects(auth.linkEntra(user, identity), { status: 409 })
  await assert.rejects(auth.linkEntra(owner, anotherIdentity), { status: 409 })
  assert.equal((await auth.signInEntra(identity)).id, owner.id)
  assert.equal(
    auth.users.find((current) => current.id === user.id).entra,
    undefined,
  )
})

test('EPFL session recovery cannot create or switch accounts', async (t) => {
  const { auth, owner } = await fixture(t)
  const created = await auth.signInEntra(identity, { allowSignup: true })
  await assert.rejects(
    auth.signInEntra(anotherIdentity, {
      allowSignup: true,
      expectedUserId: created.id,
    }),
    { status: 409 },
  )
  await assert.rejects(
    auth.signInEntra(identity, { allowSignup: true, expectedUserId: owner.id }),
    { status: 409 },
  )
  await assert.rejects(
    auth.signInEntra(anotherIdentity, {
      allowSignup: true,
      expectedUserId: 'removed',
    }),
    { status: 409 },
  )
  assert.equal(auth.users.length, 2)
  assert.equal(
    (await auth.signInEntra(identity, { expectedUserId: created.id })).id,
    created.id,
  )
})

test('concurrent EPFL signup creates one persistent account per identity', async (t) => {
  const { auth, directory } = await fixture(t)
  const users = await Promise.all(
    Array.from({ length: 12 }, () =>
      auth.signInEntra(identity, { allowSignup: true }),
    ),
  )
  assert.equal(new Set(users.map((user) => user.id)).size, 1)
  const reopened = new Auth(directory)
  await reopened.init()
  assert.equal(reopened.users.length, 2)
  assert.equal((await reopened.signInEntra(identity)).id, users[0].id)
})

test('concurrent EPFL links cannot assign one identity to two local accounts', async (t) => {
  const { auth, owner, directory } = await fixture(t)
  const { user } = await auth.createUser(owner, {
    name: 'Another Collaborator',
  })
  const results = await Promise.allSettled([
    auth.linkEntra(owner, identity),
    auth.linkEntra(user, identity),
  ])
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  const rejected = results.find((result) => result.status === 'rejected')
  assert.equal(rejected.reason.status, 409)
  const reopened = new Auth(directory)
  await reopened.init()
  assert.equal(reopened.users.filter((current) => current.entra).length, 1)
})

test('EPFL names remain safe and unique at the maximum local length', async (t) => {
  const { auth, owner } = await fixture(t)
  const name = 'A'.repeat(80)
  await auth.createUser(owner, { name })
  const first = await auth.signInEntra(
    { ...identity, name },
    { allowSignup: true },
  )
  const second = await auth.signInEntra(
    { ...anotherIdentity, name },
    { allowSignup: true },
  )
  assert.equal(first.name, 'A'.repeat(78) + ' 2')
  assert.equal(second.name, 'A'.repeat(78) + ' 3')
})

test('malformed EPFL identities and unsafe display names cannot persist accounts', async (t) => {
  const { auth, owner, directory } = await fixture(t)
  for (const invalid of [
    null,
    [],
    { ...identity, tenantId: '' },
    { ...identity, tenantId: `${identity.tenantId}/other` },
    { ...identity, objectId: null },
    { ...identity, objectId: 'not-a-guid' },
    { ...identity, name: '' },
    { ...identity, name: '<script>alert(1)</script>' },
    { ...identity, name: 'A'.repeat(81) },
    { ...identity, name: 'Name\nOther' },
  ]) {
    await assert.rejects(auth.signInEntra(invalid, { allowSignup: true }), {
      status: 400,
    })
    await assert.rejects(auth.linkEntra(owner, invalid), { status: 400 })
  }
  const reopened = new Auth(directory)
  await reopened.init()
  assert.equal(reopened.users.length, 1)
  assert.equal(reopened.users[0].entra, undefined)
})
