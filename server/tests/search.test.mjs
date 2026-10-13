import test from 'node:test'
import assert from 'node:assert/strict'
import { searchDeclarations } from '../search.mjs'

const owner = 'alice'
const workspaces = {
  get(id, actualOwner) {
    assert.equal(id, 'project')
    assert.equal(actualOwner, owner)
    return { toolchain: 'leanprover/lean4:v4.34.1' }
  },
}

async function search(data, backend = 'leanexplore', request = {}) {
  const calls = []
  const response = await searchDeclarations(
    { query: ' Nat.add_comm ', backend, projectId: 'project', ...request },
    owner,
    workspaces,
    {
      async fetchImpl(url, options) {
        calls.push({ url, options })
        return new Response(JSON.stringify(data))
      },
    },
  )
  assert.equal(
    calls.length,
    1,
    'Search results do not require one fetch per declaration',
  )
  return { response, call: calls[0] }
}

// Loogle's anonymous /json response, checked live on 2026-10-13:
// https://loogle.lean-lang.org/json?q=Nat.add_comm
test('Loogle preserves the complete printed type without guessing declaration kind', async () => {
  const { response, call } = await search(
    {
      count: 14,
      hits: [
        {
          doc: null,
          module: 'Init.Data.Nat.Basic',
          name: 'Nat.add_comm',
          type: ' (n m : ℕ) : n + m = m + n',
        },
      ],
    },
    'loogle',
  )
  assert.deepEqual(response.results, [
    {
      name: 'Nat.add_comm',
      type: '(n m : ℕ) : n + m = m + n',
      signature: '',
      signatureSource: 'type',
      kind: null,
      doc: '',
      module: 'Init.Data.Nat.Basic',
      url: null,
    },
  ])
  assert.equal(response.count, 14)
  assert.equal(response.backend, 'loogle')
  assert.equal(response.source.workspaceToolchain, 'leanprover/lean4:v4.34.1')
  assert.equal(call.url.origin, 'https://loogle.lean-lang.org')
  assert.equal(call.url.searchParams.get('q'), 'Nat.add_comm')
})

// Current official v2 fields are documented here (and verified in a live search):
// https://github.com/justincasher/lean-explore/blob/main/docs/data-models.md
// https://github.com/justincasher/lean-explore/blob/main/src/lean_explore/models/search_types.py
test('LeanExplore v2 source_text produces a signature, docs, kind and source link', async () => {
  const link =
    'https://github.com/leanprover/lean4/blob/v4.32.0/src/lean/Init/Data/Nat/Basic.lean#L158-L163'
  const { response, call } = await search({
    count: 2,
    results: [
      {
        id: 15320,
        name: 'Nat.add_comm',
        module: 'Init.Data.Nat.Basic',
        docstring: null,
        informalization:
          '**Commutativity of Addition for Natural Numbers.** For any two natural numbers…',
        source_link: link,
        source_text:
          'protected theorem add_comm : ∀ (n m : Nat), n + m = m + n\n  | n, 0   => Eq.symm (Nat.zero_add n)\n  | n, m+1 => by\n    have : succ (n + m) = succ (m + n) := by apply congrArg; apply Nat.add_comm\n    rw [succ_add m n]\n    apply this\n',
      },
      {
        id: 68108,
        name: 'AddCommMonoid',
        module: 'Mathlib.Algebra.Group.Defs',
        docstring:
          'An additive commutative monoid is an additive monoid with commutative `(+)`. ',
        source_link:
          'https://github.com/leanprover-community/mathlib4/blob/aae61ae084c21995ee248964a81e3750ad0db2db/Mathlib/Algebra/Group/Defs.lean#L800-L801',
        source_text:
          '/-- An additive commutative monoid is an additive monoid with commutative `(+)`. -/\nclass AddCommMonoid (M : Type u) extends AddMonoid M, AddCommSemigroup M\n',
      },
    ],
  })
  assert.equal(
    response.results[0].signature,
    'protected theorem add_comm : ∀ (n m : Nat), n + m = m + n',
  )
  assert.equal(response.results[0].type, '')
  assert.equal(response.results[0].signatureSource, 'source')
  assert.equal(response.results[0].kind, 'theorem')
  assert.equal(response.results[0].url, link)
  assert.equal(response.results[1].kind, 'class')
  assert.equal(
    response.results[1].signature,
    'class AddCommMonoid (M : Type u) extends AddMonoid M, AddCommSemigroup M',
  )
  assert.match(response.results[1].doc, /commutative/)
  assert.equal(call.url.searchParams.get('limit'), '12')
  assert.equal(call.options.headers.authorization, undefined)
  assert.equal(call.options.headers['x-api-key'], undefined)
  assert.equal('source_text' in response.results[0], false)
  assert.equal('informalization' in response.results[0], false)
})

test('source signatures stop at the outer proof or where, preserving nested defaults and literals', async () => {
  const fixtures = [
    [
      '@[simp] theorem useful (n : Nat := 1) : n = n := by\n  rfl',
      '@[simp] theorem useful (n : Nat := 1) : n = n',
      'theorem',
    ],
    [
      'def literal (h : ":= where" = r#":="#) : Bool := true',
      'def literal (h : ":= where" = r#":="#) : Bool',
      'def',
    ],
    [
      "def chars (c : Char := 'x') : Char := c",
      "def chars (c : Char := 'x') : Char",
      'def',
    ],
    [
      '/- fake theorem bad := /- nested := -/ ignored -/\ntheorem actual (h : True /- := -/) : True := h',
      'theorem actual (h : True /- := -/) : True',
      'theorem',
    ],
    ['def «where» (n : Nat) : Nat := n', 'def «where» (n : Nat) : Nat', 'def'],
    [
      'structure Record (α : Type) where\n  value : α',
      'structure Record (α : Type)',
      'structure',
    ],
    [
      'inductive Choice where\n  | left\n  | right',
      'inductive Choice',
      'inductive',
    ],
    [
      'theorem nonneg_abs (x : ℝ) :\n  |x| ≥ 0 := by exact abs_nonneg x',
      'theorem nonneg_abs (x : ℝ) :\n  |x| ≥ 0',
      'theorem',
    ],
    [
      "theorem primed (where' : Nat) : where' = where' := by rfl",
      "theorem primed (where' : Nat) : where' = where'",
      'theorem',
    ],
    [
      'theorem unicode (whereα byα : Nat) : whereα = byα → byα = whereα := by omega',
      'theorem unicode (whereα byα : Nat) : whereα = byα → byα = whereα',
      'theorem',
    ],
  ]
  const { response } = await search({
    results: fixtures.map(([source_text], index) => ({
      name: `item${index}`,
      source_text,
    })),
  })
  for (let index = 0; index < fixtures.length; index++) {
    assert.equal(response.results[index].signature, fixtures[index][1])
    assert.equal(response.results[index].kind, fixtures[index][2])
    assert.equal(response.results[index].type, '')
  }
})

test('missing and ambiguous source types remain unavailable without reusing descriptions or proof bodies', async () => {
  const { response } = await search({
    results: [
      {
        name: 'Name.only',
        description: 'This is not a Lean type.',
        docstring: 'Documentation only.',
      },
      {
        name: 'TermType',
        source_text: 'def TermType : let n := 2; Fin n := ⟨0, by decide⟩',
      },
      {
        name: 'MatchType',
        source_text:
          'def MatchType : match true with | true => Nat | false => Bool := 0',
      },
      {
        name: 'Malformed',
        source_text: 'theorem Malformed : True := by /- unterminated',
      },
      {
        name: 'TooLarge',
        source_text: `theorem TooLarge : True := by\n--${'x'.repeat(64_000)}`,
      },
    ],
  })
  for (const item of response.results) {
    assert.equal(item.type, '')
    assert.equal(item.signature, '')
    assert.equal(item.signatureSource, null)
  }
  assert.equal(response.results[0].doc, 'Documentation only.')
  assert.equal(response.results[1].kind, 'def')
})

test('explicit API signature, formal statement and supplied kind are distinct from inferred types', async () => {
  const { response } = await search({
    results: [
      {
        declaration_name: 'List.map',
        signature: '(α → β) → List α → List β',
        declaration_kind: 'definition',
      },
      {
        declarationName: 'Nat.add_zero',
        formal_statement: '(n : Nat) : n + 0 = n',
        kind: 'theorem',
      },
      { name: 'Unknown', kind: 'this is not a declaration kind' },
      {
        name: 'TypeWins',
        type: 'Nat → Nat',
        signature: 'def TypeWins : Nat → Nat',
        source_text: 'def TypeWins := fun n => n',
      },
    ],
  })
  assert.equal(response.results[0].signature, '(α → β) → List α → List β')
  assert.equal(response.results[0].type, '')
  assert.equal(response.results[0].signatureSource, 'signature')
  assert.equal(response.results[0].kind, 'def')
  assert.equal(response.results[1].signature, '(n : Nat) : n + 0 = n')
  assert.equal(response.results[1].kind, 'theorem')
  assert.equal(response.results[2].kind, null)
  assert.equal(response.results[3].type, 'Nat → Nat')
  assert.equal(response.results[3].signatureSource, 'type')
})

test('external links reject executable protocols and credentials and results exclude unknown API fields', async () => {
  const safe =
    'https://github.com/leanprover-community/mathlib4/blob/master/Mathlib/Data/Nat/Basic.lean#L20'
  const { response } = await search({
    results: [
      {
        name: 'Unsafe',
        url: 'javascript:alert(1)',
        api_key: 'fixture-secret',
        type: { unexpected: 'value' },
      },
      { name: 'Credentials', url: 'https://user:password@example.org/source' },
      { name: 'Fallback', url: 'data:text/html,unsafe', source_link: safe },
    ],
  })
  assert.equal(response.results[0].url, null)
  assert.equal(response.results[0].type, '')
  assert.equal(response.results[1].url, null)
  assert.equal(response.results[2].url, safe)
  assert.equal(JSON.stringify(response).includes('fixture-secret'), false)
})

test('hosted errors remain actionable and searches preserve owner authorization before fetching', async () => {
  await assert.rejects(
    searchDeclarations(
      { query: 'x', backend: 'leanexplore' },
      owner,
      workspaces,
      {
        fetchImpl: async () => new Response('', { status: 403 }),
      },
    ),
    { status: 502, message: /LeanExplore is unavailable \(HTTP 403\)/ },
  )
  await assert.rejects(search({ error: 'Unknown constant' }, 'loogle'), {
    status: 400,
    message: 'Unknown constant',
  })
  let fetched = false
  await assert.rejects(
    searchDeclarations(
      { query: 'x', backend: 'loogle', projectId: 'other' },
      owner,
      {
        get() {
          throw Object.assign(new Error('Project not found'), { status: 404 })
        },
      },
      {
        fetchImpl: async () => {
          fetched = true
        },
      },
    ),
    { status: 404 },
  )
  assert.equal(fetched, false)
})

test('search response and individual fields remain bounded', async () => {
  const { response } = await search({
    results: Array.from({ length: 45 }, (_, index) => ({
      name: `Item${index}`,
      type: 'x'.repeat(20_000),
      docstring: 'd'.repeat(10_000),
    })),
  })
  assert.equal(response.results.length, 30)
  assert.equal(response.results[0].type.length, 16_002)
  assert.equal(response.results[0].doc.length, 8_002)
  await assert.rejects(
    searchDeclarations({ query: 'x', backend: 'loogle' }, owner, workspaces, {
      fetchImpl: async () => new Response('x'.repeat(2_000_001)),
    }),
    { message: 'Search response exceeded the size limit.' },
  )
})
