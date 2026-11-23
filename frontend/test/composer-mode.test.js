import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposerDraft } from '../src/utils/composerMode.ts';
import { summarizeSwarmRun, swarmAttachmentError } from '../src/utils/swarmCommand.ts';

test('bare mode commands activate a chip and never submit, including whitespace and aliases', () => {
  for (const [text, mode] of [[' /SWARM  ', 'swarm'], ['/plan', 'plan'], ['/goal\n', 'goal'], ['/目标', 'goal']]) {
    assert.deepEqual(resolveComposerDraft(text, null), { kind: 'activate', mode });
    assert.deepEqual(resolveComposerDraft('   ', mode), { kind: 'empty' });
  }
});

test('mode chips route only the next composed task while preserving explicit command syntax', () => {
  assert.deepEqual(resolveComposerDraft('  检查构建\n只读  ', 'swarm'), { kind: 'submit', body: '/swarm 检查构建\n只读' });
  assert.deepEqual(resolveComposerDraft('检查构建', 'plan'), { kind: 'submit', body: '/plan 检查构建' });
  assert.deepEqual(resolveComposerDraft('通过所有测试', 'goal'), { kind: 'goal', body: '通过所有测试' });
  assert.deepEqual(resolveComposerDraft('/swarm status', 'plan'), { kind: 'submit', body: '/swarm status' });
  assert.deepEqual(resolveComposerDraft('/swarm stop', null), { kind: 'submit', body: '/swarm stop' });
  assert.deepEqual(resolveComposerDraft('/plan 仅制定计划', 'swarm'), { kind: 'submit', body: '/plan 仅制定计划' });
  assert.deepEqual(resolveComposerDraft('/目标 重构模块', null), { kind: 'goal', body: '重构模块' });
  assert.match(swarmAttachmentError(resolveComposerDraft('检查构建', 'swarm').body, { 'photo.png': 'example' }), /移除附件/);
});

test('Swarm summary reflects live state and excludes superseded nodes', () => {
  assert.deepEqual(summarizeSwarmRun({ status: 'planning', nodes: [] }), { label: '正在制定计划', tone: 'active', total: 0, completed: 0 });
  assert.deepEqual(summarizeSwarmRun({ status: 'running', nodes: [{ status: 'completed' }, { status: 'running' }, { status: 'superseded' }] }), {
    label: '协作执行中', tone: 'active', total: 2, completed: 1,
  });
  assert.deepEqual(summarizeSwarmRun({ status: 'cancelled', nodes: [{ status: 'cancelled' }] }), { label: '已取消', tone: 'idle', total: 1, completed: 0 });
});
