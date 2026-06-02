import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GauzMemSourceJournal } from '../src/gauzmem/source-journal';
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
  });
});
