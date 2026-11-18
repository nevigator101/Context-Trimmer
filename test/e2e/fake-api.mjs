// Fake Anthropic Messages API for headless Claude Code experiments. No model call, no quota.
//
// Point ANTHROPIC_BASE_URL at it. Each /v1/messages request is recorded. The reply is scripted from the last
// user turn:
//   - last block is a tool_result                     -> text "ok", end_turn
//   - user text contains  CALL <Tool> <json-input>     -> tool_use of <Tool> with that input
//   - a skill body contains  CTXCALL <Tool> <json>     -> same (lets a skill's own text drive the call)
//   - text naming  node "<...>/dist/ctx.mjs" <sub>   -> Bash tool_use running it (ctx skill bodies)
//   - anything else                                   -> text "ok", end_turn
import http from 'node:http';

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function lastUserText(body) {
  const msgs = body.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    return blocks;
  }
  return [];
}

function decide(body) {
  const blocks = lastUserText(body);
  if (blocks.length && blocks[blocks.length - 1].type === 'tool_result') return { text: 'ok' };
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = text.match(/(?:CALL|CTXCALL) (\w+) (\{.*\})/);
  if (m) return { tool: m[1], input: JSON.parse(m[2]) };
  // A ctx skill body: run the command it names, as Claude would.
  const c = text.match(/node "([^"]+\/dist\/ctx\.mjs)" (\w[\w -]*)/);
  if (c) return { tool: 'Bash', input: { command: `node "${c[1]}" ${c[2].trim()}`, description: 'Run ctx' } };
  return { text: 'ok' };
}

export function startFakeApi() {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (!req.url.includes('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"fake"}}');
        return;
      }
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      requests.push(body);
      const d = decide(body);
      const id = `msg_fake_${++n}`;
      const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const content = d.tool
        ? [{ type: 'tool_use', id: `toolu_fake_${n}`, name: d.tool, input: d.input }]
        : [{ type: 'text', text: d.text }];
      const stop = d.tool ? 'tool_use' : 'end_turn';
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage }));
        return;
      }
      const block0 = d.tool ? { type: 'tool_use', id: content[0].id, name: d.tool, input: {} } : { type: 'text', text: '' };
      const delta = d.tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(d.input) }
        : { type: 'text_delta', text: d.text };
      sse(res, [
        { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: 'content_block_start', index: 0, content_block: block0 },
        { type: 'content_block_delta', index: 0, delta },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close(),
  })));
}

/** Facts about one captured request. */
export function inspect(body) {
  const s = JSON.stringify(body.messages ?? []);
  const toolResults = [];
  for (const m of body.messages ?? []) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('');
        toolResults.push({ is_error: !!b.is_error, content: c.slice(0, 300) });
      }
    }
  }
  return {
    tools: (body.tools ?? []).filter((t) => !t.defer_loading).map((t) => t.name),
    deferredTools: (body.tools ?? []).filter((t) => t.defer_loading).map((t) => t.name),
    has: (needle) => s.includes(needle),
    toolResults,
    messagesJson: s,
  };
}
