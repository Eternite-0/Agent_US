import { matchesApprovedPrefix } from '../patch-and-diagnostics.js';
import { analyzeCommand, scanCommandSyntax } from './command-analyzer.js';
import {
  isPrivateIpAddress,
  isPrivateHostnameLiteral,
  validateExternalUrl,
  safeFetchExternal,
} from './ssrf-guard.js';

export {
  analyzeCommand,
  scanCommandSyntax,
  isPrivateIpAddress,
  isPrivateHostnameLiteral,
  validateExternalUrl,
  safeFetchExternal,
};

export const PERMISSION_RANK = Object.freeze({
  'read-only': 0,
  approval: 1,
  'auto-safe': 2,
  'workspace-write': 3,
  'auto-review': 4,
  'full-access': 5,
});

/**
 * Normalizes a tool allowlist with explicit semantics:
 * - null / undefined => null (no extra allowlist restriction)
 * - [] => [] (allow NO tools)
 * - non-empty array => deduplicated list (allow ONLY listed tools)
 */
export function normalizeToolAllowlist(allowTools) {
  if (allowTools === null || allowTools === undefined) return null;
  if (!Array.isArray(allowTools)) return null;
  return [...new Set(allowTools.map((t) => String(t)))];
}

export function intersectAllowlists(a, b) {
  const normA = normalizeToolAllowlist(a);
  const normB = normalizeToolAllowlist(b);
  if (Array.isArray(normA) && Array.isArray(normB)) {
    const bSet = new Set(normB);
    return normA.filter((t) => bSet.has(t));
  }
  if (Array.isArray(normA)) return [...normA];
  if (Array.isArray(normB)) return [...normB];
  return null;
}

export function isToolAllowedByAllowlist(toolName, allowTools) {
  const norm = normalizeToolAllowlist(allowTools);
  if (norm === null) return true;
  return norm.includes(String(toolName ?? ''));
}

export function filterToolsByPolicy(tools, { denyTools = [], allowTools = null } = {}) {
  const denySet = new Set(denyTools ?? []);
  const normAllow = normalizeToolAllowlist(allowTools);
  const allowSet = Array.isArray(normAllow) ? new Set(normAllow) : null;
  return tools.filter((t) => {
    if (denySet.has(t.name)) return false;
    if (allowSet !== null && !allowSet.has(t.name)) return false;
    return true;
  });
}

/**
 * Intersects parent and child permission policies so child agents can never
 * escalate permissions or bypass deny rules.
 * Preserves explicit [] allowlist semantics (never widens [] to null).
 */
export function intersectPolicies(parentPolicy = {}, childPolicy = {}) {
  const rawParentMode = parentPolicy.permissionMode ?? 'auto-safe';
  const rawChildMode = childPolicy.permissionMode ?? rawParentMode;
  const parentValid = Object.hasOwn(PERMISSION_RANK, rawParentMode);
  const childValid = Object.hasOwn(PERMISSION_RANK, rawChildMode);
  const parentMode = parentValid ? rawParentMode : 'read-only';
  const childMode = childValid ? rawChildMode : 'read-only';
  const pRank = parentValid ? PERMISSION_RANK[parentMode] : 0;
  const cRank = childValid ? PERMISSION_RANK[childMode] : 0;
  const effectiveMode = pRank <= cRank ? parentMode : childMode;

  const denyTools = [
    ...new Set([...(parentPolicy.denyTools ?? []), ...(childPolicy.denyTools ?? [])]),
  ];
  const allowTools = intersectAllowlists(parentPolicy.allowTools, childPolicy.allowTools);

  return {
    permissionMode: effectiveMode,
    denyTools,
    allowTools,
    allowOutwardInFullAccess: Boolean(
      parentPolicy.allowOutwardInFullAccess && childPolicy.allowOutwardInFullAccess,
    ),
  };
}

/**
 * Layer 4 ToolPermissionPolicy engine deciding allow | deny | ask for every tool call.
 */
export class ToolPermissionPolicy {
  constructor({
    permissionMode = 'auto-safe',
    alwaysDenyRules = [],
    alwaysAllowRules = [],
    alwaysAskRules = [],
    allowTools = null,
    allowOutwardInFullAccess = false,
  } = {}) {
    this.permissionMode = permissionMode;
    this.alwaysDenyRules = new Set(alwaysDenyRules);
    this.alwaysAllowRules = new Set(alwaysAllowRules);
    this.alwaysAskRules = new Set(alwaysAskRules);
    this.allowTools = normalizeToolAllowlist(allowTools);
    this.allowOutwardInFullAccess = Boolean(allowOutwardInFullAccess);
  }

  // Name-only exclusions are independent of command arguments and human approval.
  nameDenial(name, { allowTools, denyTools } = {}) {
    if (this.alwaysDenyRules.has(name) || (Array.isArray(denyTools) && denyTools.includes(name))) {
      return {
        decision: 'deny',
        reason: `Tool "${name}" denied by policy rule`,
        rule: 'always_deny',
      };
    }

    const effectiveAllow = intersectAllowlists(this.allowTools, allowTools);
    if (Array.isArray(effectiveAllow) && !effectiveAllow.includes(name)) {
      return {
        decision: 'deny',
        reason:
          effectiveAllow.length === 0
            ? `Tool "${name}" denied: empty tool allowlist`
            : `Tool "${name}" is not in allowed tool allowlist`,
        rule: effectiveAllow.length === 0 ? 'allowlist_empty' : 'allowlist_denied',
      };
    }

    return null;
  }

  evaluate(
    toolDef,
    args = {},
    {
      approvedPrefixes = [],
      tainted = false,
      permissionMode = this.permissionMode,
      allowTools = undefined,
      denyTools = undefined,
    } = {},
  ) {
    const name = toolDef.name;
    const meta = toolDef.meta ?? {};
    const effectiveMode = Object.hasOwn(PERMISSION_RANK, permissionMode)
      ? permissionMode
      : 'read-only';

    const nameDenial = this.nameDenial(name, { allowTools, denyTools });
    if (nameDenial) return nameDenial;

    if (meta.requiresCommandCheck || name === 'bash' || name === 'start_process') {
      const analysis = analyzeCommand(args?.command);
      if (analysis.hardBlocked) {
        return {
          decision: 'deny',
          reason: `POLICY_HARD_BLOCKED:${analysis.hardBlocked}`,
          rule: analysis.hardBlocked,
        };
      }
      if (effectiveMode === 'read-only' && !analysis.isReadOnly) {
        return {
          decision: 'deny',
          reason: 'Read-only policy prohibits non-readonly commands',
          rule: 'read_only_mode',
        };
      }
      if (this.alwaysAskRules.has(name)) {
        return {
          decision: 'ask',
          reason: 'alwaysAsk rule',
          commandPrefix: analysis.commandPrefix,
        };
      }
      if (effectiveMode === 'full-access') {
        return {
          decision: 'allow',
          reason: 'full-access mode',
          commandPrefix: analysis.commandPrefix,
        };
      }
      if (matchesApprovedPrefix(args?.command, approvedPrefixes)) {
        return {
          decision: 'allow',
          reason: 'session-prefix cache',
          commandPrefix: analysis.commandPrefix,
        };
      }
      if (effectiveMode === 'auto-safe' && analysis.isReadOnly) {
        return {
          decision: 'allow',
          reason: 'strict read-only command allowlist',
          commandPrefix: analysis.commandPrefix,
        };
      }
      return {
        decision: 'ask',
        reason: 'Command execution requires approval',
        commandPrefix: analysis.commandPrefix,
      };
    }

    if (meta.readOnly) {
      if (tainted && meta.effectClass === 'external_network') {
        return {
          decision: 'ask',
          reason: 'Tainted context requires human approval for external network fetch',
          rule: 'tainted_external_network_gate',
        };
      }
      if (this.alwaysAskRules.has(name)) {
        return { decision: 'ask', reason: 'alwaysAsk rule' };
      }
      return { decision: 'allow', reason: 'read-only tool' };
    }

    if (effectiveMode === 'read-only') {
      return {
        decision: 'deny',
        reason: `Tool "${name}" is not allowed in read-only mode`,
        rule: 'read_only_mode',
      };
    }

    if (meta.outward) {
      if (this.alwaysAllowRules.has(name) && !tainted) {
        return { decision: 'allow', reason: 'explicit outward allow rule' };
      }
      if (effectiveMode === 'full-access' && this.allowOutwardInFullAccess && !tainted) {
        return { decision: 'allow', reason: 'full-access outward opt-in' };
      }
      return {
        decision: 'ask',
        reason: tainted
          ? 'Tainted context requires human approval for outward tool'
          : 'Outward external tool requires human approval',
        rule: 'outward_human_gate',
      };
    }

    if (this.alwaysAskRules.has(name)) {
      return { decision: 'ask', reason: 'alwaysAsk rule' };
    }
    if (this.alwaysAllowRules.has(name) || effectiveMode === 'full-access') {
      return { decision: 'allow', reason: 'policy allow' };
    }
    if (
      (effectiveMode === 'auto-safe' || effectiveMode === 'workspace-write') &&
      meta.effectClass === 'reversible_write'
    ) {
      return { decision: 'allow', reason: `${effectiveMode} reversible write` };
    }

    return { decision: 'ask', reason: 'Approval required' };
  }
}
