// Shared with the browser. Keep this module free of Node and runtime imports.
export function parseSwarmCommand(text) {
  if (typeof text !== 'string') return null;
  const match = /^\/swarm(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const task = (match[1] ?? '').trim();
  if (!task) return { action: 'help', task: '' };
  const control = task.toLowerCase();
  return control === 'status' || control === 'stop'
    ? { action: control, task: '' }
    : { action: 'start', task };
}
