// Shared by the fast guard regressions and the real pinned Lean check.
export const proofLayouts = [
  {
    name: 'unindented by on the next line',
    before: 'theorem target : True :=\nby\n  sorry\n',
    after: 'theorem target : True :=\nby\n  trivial\n',
  },
  {
    name: 'term proof on the next line',
    before: 'theorem target : True :=\nsorry\n',
    after: 'theorem target : True :=\nTrue.intro\n',
  },
  {
    name: 'anonymous example',
    before: 'example : True := by\n  sorry\n',
    after: 'example : True := by\n  trivial\n',
  },
  {
    name: 'helper proof in a theorem where block',
    before:
      'theorem target : True := by\n  exact helper\nwhere\n  helper : True := by\n    sorry\n',
    after:
      'theorem target : True := by\n  exact helper\nwhere\n  helper : True := by\n    trivial\n',
  },
  {
    name: 'comments inside an unchanged statement',
    before: 'theorem target (n : Nat) : n = n := by\n  sorry\n',
    after:
      'theorem target (n /- still the same binder -/ : Nat) : n = n := by\n  rfl\n',
  },
  {
    name: 'formatting around statement punctuation',
    before: 'theorem target (n : Nat) : n = n := by\n  sorry\n',
    after: 'theorem target(n:Nat):n=n:=by\n  rfl\n',
  },
  {
    name: 'nested tactic blocks and CRLF lines',
    before:
      'namespace Example\r\n@[simp]\r\ntheorem target : True ∧ True := by\r\n  sorry\r\nend Example\r\n',
    after:
      'namespace Example\r\n@[simp]\r\ntheorem target : True ∧ True := by\r\n  constructor\r\n  · have h : True := by\r\n      trivial\r\n    exact h\r\n  · trivial\r\nend Example\r\n',
  },
]
