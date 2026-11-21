import { validateTask } from './schemas.js';

export class EvaluationRegistry {
  #tasks = new Map();

  constructor(tasks = []) {
    this.registerMany(tasks);
  }

  register(task) {
    validateTask(task);
    if (this.#tasks.has(task.id)) {
      throw new Error(`Duplicate evaluation task: ${task.id}`);
    }
    this.#tasks.set(task.id, Object.freeze({ ...task }));
    return this.#tasks.get(task.id);
  }

  registerMany(tasks) {
    for (const task of tasks) this.register(task);
    return this;
  }

  get(id) {
    return this.#tasks.get(id) ?? null;
  }

  require(id) {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown evaluation task: ${id}`);
    return task;
  }

  list({ category = null, tags = [] } = {}) {
    const wantedTags = new Set(tags);
    return [...this.#tasks.values()].filter((task) =>
      (!category || task.category === category) &&
      [...wantedTags].every((tag) => task.tags?.includes(tag)),
    );
  }

  get size() {
    return this.#tasks.size;
  }
}
