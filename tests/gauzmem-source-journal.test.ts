import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GauzMemSourceJournal } from '../src/gauzmem/source-journal';
import { GauzMemFiles } from '../src/gauzmem/paths';
import type { RunResult } from '../src/core/conversation-runner';

describe('GauzMemSourceJournal', () => {
  let oldCwd: string;
  let tmp: string;

  beforeEach(() => {
    oldCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gauzmem-source-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(oldCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('appends complete turn source records and deduplicates by sourceId', () => {
    const journal = new GauzMemSourceJournal();
    const result: RunResult = {
      response: 'Lady Blackbird agrees to negotiate with Cyrus.',
      finalResponseVisible: true,
      newMessages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"brief.md"}' },
          }],
        },
        {
          role: 'tool',
          name: 'read_file',
          tool_call_id: 'call-1',
          content: 'Cyrus is a smuggler captain.',
        },
      ],
      messages: [],
    };

    const first = journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-1',
      userInput: 'Continue the Lady Blackbird scene.',
      result,
    });
    const second = journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-1',
      userInput: 'Continue the Lady Blackbird scene.',
      result,
    });

    assert.equal(first.length, 3);
    assert.equal(second.length, 0);
    const all = journal.readAll();
    assert.equal(all.length, 3);
    assert.equal(all.some(record => record.role === 'tool' && record.text.includes('Cyrus is a smuggler')), true);
    assert.equal(all.some(record => record.role === 'tool' && record.text.includes('Arguments:')), false);
    assert.equal(all.some(record => record.blockType === 'tool_result'), true);
  });

  test('writes source journal outside graph store so graph resets do not remove it', () => {
    const journal = new GauzMemSourceJournal();
    journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-source-path',
      userInput: 'Lady Blackbird source survives graph reset.',
      result: {
        response: '',
        finalResponseVisible: true,
        newMessages: [],
        messages: [],
      },
    });

    assert.match(GauzMemFiles.sources(), /data[\\/]session-memory[\\/]gauzmem[\\/]session_messages\.jsonl$/);
    assert.match(GauzMemFiles.nodes(), /data[\\/]gauzmem[\\/]store[\\/]nodes\.jsonl$/);
    fs.rmSync(path.dirname(GauzMemFiles.nodes()), { recursive: true, force: true });
    assert.equal(journal.readAll().length, 1);
  });

  test('builds source windows inside one source block with max length', () => {
    const journal = new GauzMemSourceJournal();
    journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-2',
      userInput: [
        '前文铺垫很长很长很长很长很长很长很长很长很长很长',
        'Cyrus 发现灰鸦留下的暗号，决定改走码头密道。',
        '后文补充很长很长很长很长很长很长很长很长很长很长',
      ].join('\n'),
      result: {
        response: '',
        finalResponseVisible: true,
        newMessages: [],
        messages: [],
      },
    });

    const windows = journal.searchWindows(['灰鸦'], 4, 40);

    assert.equal(windows.length, 1);
    assert.ok(windows[0].text.includes('灰鸦'));
    assert.ok(windows[0].text.length <= 40);
    assert.deepEqual(windows[0].matchedTerms, ['灰鸦']);
    assert.equal(windows[0].distinctTermCount, 1);
  });

  test('orders source windows by distinct term count and term priority', () => {
    const journal = new GauzMemSourceJournal();
    journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-3a',
      userInput: 'later only Kale appears here',
      result: {
        response: '',
        finalResponseVisible: true,
        newMessages: [],
        messages: [],
      },
    });
    journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-3b',
      userInput: 'earlier Cyrus and Kale coordinate a route',
      result: {
        response: '',
        finalResponseVisible: true,
        newMessages: [],
        messages: [],
      },
    });
    journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-3c',
      userInput: 'middle Cyrus waits alone',
      result: {
        response: '',
        finalResponseVisible: true,
        newMessages: [],
        messages: [],
      },
    });

    const windows = journal.searchWindows(['Cyrus', 'Kale'], 3, 500);

    assert.equal(windows.length, 3);
    assert.equal(windows[0].distinctTermCount, 2);
    assert.deepEqual(windows[0].matchedTerms, ['Cyrus', 'Kale']);
    assert.equal(windows[1].matchedTerms[0], 'Cyrus');
    assert.equal(windows[2].matchedTerms[0], 'Kale');
  });

  test('merges nearby multi-term hits into one source window per block region', () => {
    const journal = new GauzMemSourceJournal();
    journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-multi-term',
      userInput: [
        'prefix '.repeat(30),
        'Cyrus studies Zero-Protocol while Blackbird waits near the Seventh Ship.',
        'suffix '.repeat(30),
      ].join(' '),
      result: {
        response: '',
        finalResponseVisible: true,
        newMessages: [],
        messages: [],
      },
    });

    const windows = journal.searchWindows(['Cyrus', 'Zero-Protocol', 'Blackbird'], 10, 240);

    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0].matchedTerms, ['Cyrus', 'Zero-Protocol', 'Blackbird']);
  });

  test('does not cross user assistant and tool result blocks when building windows', () => {
    const journal = new GauzMemSourceJournal();
    journal.appendTurn({
      sessionKey: 'session-a',
      sessionType: 'catscompany',
      turnId: 'turn-blocks',
      userInput: 'Cyrus asks about the map.',
      result: {
        response: 'Cyrus receives a separate answer.',
        finalResponseVisible: true,
        newMessages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"file_path":"map.md"}' },
            }],
          },
          {
            role: 'tool',
            name: 'read_file',
            tool_call_id: 'call-1',
            content: 'Cyrus sees a third source block.',
          },
        ],
        messages: [],
      },
    });

    const windows = journal.searchWindows(['Cyrus'], 10, 500);

    assert.equal(windows.length, 3);
    assert.deepEqual(
      windows.map(window => window.blockType).sort(),
      ['assistant_text', 'tool_result', 'user_text'],
    );
    assert.equal(windows.some(window => window.text.includes('file_path')), false);
  });
});
