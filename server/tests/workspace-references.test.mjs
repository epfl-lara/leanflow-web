import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createReferenceRewriter,
  isReferenceFile,
  rewriteProjectReferences,
} from '../workspace-references.mjs'

const figureMove = {
  from: 'Problems/Figure.svg',
  to: 'Problems/figures/Figure.svg',
  files: ['Problems/Figure.svg', 'Problems/Main.lean', 'README.md', 'main.tex'],
}

test('recognizes source formats with supported local reference syntax', () => {
  for (const filename of [
    'Main.lean',
    'README.md',
    'notes.Markdown',
    'main.tex',
  ])
    assert.equal(isReferenceFile(filename), true)
  for (const filename of [
    'figure.svg',
    'image.png',
    'lakefile.toml',
    'data.json',
  ])
    assert.equal(isReferenceFile(filename), false)
})

test('moving a figure updates Markdown images, links and definitions without changing titles', () => {
  const source = [
    '![Figure](Problems/Figure.svg "My figure")',
    '[open][figure]',
    '[figure]: <Problems/Figure.svg#part> "The figure"',
    '[![Nested](Problems/Figure.svg)](Problems/Figure.svg?download=1)',
  ].join('\n')
  const result = createReferenceRewriter(figureMove)(source, 'README.md')
  assert.equal(result.count, 4)
  assert.equal(
    result.content,
    source.replaceAll('Problems/Figure.svg', 'Problems/figures/Figure.svg'),
  )
})

test('Lean comments update local links while literal strings and unrelated text stay untouched', () => {
  const source = [
    'import Mathlib',
    '-- ![Figure](Figure.svg)',
    '/- Outer /- [nested](Figure.svg) -/ [next](Figure.svg) -/',
    'def text := "![Figure](Figure.svg)"',
    'def raw := r##" "/- [Wrong](Figure.svg) -/ "##',
    'def «-- [Wrong](Figure.svg)» := 1',
    '-- Figure.svg is a path mentioned in prose.',
  ].join('\n')
  const result = createReferenceRewriter(figureMove)(
    source,
    'Problems/Main.lean',
  )
  assert.equal(result.count, 3)
  assert.match(result.content, /!\[Figure\]\(figures\/Figure.svg\)/)
  assert.match(result.content, /\[nested\]\(figures\/Figure.svg\)/)
  assert.match(result.content, /\[next\]\(figures\/Figure.svg\)/)
  assert.match(result.content, /def text := "!\[Figure\]\(Figure.svg\)"/)
  assert.match(result.content, /r##" "\/- \[Wrong\]\(Figure.svg\) -\/ "##/)
  assert.match(result.content, /Figure.svg is a path mentioned in prose/)
})

test('code examples and escaped Markdown links remain literal', () => {
  const source = [
    '`![Inline](Problems/Figure.svg)`',
    '``code ` ![Inside](Problems/Figure.svg) ``',
    '```lean',
    '![Fenced](Problems/Figure.svg)',
    '[figure]: Problems/Figure.svg',
    '```',
    '    ![Indented](Problems/Figure.svg)',
    '\\![Escaped](Problems/Figure.svg)',
    '<!-- ![Comment](Problems/Figure.svg) -->',
    '![Actual](Problems/Figure.svg)',
  ].join('\n')
  const result = createReferenceRewriter(figureMove)(source, 'README.md')
  assert.equal(result.count, 1)
  assert.equal(
    result.content,
    source.replace(
      '![Actual](Problems/Figure.svg)',
      '![Actual](Problems/figures/Figure.svg)',
    ),
  )
})

test('links only resolve known project files and preserve URL query and fragments', () => {
  const source = [
    '[root](/Problems/Figure.svg#part)',
    '[worker](/workspace/Problems/Figure.svg?raw=1#part)',
    '[external](https://example.com/Problems/Figure.svg)',
    '[remote](//example.com/Problems/Figure.svg)',
    '[near](Problems/Figure.svg.bak)',
    '[outside](../../Problems/Figure.svg)',
    '[broken](Problems/Figure%ZZ.svg)',
    '[null](Problems/Figure.svg%00)',
    '[anchor](#Problems/Figure.svg)',
  ].join('\n')
  const result = createReferenceRewriter(figureMove)(source, 'README.md')
  assert.equal(result.count, 2)
  assert.equal(
    result.content,
    source
      .replace(
        '[root](/Problems/Figure.svg#part)',
        '[root](/Problems/figures/Figure.svg#part)',
      )
      .replace(
        '[worker](/workspace/Problems/Figure.svg?raw=1#part)',
        '[worker](/workspace/Problems/figures/Figure.svg?raw=1#part)',
      ),
  )
})

test('URL encoded paths and raw angle destinations preserve the referenced filenames', () => {
  const move = {
    from: 'Old/My Figure.svg',
    to: 'New/My New Figure.svg',
    files: ['Old/My Figure.svg'],
  }
  const source = '[encoded](Old/My%20Figure.svg) [angle](<Old/My Figure.svg>)'
  const result = createReferenceRewriter(move)(source, 'README.md')
  assert.equal(result.count, 2)
  assert.equal(
    result.content,
    '[encoded](New/My%20New%20Figure.svg) [angle](<New/My New Figure.svg>)',
  )
})

test('Markdown destinations support balanced parentheses and nested image labels', () => {
  const move = {
    from: 'plot(1).svg',
    to: 'figures/plot(1).svg',
    files: ['plot(1).svg'],
  }
  const result = createReferenceRewriter(move)(
    '[![Plot](plot(1).svg)](plot(1).svg)',
    'README.md',
  )
  assert.equal(result.count, 2)
  assert.equal(
    result.content,
    '[![Plot](figures/plot%281%29.svg)](figures/plot%281%29.svg)',
  )
})

test('moving a document rebases outgoing links and moving a folder keeps internal links short', () => {
  const files = [
    'Notes/Main.md',
    'Figures/a.svg',
    'Notes/child.md',
    'README.md',
  ]
  const rewrite = createReferenceRewriter({
    from: 'Notes',
    to: 'Archive/Notes',
    files,
  })
  const result = rewrite(
    '[image](../Figures/a.svg) [child](child.md)',
    'Notes/Main.md',
  )
  assert.equal(result.count, 1)
  assert.equal(result.content, '[image](../../Figures/a.svg) [child](child.md)')
  assert.deepEqual(rewrite('[child](Notes/child.md)', 'README.md'), {
    content: '[child](Archive/Notes/child.md)',
    count: 1,
  })
})

test('only actual Lean imports are rewritten including multiple imports and quoted module segments', () => {
  const move = {
    from: 'Examples',
    to: 'Archive/New Examples',
    files: [
      'Examples/Proof.lean',
      'Examples/With Space.lean',
      'ExamplesExtra.lean',
    ],
  }
  const source = [
    'import Examples.Proof Examples.«With Space» ExamplesExtra',
    'public import Examples.Proof -- Examples.Proof in a comment',
    '-- import Examples.Proof',
    '/-\nimport Examples.Proof\n-/',
    'def text := "import Examples.Proof"',
    'def multiline := "first\nimport Examples.Proof\nlast"',
  ].join('\n')
  const result = createReferenceRewriter(move)(source, 'Main.lean')
  assert.equal(result.count, 3)
  assert.match(
    result.content,
    /^import Archive.«New Examples».Proof Archive.«New Examples».«With Space» ExamplesExtra/,
  )
  assert.match(
    result.content,
    /public import Archive.«New Examples».Proof -- Examples.Proof in a comment/,
  )
  assert.match(result.content, /-- import Examples.Proof/)
  assert.match(result.content, /def text := "import Examples.Proof"/)
  assert.match(
    result.content,
    /def multiline := "first\nimport Examples.Proof\nlast"/,
  )
})

test('Lean string interpolation cannot create fake comments or imports', () => {
  const source = [
    'def text := s!"{ "inner" } /- ![Wrong](Figure.svg) -/"',
    'def nested := s!"{ s!"{ "inner" } -- ![Wrong](Figure.svg)" }"',
    'def braces := s!"{{ /- ![Wrong](Figure.svg) -/ }}"',
    '-- ![Right](Figure.svg)',
  ].join('\n')
  const result = createReferenceRewriter(figureMove)(
    source,
    'Problems/Main.lean',
  )
  assert.equal(result.count, 1)
  assert.equal(
    result.content,
    source.replace('![Right](Figure.svg)', '![Right](figures/Figure.svg)'),
  )
})

test('TeX commands update figures, inputs and bibliography paths with optional and omitted extensions', () => {
  const move = {
    from: 'assets',
    to: 'shared/assets',
    files: ['assets/figure.svg', 'assets/chapter.tex', 'assets/refs.bib'],
  }
  const source = String.raw`\includegraphics[width=.5\textwidth]{assets/figure.svg}
\includegraphics*{assets/figure}
\input{assets/chapter}
\include{assets/chapter.tex}
\bibliography{ assets/refs, external }
\addbibresource[location=local]{assets/refs.bib}`
  const result = createReferenceRewriter(move)(source, 'main.tex')
  assert.equal(result.count, 6)
  assert.equal(result.content, source.replaceAll('assets/', 'shared/assets/'))
})

test('TeX examples, comments, dynamic paths and ambiguous lookups stay unchanged', () => {
  const move = {
    from: 'assets',
    to: 'shared/assets',
    files: ['assets/figure.svg', 'chapters/assets/figure.svg'],
  }
  const source = String.raw`% \includegraphics{assets/figure.svg}
\verb|\includegraphics{assets/figure.svg}|
\begin{verbatim}
\includegraphics{assets/figure.svg}
\end{verbatim}
\includegraphics{\figures/figure.svg}
\includegraphics{assets/figure.svg}`
  assert.deepEqual(createReferenceRewriter(move)(source, 'chapters/main.tex'), {
    content: source,
    count: 0,
    skipped: true,
  })
})

test('TeX relative links inside a moved document are rebased where the known target is unambiguous', () => {
  const move = {
    from: 'chapters',
    to: 'book/chapters',
    files: ['chapters/main.tex', 'figures/plot.pdf', 'chapters/part.tex'],
  }
  const source = String.raw`\includegraphics{../figures/plot}\input{part}`
  assert.deepEqual(createReferenceRewriter(move)(source, 'chapters/main.tex'), {
    content: String.raw`\includegraphics{../../figures/plot}\input{part}`,
    count: 1,
  })
})

test('unsupported file types and unknown references remain byte identical', () => {
  const source = '![Figure](Problems/Figure.svg)'
  assert.deepEqual(
    rewriteProjectReferences(source, { ...figureMove, filename: 'notes.txt' }),
    { content: source, count: 0 },
  )
  assert.deepEqual(
    createReferenceRewriter(figureMove)('[missing](missing.svg)', 'README.md'),
    { content: '[missing](missing.svg)', count: 0 },
  )
})

test('moving a root TeX document rebases figures and extensionless inputs', () => {
  const rewrite = createReferenceRewriter({
    from: 'main.tex',
    to: 'docs/main.tex',
    files: ['main.tex', 'figures/a.svg', 'sections/a.tex'],
  })
  assert.deepEqual(
    rewrite(
      String.raw`\includegraphics{figures/a.svg}\input{sections/a}`,
      'main.tex',
    ),
    {
      content: String.raw`\includegraphics{../figures/a.svg}\input{../sections/a}`,
      count: 2,
    },
  )
})

test('TeX paths are literals and macro parameters do not become URL suffixes', () => {
  const rewrite = createReferenceRewriter({
    from: 'A.svg',
    to: 'B.svg',
    files: ['A.svg'],
  })
  const source = String.raw`\input{A.svg?missing}\includegraphics{A.svg#1}`
  assert.deepEqual(rewrite(source, 'main.tex'), { content: source, count: 0 })
})

test('raw HTML script, style and preformatted content does not contain Markdown links', () => {
  for (const tag of ['script', 'style', 'pre', 'textarea']) {
    const source = `<${tag}>\nconst label = "[x](Problems/Figure.svg)";\n</${tag}>\n[actual](Problems/Figure.svg)`
    const result = createReferenceRewriter(figureMove)(source, 'README.md')
    assert.equal(result.count, 1)
    assert.equal(
      result.content,
      source.replace(
        '[actual](Problems/Figure.svg)',
        '[actual](Problems/figures/Figure.svg)',
      ),
    )
  }
  const source = '```html\n<script>\n```\n[actual](Problems/Figure.svg)'
  assert.equal(
    createReferenceRewriter(figureMove)(source, 'README.md').count,
    1,
  )
})

test('moving a Lean module to an unsupported module path reports a skipped file', () => {
  const rewrite = createReferenceRewriter({
    from: 'Examples/Proof.lean',
    to: 'Proof.txt',
    files: ['Examples/Proof.lean'],
  })
  assert.deepEqual(rewrite('import Examples.Proof\n', 'Main.lean'), {
    content: 'import Examples.Proof\n',
    count: 0,
    skipped: true,
  })
})

test('malformed link and TeX option runs skip the file without repeated rescans', () => {
  for (const [filename, source] of [
    ['README.md', '[]('.repeat(12000)],
    ['main.tex', String.raw`\input[`.repeat(10000)],
  ]) {
    assert.deepEqual(createReferenceRewriter(figureMove)(source, filename), {
      content: source,
      count: 0,
      skipped: true,
    })
  }
})

test('unmatched backtick lengths do not hide a following real Markdown reference', () => {
  let source = ''
  for (let length = 1; length <= 1000; length++)
    source += 'x ' + '`'.repeat(length) + ' prose\n'
  source += '[actual](Problems/Figure.svg)'
  const result = createReferenceRewriter(figureMove)(source, 'README.md')
  assert.equal(result.count, 1)
  assert.equal(
    result.content,
    source.replace(
      '[actual](Problems/Figure.svg)',
      '[actual](Problems/figures/Figure.svg)',
    ),
  )
})

test('new percent and delimiter characters stay encoded as part of Markdown filenames', () => {
  const rewrite = createReferenceRewriter({
    from: 'a.svg',
    to: '100%done(1)#2.svg',
    files: ['a.svg'],
  })
  assert.deepEqual(rewrite('[a](a.svg)', 'README.md'), {
    content: '[a](100%25done%281%29%232.svg)',
    count: 1,
  })
})
