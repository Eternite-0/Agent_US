import assert from 'node:assert/strict';
import test from 'node:test';
import { createComposerDraftStore, createThreadInteraction, createThreadInteractionCache } from '../src/utils/threadInteraction.ts';

test('accepting a sent draft does not clear changes made while the request was pending', () => {
  const draft = createComposerDraftStore();
  draft.update('text', 'Send this first');
  const sent = draft.read();
  draft.update('text', 'Keep the new draft');
  draft.update('files', { 'notes.txt': 'bm90ZXM=' });
  assert.equal(draft.clearIfUnchanged(sent), false);
  assert.equal(draft.read().text, 'Keep the new draft');
  assert.deepEqual(draft.read().files, { 'notes.txt': 'bm90ZXM=' });
  assert.equal(draft.clearIfUnchanged(draft.read()), true);
  assert.deepEqual(draft.read(), { text: '', files: {}, mode: null });
});

test('pruning reading state retains unsent drafts and pending attachments', () => {
  const cache = createThreadInteractionCache(3);
  const draft = createThreadInteraction();
  draft.draft.update('text', 'Do not evict this draft');
  cache.visit('draft', draft);
  const attaching = createThreadInteraction();
  const finish = attaching.draft.startFileRead();
  cache.visit('attaching', attaching);
  cache.visit('old', createThreadInteraction());
  cache.visit('active', createThreadInteraction());
  assert.equal(cache.get('old'), undefined);
  assert.equal(cache.get('draft'), draft);
  assert.equal(cache.get('attaching'), attaching);
  finish();
  cache.visit('new', createThreadInteraction());
  assert.equal(cache.get('attaching'), undefined);
  assert.equal(cache.get('draft'), draft);
  cache.delete('draft');
  assert.equal(cache.get('draft'), undefined);
});
