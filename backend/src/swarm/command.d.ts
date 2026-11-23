export function parseSwarmCommand(text: unknown): {
  action: 'start' | 'status' | 'stop' | 'help';
  task: string;
} | null;
