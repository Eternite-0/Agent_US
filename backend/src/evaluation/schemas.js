export class EvaluationSchemaError extends Error {
  constructor(message, detail = undefined) {
    super(message);
    this.name = 'EvaluationSchemaError';
    this.code = 'E_EVAL_SCHEMA';
    if (detail !== undefined) this.detail = detail;
  }
}

const TASK_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const STATUSES = new Set(['passed', 'failed', 'cancelled', 'timeout']);

function fail(message, detail) {
  throw new EvaluationSchemaError(message, detail);
}

function positiveInt(value, field, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    fail(`${field} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`, { field, value });
  }
  return value;
}

export function validateTask(task) {
  if (!task || typeof task !== 'object') fail('task must be an object');
  if (typeof task.id !== 'string' || !TASK_ID.test(task.id)) {
    fail('task.id must be a stable lowercase identifier', { id: task.id });
  }
  if (typeof task.title !== 'string' || !task.title.trim()) fail('task.title is required');
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) fail('task.prompt is required');
  if (!task.expected || typeof task.expected !== 'object') fail('task.expected must be an object');
  if (task.category !== undefined && (typeof task.category !== 'string' || !task.category.trim())) {
    fail('task.category must be a non-empty string');
  }
  if (task.difficulty !== undefined && !['easy', 'medium', 'hard'].includes(task.difficulty)) {
    fail('task.difficulty must be easy, medium, or hard');
  }
  if (task.timeoutMs !== undefined) positiveInt(task.timeoutMs, 'task.timeoutMs');
  if (task.maxAttempts !== undefined) positiveInt(task.maxAttempts, 'task.maxAttempts');
  if (task.fixture !== undefined && (typeof task.fixture !== 'object' || task.fixture === null)) {
    fail('task.fixture must be an object');
  }
  if (task.judge !== undefined && typeof task.judge !== 'function') {
    fail('task.judge must be a function when provided');
  }
  return task;
}

export function validateRunnerOptions(options = {}) {
  if (!options || typeof options !== 'object') fail('runner options must be an object');
  if (options.concurrency !== undefined) positiveInt(options.concurrency, 'concurrency');
  if (options.timeoutMs !== undefined) positiveInt(options.timeoutMs, 'timeoutMs');
  if (options.maxAttempts !== undefined) positiveInt(options.maxAttempts, 'maxAttempts');
  const budget = options.budget ?? {};
  if (budget.maxTasks !== undefined) positiveInt(budget.maxTasks, 'budget.maxTasks');
  if (budget.maxAttempts !== undefined) positiveInt(budget.maxAttempts, 'budget.maxAttempts');
  if (budget.maxConcurrent !== undefined) positiveInt(budget.maxConcurrent, 'budget.maxConcurrent');
  return options;
}

export function validateResult(result) {
  if (!result || typeof result !== 'object') fail('result must be an object');
  if (typeof result.taskId !== 'string' || !TASK_ID.test(result.taskId)) fail('result.taskId is invalid');
  if (!STATUSES.has(result.status)) fail('result.status is invalid', { status: result.status });
  if (!Number.isInteger(result.attempts) || result.attempts < 1) fail('result.attempts must be positive');
  if (typeof result.passed !== 'boolean') fail('result.passed must be boolean');
  return result;
}

export function validateReport(report) {
  if (!report || typeof report !== 'object') fail('report must be an object');
  if (!Array.isArray(report.results)) fail('report.results must be an array');
  report.results.forEach(validateResult);
  return report;
}

export { STATUSES };
