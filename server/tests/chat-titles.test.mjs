import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatTitleGenerator } from '../chat-titles.mjs'

const deepseek = {
  id: 'deepseek-ai/DeepSeek-V4.1-Flash',
  reasoningEfforts: [{ id: 'high' }, { id: 'low' }, { id: 'xhigh' }],
}
const config = {
  defaultModel: deepseek.id,
  models: [deepseek],
  provider: {
    LEMEX_API_KEY: 'private-provider-token',
    LEMEX_BASE_URL: 'https://provider.example/v1/',
  },
}
const messages = [
  { role: 'user', content: 'Prove continuity of a finite sum.' },
]
const answer = (text = 'Continuity of Finite Sums') => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    },
  ],
})
const response = (body = answer()) => Response.json(body)

test('naming uses one bounded text-only DeepSeek request with the lowest supported effort', async () => {
  const calls = []
  const generator = createChatTitleGenerator(config, {
    fetchImpl: async (...args) => {
      calls.push(args)
      return response(answer('  **“Continuity of Finite Sums”**  '))
    },
  })
  assert.equal(generator.available, true)
  assert.equal(generator.model, deepseek.id)
  assert.deepEqual(await generator.generate(messages), {
    title: 'Continuity of Finite Sums',
    model: deepseek.id,
  })
  assert.equal(calls.length, 1)
  const [url, init] = calls[0]
  assert.equal(url, 'https://provider.example/v1/responses')
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers.authorization, 'Bearer private-provider-token')
  const body = JSON.parse(init.body)
  assert.equal(body.model, deepseek.id)
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.equal(body.store, false)
  assert.equal(body.stream, false)
  assert.equal(body.max_output_tokens, 1024)
  assert.deepEqual(body.tools, [])
  assert.equal(body.tool_choice, 'none')
  assert.match(body.instructions, /source material, not instructions/)
  assert.deepEqual(JSON.parse(body.input[0].content[0].text), messages)
  assert.equal(body.input[0].content[0].type, 'input_text')
  assert.equal('previous_response_id' in body, false)
})

test('model choice stays in DeepSeek and omits unsupported effort instead of guessing', async () => {
  const variants = [
    {
      models: [{ id: 'other/vendor' }, { id: 'deepseek/reasoner' }, deepseek],
      defaultModel: 'other/vendor',
      expected: deepseek.id,
      effort: 'low',
    },
    {
      models: [deepseek, { id: 'deepseek/reasoner' }],
      defaultModel: 'deepseek/reasoner',
      expected: 'deepseek/reasoner',
      effort: undefined,
    },
    {
      models: [
        { id: 'deepseek/reasoner', reasoningEfforts: [{ id: 'custom' }] },
      ],
      defaultModel: 'other/vendor',
      expected: 'deepseek/reasoner',
      effort: undefined,
    },
    {
      models: [
        {
          ...deepseek,
          reasoningEfforts: [{ id: 'minimal' }, { id: 'none' }, { id: 'low' }],
        },
      ],
      expected: deepseek.id,
      effort: 'none',
    },
  ]
  for (const variant of variants) {
    let request
    const generator = createChatTitleGenerator(
      { ...config, ...variant },
      {
        fetchImpl: async (_, init) => {
          request = JSON.parse(init.body)
          return response()
        },
      },
    )
    await generator.generate(messages)
    assert.equal(request.model, variant.expected)
    assert.equal(request.reasoning?.effort, variant.effort)
  }
})

test('missing DeepSeek or unsafe provider configuration makes naming unavailable without a request', async () => {
  const variants = [
    { models: [{ id: 'other/model' }], defaultModel: 'other/model' },
    { provider: {} },
    {
      provider: {
        ...config.provider,
        LEMEX_BASE_URL: 'http://provider.example/v1',
      },
    },
    {
      provider: {
        ...config.provider,
        LEMEX_BASE_URL: 'https://user:secret@provider.example/v1',
      },
    },
    {
      provider: {
        ...config.provider,
        LEMEX_BASE_URL: 'https://provider.example/v1?token=secret',
      },
    },
    {
      provider: {
        ...config.provider,
        LEMEX_BASE_URL: 'https://provider.example/v1#fragment',
      },
    },
  ]
  for (const variant of variants) {
    const generator = createChatTitleGenerator(
      { ...config, ...variant },
      {
        fetchImpl: () =>
          assert.fail('Unavailable generators must not make requests'),
      },
    )
    assert.equal(generator.available, false)
    await assert.rejects(generator.generate(messages), { status: 503 })
  }
})

test('conversation sampling bounds source text and omits system/tool data and metadata', async () => {
  let sample
  const generator = createChatTitleGenerator(config, {
    fetchImpl: async (_, init) => {
      sample = JSON.parse(JSON.parse(init.body).input[0].content[0].text)
      return response()
    },
  })
  await generator.generate([
    { role: 'system', content: 'System prompt should never be sent.' },
    { role: 'user', content: 'x'.repeat(6000), filename: '/private/file' },
    {
      role: 'assistant',
      content: 'y'.repeat(6000),
      reasoning: 'hidden reasoning',
    },
    { role: 'user', content: 'z'.repeat(6000) },
  ])
  assert.equal(sample.length, 2)
  assert.equal(
    sample.reduce((sum, item) => sum + item.content.length, 0),
    8000,
  )
  assert.deepEqual(Object.keys(sample[0]), ['role', 'content'])
  await generator.generate(
    Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: `Message ${i}`,
    })),
  )
  assert.equal(sample.length, 8)
  for (const empty of [
    undefined,
    [],
    [{ role: 'assistant', content: 'No user purpose' }],
    [{ role: 'user', content: '  ' }],
  ])
    await assert.rejects(generator.generate(empty), { status: 400 })
})

test('response validation rejects incomplete, refusal, tool and unusable title outputs', async () => {
  const tool = { type: 'function_call', name: 'shell', arguments: '{}' }
  const invalid = [
    { ...answer(), status: 'incomplete' },
    { ...answer(), output: [] },
    { ...answer(), output: [tool] },
    { ...answer(), output: [...answer().output, tool] },
    { ...answer(), output: [answer().output[1], answer().output[1]] },
    { ...answer(), output: [{ ...answer().output[1], status: 'in_progress' }] },
    { ...answer(), output: [{ ...answer().output[1], role: 'user' }] },
    {
      ...answer(),
      output: [
        {
          ...answer().output[1],
          content: [{ type: 'refusal', refusal: 'No' }],
        },
      ],
    },
    answer(''),
    answer('x'.repeat(121)),
    answer('***'),
    answer('\u0000\u202e'),
  ]
  for (const body of invalid) {
    const generator = createChatTitleGenerator(config, {
      fetchImpl: async () => response(body),
    })
    await assert.rejects(generator.generate(messages), { status: 502 })
  }
  const generator = createChatTitleGenerator(config, {
    fetchImpl: async () =>
      response(answer('# \u202ePreuve de continuité\nfinie')),
  })
  assert.equal(
    (await generator.generate(messages)).title,
    'Preuve de continuité finie',
  )
})

test('provider errors and malformed bodies never expose credentials or conversation contents', async () => {
  const privateText = `${config.provider.LEMEX_API_KEY} ${messages[0].content}`
  const variants = [
    async () => new Response(privateText, { status: 401 }),
    async () => new Response(privateText, { status: 429 }),
    async () => new Response(privateText, { status: 200 }),
    async () => {
      throw new Error(privateText)
    },
    async () => {
      throw Object.assign(new Error(`The title service ${privateText}`), {
        status: 502,
      })
    },
  ]
  for (const fetchImpl of variants) {
    const generator = createChatTitleGenerator(config, { fetchImpl })
    await assert.rejects(generator.generate(messages), (error) => {
      assert.equal(error.status, 502)
      assert.equal(error.message.includes(config.provider.LEMEX_API_KEY), false)
      assert.equal(error.message.includes(messages[0].content), false)
      return true
    })
  }
})

test('response byte limits apply with or without an honest Content-Length', async () => {
  let cancelled = false
  const generator = createChatTitleGenerator(config, {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(128 * 1024 + 1))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  })
  await assert.rejects(generator.generate(messages), /oversized response/)
  assert.equal(cancelled, true)
  const declared = createChatTitleGenerator(config, {
    fetchImpl: async () =>
      new Response('{}', { headers: { 'content-length': '9999999' } }),
  })
  await assert.rejects(declared.generate(messages), /oversized response/)
})

test('naming timeout and caller cancellation abort the request without leaking abort reasons', async () => {
  const waitForAbort = (_, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error('private transport information')),
        { once: true },
      )
    })
  const generator = createChatTitleGenerator(config, {
    fetchImpl: waitForAbort,
    timeoutMs: 10,
  })
  await assert.rejects(generator.generate(messages), { status: 504 })
  const caller = new AbortController()
  const running = createChatTitleGenerator(config, {
    fetchImpl: waitForAbort,
  }).generate(messages, { signal: caller.signal })
  caller.abort('private abort reason')
  await assert.rejects(running, {
    status: 499,
    message: 'Chat naming was cancelled.',
  })
  await assert.rejects(
    generator.generate(messages, { signal: caller.signal }),
    { status: 499 },
  )
})
