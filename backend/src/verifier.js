/**
 * Deterministic T0 turn-completion verifier & bounded repair policy
 * inspired by Agnes Harness `packages/core/src/execution/turn/gate.ts`.
 */

const TOOL_CALL_AS_TEXT_RE =
  /\{\s*"(?:tool|name|function)"\s*:\s*"(?:shell|pty|git|read_file|write_file|mcp|read_blob)"|\btool_call\s*:\s*\{/i;

const UNVERIFIED_CLAIM_RE =
  /(?:all\s+tests\s+pass(?:ed)?|tests?\s+passed|ran\s+(?:npm|pytest|cargo|go|vitest|node)\s+test|verified\s+by\s+running|build\s+succeeded\s+with\s+0\s+errors|全部测试通过|测试全部通过|已运行测试并通过)/i;

const MUTATING_TOOLS = new Set(['write_file', 'shell', 'pty', 'git', 'mcp']);

const REASON_TEXT = {
  schema_invalid: (ctx) =>
    `one or more tool calls had invalid arguments that were not corrected${ctx.invalidTools?.length ? ` (${ctx.invalidTools.join(', ')})` : ''}`,
  tool_call_as_text: () =>
    'a tool call was written as plain text instead of invoking the tool',
  output_truncated: () =>
    'the last assistant reply was cut off at the output token limit; split large file writes into smaller write_file/edit_file tool calls and keep prose concise before emitting the final JSON evidence manifest',
  repeated_write: (ctx) =>
    `the same mutating tool call${ctx.repeatedTool ? ` (${ctx.repeatedTool})` : ''} was repeated consecutively without progress`,
  no_progress: () =>
    'the last two assistant replies were identical with no new tool execution between them',
  required_files_missing: (ctx) =>
    `required deliverable file(s) are missing from the workspace: ${(ctx.missingFiles ?? []).join(', ')}`,
  unverified_coder_claim: () =>
    'the reply claimed tests/verification passed, but zero tool executions were recorded in this session',
  STALE_VERIFICATION_AFTER_EDIT: (ctx) => {
    const mutated =
      ctx.mutatedFilesAfterVerification ?? ctx.checks?.mutatedFilesAfterVerification ?? [];
    const filesText = Array.isArray(mutated) && mutated.length ? ` (${mutated.join(', ')})` : '';
    return `files${filesText} were modified after the last passing verification; review your edits and re-run the verification command via bash after your final edit so it passes with exitCode 0`;
  },
  UNRESOLVED_VERIFICATION_FAILURE: (ctx) => {
    const cmd =
      ctx.unresolvedVerificationCommand ?? ctx.checks?.unresolvedVerificationCommand ?? null;
    const excerpt =
      ctx.diagnosticExcerpt ??
      ctx.checks?.diagnosticExcerpt ??
      ctx.failureFingerprint?.summary ??
      null;
    return `verification${cmd ? ` (${cmd})` : ''} is still failing${excerpt ? ` — ${excerpt}` : ''}; read the failing test and root-cause source files (read_file/grep), fix the underlying root cause instead of repeating blind edits, and re-run verification until exitCode is 0`;
  },
  POST_EDIT_VERIFICATION_MISSING: (ctx) => {
    const mutated = ctx.mutatedFiles ?? ctx.checks?.mutatedFiles ?? [];
    const filesText = Array.isArray(mutated) && mutated.length ? ` (${mutated.join(', ')})` : '';
    return `files${filesText} were modified without running a verification command; run the relevant test/check command via bash to verify your changes`;
  },
};

function extractAssistantText(event) {
  return (event?.data?.message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function verifyTurn({ events = [], text = '', node = null, execution = null }) {
  const reasons = [];
  const invalidTools = [];
  let repeatedTool = null;
  const missingFiles = [];

  // 1. Unresolved invalid tool arguments
  if (execution?.argRecovery instanceof Map) {
    for (const [toolName, state] of execution.argRecovery.entries()) {
      if (state.failures > 0 || state.disabled) invalidTools.push(toolName);
    }
    if (invalidTools.length) reasons.push('schema_invalid');
  }

  // 2. Output truncated at max tokens
  const lastEnd = events.findLast((e) => e.type === 'turn/end');
  const endReason = lastEnd?.data?.reason;
  const endReasonKind =
    typeof endReason === 'object' && endReason !== null
      ? endReason.kind
      : endReason;
  if (endReasonKind === 'max-tokens' || endReasonKind === 'length') {
    reasons.push('output_truncated');
  }

  // 3. Tool call written as plain text (when no tool call happened in final step)
  const toolCalls = events.filter((e) => e.type === 'tool/call');
  const lastAssistantIdx = events.findLastIndex(
    (e) => e.type === 'assistant/message',
  );
  const hadToolCallAfterLastAssistant =
    lastAssistantIdx >= 0 &&
    events.slice(lastAssistantIdx).some((e) => e.type === 'tool/call');
  if (!hadToolCallAfterLastAssistant && TOOL_CALL_AS_TEXT_RE.test(text)) {
    reasons.push('tool_call_as_text');
  }

  // 4. Repeated identical mutating tool call (>= 3 consecutive)
  let streakKey = null;
  let streakCount = 0;
  for (const tc of toolCalls) {
    const name = tc.data?.name;
    if (!MUTATING_TOOLS.has(name)) {
      streakKey = null;
      streakCount = 0;
      continue;
    }
    const key = `${name}\0${JSON.stringify(tc.data?.arguments ?? tc.data?.input ?? '')}`;
    if (key === streakKey) {
      streakCount++;
      if (streakCount >= 3) {
        repeatedTool = name;
        reasons.push(`repeated_write:${streakCount}`);
        break;
      }
    } else {
      streakKey = key;
      streakCount = 1;
    }
  }

  // 5. No progress: last 2 assistant text replies identical with no tool results between
  const assistantIndices = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'assistant/message') assistantIndices.push(i);
  }
  if (assistantIndices.length >= 2) {
    const prevIdx = assistantIndices.at(-2);
    const currIdx = assistantIndices.at(-1);
    const hasToolResultBetween = events
      .slice(prevIdx + 1, currIdx)
      .some((e) => e.type === 'tool/result');
    if (!hasToolResultBetween) {
      const prevText = extractAssistantText(events[prevIdx]).trim();
      const currText = extractAssistantText(events[currIdx]).trim();
      if (prevText && prevText === currText) {
        reasons.push('no_progress:2');
      }
    }
  }

  // 6. Missing requiredFiles deliverable check (caught inside warm session!)
  if (node?.requiredFiles?.length) {
    const files = execution?.files ?? {};
    for (const p of node.requiredFiles) {
      if (!Object.hasOwn(files, p)) missingFiles.push(p);
    }
    if (missingFiles.length) reasons.push('required_files_missing');
  }

  // 7. Coder/Tester claims tests/verification passed with zero recorded tool evidence
  if (
    node &&
    (node.role === 'Coder' || node.role === 'Tester') &&
    (execution?.evidenceCount ?? 0) === 0 &&
    UNVERIFIED_CLAIM_RE.test(text)
  ) {
    reasons.push('unverified_coder_claim');
  }

  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    missingFiles,
    invalidTools,
    repeatedTool,
  };
}

export function buildRepairNote(result) {
  const lines = (result.reasons ?? []).map((reason) => {
    const [code] = reason.split(':', 2);
    const explain = REASON_TEXT[code];
    return `- ${reason}${explain ? `: ${explain(result)}` : ''}`;
  });
  const extra = [];
  const mutatedAfterVerify =
    result.mutatedFilesAfterVerification ?? result.checks?.mutatedFilesAfterVerification;
  if (Array.isArray(mutatedAfterVerify) && mutatedAfterVerify.length > 0) {
    extra.push(`Modified files needing re-verification: ${mutatedAfterVerify.join(', ')}.`);
  }
  const diagnosticExcerpt =
    result.diagnosticExcerpt ??
    result.checks?.diagnosticExcerpt ??
    result.failureFingerprint?.summary ??
    null;
  if (diagnosticExcerpt) {
    extra.push(`Diagnostic failure excerpt: ${diagnosticExcerpt}.`);
  }
  if (Array.isArray(result.missingFields) && result.missingFields.length > 0) {
    extra.push(`Missing or incomplete evidence fields: ${result.missingFields.join(', ')}.`);
  }
  if (Array.isArray(result.actualChangedFiles) && result.actualChangedFiles.length > 0) {
    extra.push(`Actual modified workspace files detected by git: ${JSON.stringify(result.actualChangedFiles)}.`);
  }
  if (result.expectedTestCommand) {
    extra.push(`Required test command: ${Array.isArray(result.expectedTestCommand) ? result.expectedTestCommand.join(' ') : result.expectedTestCommand}.`);
  }
  return [
    `The turn's automatic verification gate did not pass (${result.status || result.verdict}). Checks that failed:`,
    ...lines,
    ...extra,
    'Keep any work you have already verified and do not undo it. Fix only the items listed above, use tools (such as bash for tests and write_file/edit_file for changes) to produce real artifacts/evidence where required, and return the complete JSON evidence manifest matching schemaVersion "1.0.0".',
  ].join('\n');
}

export function decideRepair({ round, verdict }) {
  if (!verdict || verdict.verdict === 'pass') return 'complete';
  if (round <= 1) return 'repair';
  return 'complete';
}
