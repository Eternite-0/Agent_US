const CATEGORY_SPECS = Object.freeze([
  ['code-generation-repair', 8, '代码生成与修复'],
  ['unfamiliar-codebase-analysis', 5, '陌生代码库分析'],
  ['multi-file-refactor', 5, '多文件重构'],
  ['network-research-integration', 4, '网络研究与信息整合'],
  ['data-analysis', 3, '数据分析'],
  ['long-task-recovery', 3, '长任务中断恢复'],
  ['multi-agent-collaboration', 2, '多 Agent 协作'],
]);

function taskPayload(category, index) {
  const id = `${category}-${String(index).padStart(2, '0')}`;
  const value = {
    taskId: id,
    category,
    ordinal: index,
    stable: true,
    source: 'agent-us-evaluation-fixture',
  };
  const files = {
    'evaluation/input.json': JSON.stringify({ taskId: id, expected: value }, null, 2),
  };
  if (category === 'unfamiliar-codebase-analysis') files['src/entry.js'] = 'export const dependency = "local-fixture";\n';
  if (category === 'multi-file-refactor') {
    files['src/a.js'] = 'export const a = 1;\n';
    files['src/b.js'] = 'export const b = 2;\n';
  }
  if (category === 'network-research-integration') files['snapshots/source.json'] = JSON.stringify({ sourceId: id, captured: true }, null, 2);
  if (category === 'data-analysis') files['data/rows.json'] = JSON.stringify([{ value: 1 }, { value: 2 }, { value: 3 }]);
  if (category === 'long-task-recovery') files['checkpoint/state.json'] = JSON.stringify({ checkpoint: id, resumable: true }, null, 2);
  if (category === 'multi-agent-collaboration') files['handoff/manifest.json'] = JSON.stringify({ taskId: id, artifactRefs: [`artifact://${id}/result`] }, null, 2);
  return {
    id,
    title: `${CATEGORY_SPECS.find(([key]) => key === category)?.[2] ?? category} #${index}`,
    category,
    difficulty: index % 3 === 0 ? 'medium' : category === 'long-task-recovery' ? 'hard' : 'easy',
    tags: ['benchmark', 'deterministic', category],
    prompt: `Read the local fixture for ${id} and return the exact JSON metadata record for this task. Do not add commentary.`,
    expected: { output: value },
    fixture: { files, output: value },
    metadata: {
      source: 'local-deterministic',
      externalNetwork: false,
      snapshotVersion: '1.0.0',
      acceptance: ['exact_json_output', 'isolated_workspace', 'no_external_network'],
    },
  };
}

export function createBenchmarkDataset() {
  return CATEGORY_SPECS.flatMap(([category, count]) =>
    Array.from({ length: count }, (_, offset) => taskPayload(category, offset + 1)),
  );
}

export const BENCHMARK_DATASET = Object.freeze(createBenchmarkDataset());
export const BENCHMARK_TASK_COUNT = BENCHMARK_DATASET.length;
export const BENCHMARK_CATEGORY_COUNTS = Object.freeze(
  Object.fromEntries(CATEGORY_SPECS.map(([category, count]) => [category, count])),
);
