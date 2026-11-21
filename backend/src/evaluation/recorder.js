import { validateResult } from './schemas.js';

export class EvaluationRecorder {
  #records = [];
  #persist;

  constructor({ persist = null } = {}) {
    this.#persist = typeof persist === 'function' ? persist : null;
  }

  async record(result) {
    validateResult(result);
    const copy = structuredClone(result);
    this.#records.push(copy);
    if (this.#persist) await this.#persist(copy);
    return copy;
  }

  async recordBatch(results) {
    const out = [];
    for (const result of results) out.push(await this.record(result));
    return out;
  }

  list() {
    return this.#records.map((result) => structuredClone(result));
  }

  clear() {
    this.#records.length = 0;
  }
}

export function createMemoryRecorder() {
  return new EvaluationRecorder();
}
