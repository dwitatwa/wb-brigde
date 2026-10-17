import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureChannelFailure, channelFailurePath, type ChannelFailureRecord } from '../src/standalone/failure-capture.ts'

/**
 * The capture exists because a channel refusal cannot be reproduced on demand:
 * the gateway rejects request shapes that a hand-written probe does not send,
 * and the block can be per-request or clustered in bursts. So the bridge
 * records the failing exchange itself, and these tests pin what is recorded and
 * — just as important — what is not.
 */

const BLOCK = JSON.stringify({
  code: 11128,
  msg: 'conversation id missing',
  displayMsg: { zh: '请求被拦截，请重新发送' },
})

const BODY = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  stream: true,
  messages: [{ role: 'system', content: 'agent' }, { role: 'user', content: 'hi' }],
})

const previousHome = process.env['WORKBUDDY_BRIDGE_HOME']
let home: string | undefined

afterEach(async () => {
  if (previousHome === undefined) delete process.env['WORKBUDDY_BRIDGE_HOME']
  else process.env['WORKBUDDY_BRIDGE_HOME'] = previousHome
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true })
    home = undefined
  }
})

async function useTempHome(): Promise<void> {
  home = await mkdtemp(join(tmpdir(), 'wb-capture-'))
  process.env['WORKBUDDY_BRIDGE_HOME'] = home
}

async function readRecord(): Promise<ChannelFailureRecord> {
  return JSON.parse(await readFile(channelFailurePath(), 'utf8')) as ChannelFailureRecord
}

describe('channel failure capture', () => {
  it('records the body the agent sent and the upstream envelope', async () => {
    await useTempHome()
    await captureChannelFailure('workbuddy-ai', BODY, {
      ok: false,
      status: 400,
      kind: 'client',
      message: BLOCK,
      channelHeaders: { 'X-Conversation-ID': 'conv-1', 'X-Agent-Purpose': 'conversation' },
    })

    const record = await readRecord()
    expect(record.provider).toBe('workbuddy-ai')
    expect(record.model).toBe('deepseek-v4.1-flash')
    expect(record.upstreamStatus).toBe(400)
    expect(record.upstreamBody).toBe(BLOCK)
    expect(record.requestBody).toBe(BODY)
    // The identity the check judges, so "wrong identity" and "no identity"
    // can be told apart after the fact.
    expect(record.channelHeaders['X-Conversation-ID']).toBe('conv-1')
    // A timestamp the reporter can line up with their own logs.
    expect(Number.isNaN(Date.parse(record.at))).toBe(false)
  })

  it('records an empty header set when the failure happened before any request', async () => {
    await useTempHome()
    await captureChannelFailure('workbuddy-ai', BODY, { ok: false, status: 400, kind: 'client', message: BLOCK })
    const record = await readRecord()
    expect(record.channelHeaders).toEqual({})
  })

  it('keeps the body even when it is not valid JSON', async () => {
    await useTempHome()
    await captureChannelFailure('workbuddy-ai', 'not json at all', { ok: false, status: 400, kind: 'client', message: BLOCK })
    const record = await readRecord()
    expect(record.requestBody).toBe('not json at all')
    expect(record.model).toBe('(unknown)')
  })

  it('records nothing for a successful turn', async () => {
    await useTempHome()
    const response = new Response('data: [DONE]\n\n')
    await captureChannelFailure('workbuddy-ai', BODY, { ok: true, response })
    await expect(readFile(channelFailurePath(), 'utf8')).rejects.toThrow()
  })

  it('records nothing for a failure that is not the channel block', async () => {
    await useTempHome()
    await captureChannelFailure('workbuddy-ai', BODY, {
      ok: false,
      status: 400,
      kind: 'client',
      message: JSON.stringify({ code: 11102, msg: '当前模型不可用，请切换模型' }),
    })
    await expect(readFile(channelFailurePath(), 'utf8')).rejects.toThrow()
  })
})
