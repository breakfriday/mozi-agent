const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { ToolExecutionCollector } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/tool-execution-collector.ts'));
const { readHistory } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/history-reader.ts'));
const { projectHistory } = load(path.resolve(__dirname, '../../src/agent/sessions/history-projection.ts'));
const { convertAssistantMessage } = load(path.resolve(__dirname, '../../../mozi-app/src/agent/assistantMessage.ts'));
const plain = value => JSON.parse(JSON.stringify(value));
const call = (id, name = 'read') => ({ type: 'toolCall', id, name, arguments: { path: `${id}.txt` } });
const result = text => ({ content: [{ type: 'text', text }] });
const timestamp = '2026-10-17T00:00:00.000Z';

test('parallel tools retain message ownership and replace cumulative updates; terminal results cannot regress', () => {
  const events = [];
  const collector = new ToolExecutionCollector(event => events.push(plain(event)));
  collector.collect({ type: 'message_end', message: { role: 'assistant', content: [
    { type: 'text', text: 'Checking' }, call('a'), call('b'), call('pending'),
  ] } }, 0);
  for (const toolCallId of ['a', 'b', 'pending']) collector.collect({ type: 'tool_execution_start', toolCallId }, 0);
  collector.collect({ type: 'tool_execution_update', toolCallId: 'a', partialResult: result('one') }, 0);
  collector.collect({ type: 'tool_execution_update', toolCallId: 'a', partialResult: result('one\ntwo') }, 0);
  assert.equal(events.at(-1).tool.outputText, 'one\ntwo');
  collector.collect({ type: 'message_end', message: { role: 'assistant', content: [call('c')] } }, 1);
  collector.collect({ type: 'tool_execution_end', toolCallId: 'b', result: result('ENOENT'), isError: true }, 1);
  assert.equal(events.at(-1).ordinal, 0);
  assert.equal(events.at(-1).tool.status, 'failed');
  collector.collect({ type: 'tool_execution_end', toolCallId: 'a', result: result('x'.repeat(100_000)), isError: false }, 1);
  assert.equal(events.at(-1).tool.outputText.length, 32_000);
  assert.equal(events.at(-1).tool.outputTruncated, true);
  const count = events.length;
  collector.collect({ type: 'tool_execution_update', toolCallId: 'a', partialResult: result('late') }, 1);
  assert.equal(events.length, count);
  collector.finish(true);
  const latest = new Map(events.map(event => [event.tool.toolCallId, event.tool]));
  assert.deepEqual([...latest.values()].map(tool => tool.status), ['succeeded', 'failed', 'cancelled', 'cancelled']);
  assert.equal(latest.get('b').partIndex, 2);
  const afterFinish = events.length;
  collector.finish(false);
  assert.equal(events.length, afterFinish);
});

test('native tool-only messages restore results, interrupted calls and stable UI ordering without duplicate transcript storage', () => {
  const entries = [
    { type: 'custom', customType: 'mozi.run', data: { runId: 'r' } },
    { type: 'message', id: 'u', timestamp, message: { role: 'user', content: 'Read files' } },
    { type: 'message', id: 'a', timestamp, message: { role: 'assistant', stopReason: 'toolUse', content: [call('ok'), call('missing'), call('crash')] } },
    { type: 'message', id: 't1', timestamp, message: { role: 'toolResult', toolCallId: 'ok', isError: false, ...result('source code') } },
    { type: 'message', id: 't2', timestamp, message: { role: 'toolResult', toolCallId: 'missing', isError: true, ...result('ENOENT') } },
  ];
  const before = structuredClone(entries);
  const history = readHistory(entries);
  assert.equal(history.length, 2);
  assert.deepEqual(plain(history[1].tools.map(tool => tool.status)), ['succeeded', 'failed', 'interrupted']);
  assert.deepEqual(entries, before);
  const metadata = { descriptor: { engine: 'pi', sessionId: 's' }, session: { sessionId: 's' } };
  const details = { runs: [{ run: { id: 'r', status: 'cancelled', updatedAt: timestamp } }], links: [
    { messageId: 'app-a', nativeEntryId: 'a', runId: 'r', role: 'assistant', ordinal: 0 },
  ] };
  const { seed } = projectHistory(metadata, details, history);
  assert.deepEqual(plain(seed.snapshot.tools.map(tool => tool.status)), ['succeeded', 'failed', 'cancelled']);
  assert.ok(seed.snapshot.tools.every(tool => tool.messageId === 'app-a'));
  const message = { ...seed.snapshot.messages[1], id: 'message:app-a' };
  const view = convertAssistantMessage(message, seed.snapshot.tools);
  assert.deepEqual(plain(view.content.map(part => part.type)), ['tool-call', 'tool-call', 'tool-call']);
  assert.equal(view.content[1].result, 'ENOENT');
  assert.equal(view.content[1].isError, true);
  assert.equal(view.content[2].isPreliminary, false);
  // An imported native session without Mozi metadata still has visible tools.
  assert.equal(projectHistory(metadata, { runs: [], links: [] }, history).seed.snapshot.tools.length, 3);
});

test('UI conversion interleaves tools and text and treats empty successful results as settled', () => {
  const message = { id: 'message:a', role: 'assistant', status: 'completed', content: [
    { id: 'a:text:0', type: 'text', text: 'before' }, { id: 'a:text:2', type: 'text', text: 'after' },
  ] };
  const tool = { toolCallId: 'c', messageId: 'a', partIndex: 1, toolName: 'write', inputText: '{}', outputText: '', status: 'running' };
  const streaming = convertAssistantMessage(message, [tool]);
  assert.equal(streaming.status.type, 'running');
  assert.deepEqual(plain(streaming.content.map(part => part.type)), ['text', 'tool-call', 'text']);
  assert.equal(streaming.content[1].isPreliminary, true);
  const final = convertAssistantMessage(message, [{ ...tool, status: 'succeeded' }]);
  assert.equal(final.content[1].result, '');
  assert.equal(final.content[1].isPreliminary, false);
  assert.equal(final.status.type, 'complete');
  assert.equal(convertAssistantMessage({ ...message, id: 'message:other' }, [tool]).content.length, 2);
});
