import assert from 'node:assert/strict'
import test from 'node:test'
import { indexPdfQuotes } from './pdfPaperQuotes.ts'

test('PDF excerpts locate exact offsets across text spans, line breaks and ligatures', () => {
  const find = indexPdfQuotes([
    { str: 'Theorem 1. A ﬁ' },
    { str: 'nite set', hasEOL: true },
    { str: 'has a maximum. Proof.' },
  ])

  assert.deepEqual(find('A finite set\n  has a maximum.'), {
    start: { item: 0, offset: 11 },
    end: { item: 2, offset: 14 },
  })
})

test('PDF excerpts disallow ambiguous matches and fragments inside words', () => {
  const find = indexPdfQuotes([
    { str: 'Theorem 1 and Theorem 10.', hasEOL: true },
    { str: 'Theorem 1.' },
  ])

  assert.equal(find('Theorem 1'), null)
  assert.equal(find('orem 10'), null)
  assert.equal(find('Theorem 2'), null)
  assert.deepEqual(find('Theorem 10'), {
    start: { item: 0, offset: 14 },
    end: { item: 0, offset: 24 },
  })
})

test('PDF excerpt offsets preserve surrogate pairs and canonical accents', () => {
  const find = indexPdfQuotes([{ str: 'Let 𝑥 be at cafe\u0301.' }])

  assert.deepEqual(find('x be at café'), {
    start: { item: 0, offset: 4 },
    end: { item: 0, offset: 18 },
  })
})
