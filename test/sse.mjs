import { SseParser, applyChunk, finishedToolCalls, newStreamState, mergeReasoningDetails } from '../out/test/sse.mjs'

let pass = 0, fail = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
  ok ? pass++ : fail++
}
const j = (o) => JSON.stringify(o)
const chunk = (delta, extra = {}) => j({ id: 'x', model: 'a/b', choices: [{ delta, finish_reason: null }], ...extra })

console.log('-- framing --')
{
  const p = new SseParser()
  const whole = `data: ${chunk({ content: 'hel' })}\n\ndata: ${chunk({ content: 'lo' })}\n\n`
  const cutAt = whole.indexOf('"content":"hel') + 12
  const a = p.push(whole.slice(0, cutAt))
  const b = p.push(whole.slice(cutAt))
  check('a frame split inside its JSON waits for the rest', a.length === 0 && b.length === 2, j([a, b]))
}
{
  const p = new SseParser()
  const got = p.push(`: OPENROUTER PROCESSING\n\ndata: ${chunk({ content: 'x' })}\n\n: keepalive\ndata: ${chunk({ content: 'y' })}\n\n`)
  check('keepalive comments are dropped, before and inside a frame', got.length === 2 && JSON.parse(got[1]).choices[0].delta.content === 'y', j(got))
}
{
  const p = new SseParser()
  const got = p.push(`data:${chunk({ content: 'a' })}\r\n\r\ndata: ${chunk({ content: 'b' })}\r\n\r\n`)
  check('CRLF frames and data: without a space both parse', got.length === 2, j(got))
}
{
  const p = new SseParser()
  const got = p.push('data: {"a":\ndata: 1}\n\n')
  check("a frame's several data lines join with a newline", got.length === 1 && JSON.parse(got[0]).a === 1, j(got))
}
{
  const p = new SseParser()
  const first = p.push(`data: ${chunk({ content: 'a' })}\n\ndata: ${chunk({}, { usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } })}`)
  const rest = p.flush()
  check('a last frame with no blank line after it is not lost', first.length === 1 && rest.length === 1 && JSON.parse(rest[0]).usage.cost === 0.001, j([first, rest]))
  check('flushing twice yields nothing', p.flush().length === 0)
}
{
  const p = new SseParser()
  check('[DONE] and an error body pass through as payloads for the caller', p.push('data: [DONE]\n\ndata: {"error":{"code":502}}\n\n').join('|') === '[DONE]|{"error":{"code":502}}')
}

console.log('\n-- reduction --')
{
  const s = newStreamState()
  const a1 = applyChunk(s, JSON.parse(chunk({ content: 'hel', reasoning: 'hm' })))
  const a2 = applyChunk(s, JSON.parse(chunk({ content: 'lo' }, { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] })))
  check('text and reasoning accumulate and are returned as they arrive', s.content === 'hello' && s.reasoning === 'hm' && a1.content === 'hel' && a2.content === 'lo' && a1.reasoning === 'hm' && a2.reasoning === '')
  check('the finish reason and the serving model are kept', s.finishReason === 'stop' && s.servedBy === 'a/b')
  applyChunk(s, JSON.parse(chunk({}, { usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 }, cost: 0.002 } })))
  check('usage is read whole', j(s.usage) === j({ promptTokens: 10, completionTokens: 3, cachedTokens: 4, cacheWriteTokens: null, reasoningTokens: 1, cost: 0.002 }), j(s.usage))
}
{
  const s = newStreamState()
  applyChunk(s, JSON.parse(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] })))
  applyChunk(s, JSON.parse(chunk({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_dir', arguments: '{}' } }] })))
  applyChunk(s, JSON.parse(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] })))
  const calls = finishedToolCalls(s)
  check('fragments by index are joined into their own calls, in order', calls.length === 2 && calls[0].id === 'c1' && calls[0].arguments === '{"path":"a"}' && calls[1].name === 'list_dir', j(calls))
}
{
  const s = newStreamState()
  applyChunk(s, JSON.parse(chunk({ tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] })))
  applyChunk(s, JSON.parse(chunk({ tool_calls: [{ id: 'c2', function: { name: 'read_file', arguments: '{"path":"b"}' } }] })))
  const calls = finishedToolCalls(s)
  check('whole calls that name no index get a slot each rather than one string', calls.length === 2 && calls[0].arguments === '{"path":"a"}' && calls[1].arguments === '{"path":"b"}', j(calls))
}
{
  const s = newStreamState()
  applyChunk(s, JSON.parse(chunk({ tool_calls: [{ index: 0, function: { arguments: '{' } }] })))
  check('a fragment that never got a name is not a call', finishedToolCalls(s).length === 0)
}
{
  const s = newStreamState()
  applyChunk(s, JSON.parse(chunk({ content: 'see', annotations: [{ type: 'url_citation', url_citation: { url: 'https://x', title: 'X', content: 'body' } }] })))
  applyChunk(s, JSON.parse(chunk({ content: '!', annotations: [{ type: 'url_citation', url_citation: { url: 'https://x', title: 'X', content: 'body' } }] })))
  check('a citation is kept once, by url', s.citations.size === 1 && s.citations.get('https://x').excerpt === 'body')
}
{
  const s = newStreamState()
  applyChunk(s, JSON.parse(chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'a', index: 0 }] })))
  applyChunk(s, JSON.parse(chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'b', index: 0, signature: 's' }] })))
  check('reasoning blocks merge on their index', s.reasoningDetails.length === 1 && s.reasoningDetails[0].text === 'ab' && s.reasoningDetails[0].signature === 's')
  check('the merge is the same function the client exports', typeof mergeReasoningDetails === 'function')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
