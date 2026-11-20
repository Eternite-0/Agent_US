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
 * Intersects parent and child permission policies so child agents can never
 * escalate permissions or bypass deny rules.
 */
export function intersectPolicies(parentPolicy = {}, childPolicy = {}) {
  const parentMode = parentPolicy.permissionMode ?? 'auto-safe';
  const childMode = childPolicy.permissionMode ?? parentMode;
  const pRank = PERMISSION_RANK[parentMode] ?? 2;
  const cRank = PERMISSION_RANK[childMode] ?? 2;
  const effectiveMode = pRank <= cRank ? parentMode : childMode;

  const denyTools = [
    ...new Set([...(parentPolicy.denyTools ?? []), ...(childPolicy.denyTools ?? [])]),
  ];
  let allowTools = null;
  if (Array.isArray(parentPolicy.allowTools) && Array.isArray(childPolicy.allowTools)) {
    const childSet = new Set(childPolicy.allowTools);
    allowTools = parentPolicy.allowTools.filter((t) => childSet.has(t));
  } else if (Array.isArray(parentPolicy.allowTools)) {
    allowTools = [...parentPolicy.allowTools];
  } else if (Array.isArray(childPolicy.allowTools)) {
    allowTools = [...childPolicy.allowTools];
  }

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
    allowOutwardInFullAccess = false,
  } = {}) {
    this.permissionMode = permissionMode;
    this.alwaysDenyRules = new Set(alwaysDenyRules);
    this.alwaysAllowRules = new Set(alwaysAllowRules);
    this.alwaysAskRules = new Set(alwaysAskRules);
    this.allowOutwardInFullAccess = Boolean(allowOutwardInFullAccess);
  }

  evaluate(
    toolDef,
    args = {},
    { approvedPrefixes = [], tainted = false, permissionMode = this.permissionMode } = {},
  ) {
    const name = toolDef.name;
    const meta = toolDef.meta ?? {};

    if (this.alwaysDenyRules.has(name)) {
      return {
        decision: 'deny',
        reason: `Tool "${name}" denied by policy rule`,
        rule: 'always_deny',
      };
    }

    if (meta.requiresCommandCheck || name === 'bash' || name === 'start_process') {
      const analysis = analyzeCommand(args?.command);
      if (analysis.hardBlocked) {
        return {
          decision: 'deny',
          reason: `POLICY_HARD_BLOCKED:${analysis.hardBlocked}`,
          rule: analysis.hardBlocked,
        };
      }
      if (permissionMode === 'read-only' && !analysis.isReadOnly) {
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
      if (permissionMode === 'full-access') {
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
      if (permissionMode === 'auto-safe' && analysis.isReadOnly) {
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
      if (this.alwaysAskRules.has(name)) {
        return { decision: 'ask', reason: 'alwaysAsk rule' };
      }
      return { decision: 'allow', reason: 'read-only tool' };
    }

    if (permissionMode === 'read-only') {
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
      if (permissionMode === 'full-access' && this.allowOutwardInFullAccess && !tainted) {
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
    if (this.alwaysAllowRules.has(name) || permissionMode === 'full-access') {
      return { decision: 'allow', reason: 'policy allow' };
    }
    if (
      (permissionMode === 'auto-safe' || permissionMode === 'workspace-write') &&
      meta.effectClass === 'reversible_write'
    ) {
      return { decision: 'allow', reason: `${permissionMode} reversible write` };
    }

    return { decision: 'ask', reason: 'Approval required' };
  }
}
