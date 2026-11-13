import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import * as previews from '../../../shared/file-previews.mjs'

const modules = new Map()
function load(name) {
  if (name === '../../../shared/file-previews.mjs') return previews
  if (modules.has(name)) return modules.get(name)
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL(name + '.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  )
  const module = { exports: {} }
  new Function('exports', 'module', 'require', outputText)(
    module.exports,
    module,
    load,
  )
  modules.set(name, module.exports)
  return module.exports
}
const {
  leanCommentImages,
  MAX_LEAN_COMMENT_IMAGES,
  MAX_LEAN_COMMENT_SOURCE_LENGTH,
} = load('./leanCommentImages')

test('line, block and doc comments display local image links at their source lines', () => {
  assert.deepEqual(
    leanCommentImages(
      [
        'import Mathlib',
        '-- ![Triangle](figures/triangle.svg)',
        '/--',
        'A [Diagram](../diagram.png "Diagram title").',
        '![A space](<../figures/My Diagram.svg>)',
        '-/',
        'example : True := by trivial -- [Proof](proof.lean)',
      ].join('\r\n'),
      'Chapter/Main.lean',
    ),
    [
      { lineNumber: 2, path: 'Chapter/figures/triangle.svg', alt: 'Triangle' },
      { lineNumber: 4, path: 'diagram.png', alt: 'Diagram' },
      { lineNumber: 5, path: 'figures/My Diagram.svg', alt: 'A space' },
    ],
  )
})

test('nested and unfinished comments retain accurate anchors without treating following code as comments', () => {
  assert.deepEqual(
    leanCommentImages(
      '/- outer\n/- ![Nested](nested.svg) -/\n[Outer](outer.svg) -/\n' +
        '#check "![String](string.svg)"\n/- ![Unfinished](last.svg)',
      'Main.lean',
    ),
    [
      { lineNumber: 2, path: 'nested.svg', alt: 'Nested' },
      { lineNumber: 3, path: 'outer.svg', alt: 'Outer' },
      { lineNumber: 5, path: 'last.svg', alt: 'Unfinished' },
    ],
  )
})

test('string literals, raw strings, characters and quoted names cannot invent comments', () => {
  const source = [
    String.raw`def ordinary := "escaped \" /- ![Wrong](ordinary.svg) -/"`,
    'def multiline := "first',
    '-- ![Wrong](multiline.svg)',
    'last"',
    'def raw := r##" " /- ![Wrong](raw.svg) -/ "##',
    'def rawPlain := r"-- ![Wrong](raw-plain.svg)"',
    String.raw`def quote := '\"'`,
    'def «-- ![Wrong](name.svg)» := 1',
    "def x' := 1 -- ![Right](right.svg)",
  ].join('\n')
  assert.deepEqual(leanCommentImages(source, 'Main.lean'), [
    { lineNumber: 9, path: 'right.svg', alt: 'Right' },
  ])
})

test('only references inside comments can display images', () => {
  assert.deepEqual(
    leanCommentImages(
      '![Outside](outside.svg)\n[Outside](outside.png)\n' +
        '-- \\![Escaped](escaped.svg) \\[Escaped](escaped2.svg)\n' +
        '-- ![Visible](visible.svg) [Again](again.webp)',
      'Main.lean',
    ),
    [
      { lineNumber: 4, path: 'visible.svg', alt: 'Visible' },
      { lineNumber: 4, path: 'again.webp', alt: 'Again' },
    ],
  )
})

test('nested string interpolation keeps literal comment markers out of previews', () => {
  assert.deepEqual(
    leanCommentImages(
      [
        'def text := s!"{ "inner" } /- ![Wrong](literal.svg) -/"',
        'def nested := s!"{ s!"{ "inner" } -- ![Wrong](nested.svg)" }"',
        'def braces := s!"{{ /- ![Wrong](escaped-brace.svg) -/ }}"',
        '-- ![Right](right.svg)',
      ].join('\n'),
      'Main.lean',
    ),
    [{ lineNumber: 4, path: 'right.svg', alt: 'Right' }],
  )
})

test('image references reuse project boundaries and never become remote requests', () => {
  const unsafe = [
    'https://example.com/image.svg',
    '//example.com/image.svg',
    'data:image/svg+xml,unsafe.svg',
    'javascript:unsafe.svg',
    '../../outside.svg',
    '%2e%2e/%2e%2e/outside.svg',
    'image.png%00',
    '..\\outside.svg',
    'image%ZZ.svg',
    'proof.lean',
  ]
  assert.deepEqual(
    leanCommentImages(
      unsafe.map((path) => `-- ![Unsafe](${path})`).join('\n'),
      'Chapter/Main.lean',
    ),
    [],
  )
  assert.deepEqual(
    leanCommentImages(
      '-- ![Saved](/workspace/figures/Saved%20Plot.SVG)\n' +
        '-- ![](../empty-alt.png)',
      'Chapter/Main.lean',
    ),
    [
      { lineNumber: 1, path: 'figures/Saved Plot.SVG', alt: 'Saved' },
      { lineNumber: 2, path: 'empty-alt.png', alt: 'empty-alt.png' },
    ],
  )
})

test('preview count and source size are bounded and non-Lean documents stay untouched', () => {
  const source = Array.from(
    { length: MAX_LEAN_COMMENT_IMAGES + 10 },
    (_, index) => `-- ![Figure ${index}](figure-${index}.svg)`,
  ).join('\n')
  const images = leanCommentImages(source, 'Main.lean')
  assert.equal(images.length, MAX_LEAN_COMMENT_IMAGES)
  assert.equal(images.at(-1).lineNumber, MAX_LEAN_COMMENT_IMAGES)
  assert.deepEqual(leanCommentImages(source, 'README.md'), [])
  assert.deepEqual(
    leanCommentImages(
      '-- ![First](first.svg)\n' + ' '.repeat(MAX_LEAN_COMMENT_SOURCE_LENGTH),
      'Main.lean',
    ),
    [],
  )
  assert.equal(
    leanCommentImages(
      '/-\n' + source + '\n-/\n-- ![Last](last.svg)',
      'Main.lean',
    ).length,
    MAX_LEAN_COMMENT_IMAGES,
  )
})
