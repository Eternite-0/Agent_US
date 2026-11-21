const CATEGORIES = [
  ['metadata-identity', 'Identify the canonical metadata identity record.'],
  ['metadata-version', 'Identify the deterministic version metadata record.'],
  ['metadata-provenance', 'Identify the deterministic provenance metadata record.'],
  ['metadata-capability', 'Identify the deterministic capability metadata record.'],
  ['metadata-policy', 'Identify the deterministic policy metadata record.'],
  ['metadata-health', 'Identify the deterministic health metadata record.'],
];

function makeTask(category, index, description) {
  const ordinal = String(index).padStart(2, '0');
  const id = `${category}-${ordinal}`;
  const key = `${category}.record.${index}`;
  const value = {
    key,
    category,
    ordinal: index,
    stable: true,
    source: 'agent-us-evaluation-fixture',
  };
  return {
    id,
    title: `${description} #${index}`,
    category,
    difficulty: index % 3 === 0 ? 'medium' : 'easy',
    tags: ['benchmark', 'metadata', category],
    prompt: `Return the exact JSON metadata record for ${key}. Do not add commentary.`,
    expected: { output: value },
    fixture: {
      files: {
        'evaluation/input.json': JSON.stringify({ key, value }, null, 2),
      },
      output: value,
    },
    metadata: {
      source: 'local-deterministic',
      externalNetwork: false,
      ordinal: index,
    },
  };
}

export function createBenchmarkDataset() {
  return CATEGORIES.flatMap(([category, description]) =>
    Array.from({ length: 5 }, (_, offset) => makeTask(category, offset + 1, description)),
  );
}

export const BENCHMARK_DATASET = Object.freeze(createBenchmarkDataset());
export const BENCHMARK_TASK_COUNT = BENCHMARK_DATASET.length;
