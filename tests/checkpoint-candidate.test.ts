import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import {
  CheckpointCandidate,
  createCheckpointSnapshot,
} from '../src/core/checkpoint-candidate';

function user(content: string): Message {
  return { role: 'user', content };
}

test('snapshot is an immutable copy of the parent boundary', () => {
  const messages = [user('root'), user('before branch')];
  const snapshot = createCheckpointSnapshot(messages, { revision: 4, episodeId: 'episode-1', startedAt: 10 });

  messages.push(user('after branch'));
  messages[0].content = 'mutated parent';

  assert.equal(snapshot.boundaryMessageCount, 2);
  assert.equal(snapshot.messages[0].content, 'root');
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.startedAt, 10);
});

test('snapshot freezes nested message structures', () => {
  const messages: Message[] = [{
    role: 'user',
    content: [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    }],
  }];
  const snapshot = createCheckpointSnapshot(messages, { revision: 1 });

  (snapshot.messages[0].content as any)[0].source.data = 'changed';
  assert.equal((snapshot.messages[0].content as any)[0].source.data, 'abc');
});

test('candidate generates through the coordinator without mutating the snapshot', async () => {
  const source = [user('root')];
  const candidate = new CheckpointCandidate('candidate-generate', createCheckpointSnapshot(source, {
    revision: 1,
    episodeId: 'episode-1',
  }));
  let requestMessages: Message[] | undefined;
  const coordinator = {
    compactIfNeeded: async (messages: Message[], request: any) => {
      requestMessages = messages;
      assert.equal(request.phase, 'mid_turn');
      messages.push(user('coordinator-local-copy'));
      return { messages: [user('summary')], compacted: true };
    },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
  }), true);
  assert.equal(candidate.status, 'ready');
  assert.deepEqual(candidate.result?.map(message => message.content), ['summary']);
  assert.deepEqual(requestMessages?.map(message => message.content), ['root', 'coordinator-local-copy']);
  assert.deepEqual(candidate.snapshot.messages.map(message => message.content), ['root']);
});

test('candidate generation failure enters failed state', async () => {
  const candidate = new CheckpointCandidate('candidate-failed', createCheckpointSnapshot([user('root')], {
    revision: 1,
  }));
  const coordinator = {
    compactIfNeeded: async () => { throw new Error('provider unavailable'); },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
  }), false);
  assert.equal(candidate.status, 'failed');
});

test('ready candidate commits when revision and boundary still match', () => {
  const messages = [user('root'), user('before branch')];
  const candidate = new CheckpointCandidate(
    'candidate-1',
    createCheckpointSnapshot(messages, { revision: 4, episodeId: 'episode-1' }),
  );
  assert.equal(candidate.complete([user('summary'), user('after branch')]), true);

  const result = candidate.tryCommit(
    [...messages, user('after branch')],
    4,
    'episode-1',
  );

  assert.equal(result.status, 'committed');
  assert.deepEqual(result.messages?.map(message => message.content), ['summary', 'after branch']);
});

test('candidate becomes stale when parent revision changes', () => {
  const messages = [user('root')];
  const candidate = new CheckpointCandidate('candidate-2', createCheckpointSnapshot(messages, {
    revision: 1,
    episodeId: 'episode-1',
  }));
  candidate.complete([user('summary')]);

  const result = candidate.tryCommit([...messages, user('new message')], 2, 'episode-1');

  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'revision_mismatch');
});

test('candidate becomes stale when snapshot prefix changes', () => {
  const candidate = new CheckpointCandidate('candidate-3', createCheckpointSnapshot(
    [user('root'), user('stable')],
    { revision: 1, episodeId: 'episode-1' },
  ));
  candidate.complete([user('summary')]);

  const result = candidate.tryCommit([user('root'), user('changed')], 1, 'episode-1');

  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'boundary_mismatch');
});

test('cancelled candidate cannot commit a late result', () => {
  const candidate = new CheckpointCandidate('candidate-4', createCheckpointSnapshot(
    [user('root')],
    { revision: 1, episodeId: 'episode-1' },
  ));
  assert.equal(candidate.cancel(), true);
  assert.equal(candidate.complete([user('late summary')]), false);

  const result = candidate.tryCommit([user('root')], 1, 'episode-1');

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'cancelled');
});

test('episode changes invalidate an otherwise matching revision', () => {
  const messages = [user('root')];
  const candidate = new CheckpointCandidate('candidate-5', createCheckpointSnapshot(messages, {
    revision: 7,
    episodeId: 'episode-1',
  }));
  candidate.complete([user('summary')]);

  const result = candidate.tryCommit(messages, 7, 'episode-2');

  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'episode_mismatch');
});
