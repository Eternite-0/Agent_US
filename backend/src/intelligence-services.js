import { AdaptivePlanner } from './planning/planner.js';
import { AdaptiveReplanner } from './planning/replanner.js';
import { EvaluationService } from './evaluation/service.js';
import { createCapabilityProfileRegistry } from './swarm/capability-registry.js';
import { TeamOptimizer } from './swarm/team-optimizer.js';
import { StoreCommunicationAdapter, CommunicationBus } from './communication/index.js';
import { ExperienceMemoryService } from './memory/index.js';

export function createIntelligenceServices({ store, directAgent, providers = null } = {}) {
  const capabilityRegistry = createCapabilityProfileRegistry({ store });
  for (const model of providers?.models ?? []) {
    const id = String(model.id ?? model.model ?? '').trim();
    if (id) capabilityRegistry.registerDeclared({
      id,
      label: id,
      capabilities: model,
      metadata: { provider: model.provider ?? null, source: 'provider-catalog' },
    });
  }
  const planner = new AdaptivePlanner({ permissionCeiling: 'full' });
  const memory = new ExperienceMemoryService({ store });
  const evaluation = new EvaluationService({ store, directAgent, jobQueue: directAgent?.jobQueue ?? null, memory, capabilityRegistry });
  evaluation.registerOnWorker(directAgent?.recoveryWorker);
  return {
    evaluation,
    planner,
    replanner: new AdaptiveReplanner({ planner }),
    capabilityRegistry,
    teamOptimizer: new TeamOptimizer({}),
    communication: new CommunicationBus({ adapter: new StoreCommunicationAdapter({ store }) }),
    memory,
  };
}




