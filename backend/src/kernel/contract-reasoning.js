import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { extractRepositorySymbols } from '../repo-symbols.js';
import { isProtectedPathSegment, resolveConfinedPath } from '../tools/sandbox.js';

const FILE_PATH_TOKEN_RE =
  /(?:^|[\s`"'(\[])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:[cm]?[jt]sx?|json|md|txt|py|go|rs|sh|ya?ml|toml)|(?:SECURITY|README|ANALYSIS|CONSTRAINTS|LICENSE)\.(?:md|txt)|(?:CONTRACT|package)\.json|handoff\/[A-Za-z0-9._/-]+)(?=$|[\s`"'),.;:\]])/gi;

const FORBIDDEN_CLAUSE_RE =
  /(?:without modifying|do not modify|do not edit|never touch|never modify|keep\s+[^\n.!?]{0,60}\s+(?:untouched|unmodified)|must not (?:modify|edit|change)|禁止修改|严禁修改|不要修改|保持[^\n。！？]{0,30}(?:不变|未修改))((?:[^.\n!?;。！？]|\.(?!\s|$))+)/gi;

const COMMAND_TOKEN_RE =
  /`((?:node\s+--test|npm\s+(?:test|run\s+[a-z0-9:_-]+)|pnpm\s+(?:test|run\s+[a-z0-9:_-]+)|npx\s+[a-z0-9@_./-]+|pytest|cargo\s+test|go\s+test)[^`\r\n]{0,160})`/gi;

const SYMBOL_SIGNATURE_RE =
  /`?([A-Za-z_$][A-Za-z0-9_$]*)\(([^()\n`]{0,80})\)`?/g;

const EDGE_CASE_PATTERNS = [
  ['division_by_zero', /\bdivision by zero\b|divide by zero|\/\s*0|除零|零除/i],
  ['null_undefined', /\b(?:null|undefined|empty string|empty input|nil)\b|空值|空串/i],
  ['nan_infinity', /\b(?:NaN|Infinity|-Infinity|non-finite)\b/i],
  ['path_traversal_symlink', /\b(?:traversal|symlink|junction|prefix collision|nul byte|%00|%2e%2e)\b|路径穿越|符号链接/i],
  ['prototype_pollution', /\b(?:__proto__|constructor\.prototype|prototype pollution)\b|原型污染/i],
  ['digest_integrity', /\b(?:sha-?256|digest|canonical|sorted|checksum)\b|摘要|哈希/i],
  ['ordering_precedence', /\b(?:precedence|priority|tie-?break|deterministic order|sorted?)\b|优先级|排序/i],
  ['backward_compat', /\b(?:backward compat|legacy|preserve existing|without breaking)\b|向后兼容/i],
];

const BUILTIN_CONTRACT_FILES = ['package.json', 'CONSTRAINTS.md', 'CONTRACT.json', 'README.md'];
const MAX_INSPECTED_BYTES = 64 * 1024;

function isSafeWorkspaceRelativePath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return false;
  const norm = relPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || norm.includes('://') || norm.startsWith('/') || isAbsolute(norm)) return false;
  const parts = norm.split('/').filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((seg) => seg === '..' || seg === 'node_modules' || isProtectedPathSegment(seg))) {
    return false;
  }
  const normLower = norm.toLowerCase();
  if (normLower === 'upstream' || normLower.startsWith('upstream/') || normLower === 'var' || normLower.startsWith('var/') || normLower.startsWith('backend/var/')) {
    return false;
  }
  if (parts.some((seg) => /^\.env(?:$|[._-])/i.test(seg) || /\.(?:pem|key|pfx|p12|crt|der|sqlite(?:3)?|sqlite-wal|sqlite-shm)$/i.test(seg))) {
    return false;
  }
  return true;
}

function readConfinedText(workspaceRoot, rawPath) {
  if (!workspaceRoot || !isSafeWorkspaceRelativePath(rawPath)) return null;
  try {
    const confined = resolveConfinedPath(workspaceRoot, rawPath);
    if (!isSafeWorkspaceRelativePath(confined.rel)) return null;
    if (!existsSync(confined.full)) return null;
    const st = statSync(confined.full);
    if (!st.isFile() || st.size > MAX_INSPECTED_BYTES) return null;
    return { rel: confined.rel.replace(/\\/g, '/'), text: readFileSync(confined.full, 'utf8') };
  } catch {
    return null;
  }
}

function extractExportNamesFromJs(path, text) {
  const names = new Set();
  const lang = /\.[cm]?tsx?$/i.test(path) ? 'typescript' : 'javascript';
  try {
    const { definitions } = extractRepositorySymbols(path, lang, text);
    for (const def of definitions) {
      if (def?.name && new RegExp(`\\bexport\\b[^\\n;]{0,60}\\b${def.name}\\b`).test(text)) {
        names.add(def.name);
      }
    }
  } catch {
    // Fallback to direct export matching below
  }
  for (const m of text.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const pieces = part.trim().split(/\s+as\s+/);
      const exported = (pieces[1] || pieces[0] || '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exported) && exported !== 'default') {
        names.add(exported);
      }
    }
  }
  if (/\bexport\s+default\b/.test(text)) names.add('default');
  for (const m of text.matchAll(/\b(?:module\.exports|exports)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) {
    names.add(m[1]);
  }
  const objExport = text.match(/\bmodule\.exports\s*=\s*\{([^}]+)\}/);
  if (objExport) {
    for (const item of objExport[1].split(',')) {
      const key = item.trim().split(':')[0]?.trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) names.add(key);
    }
  }
  return [...names];
}

function collectPromptPaths(text) {
  const found = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(FILE_PATH_TOKEN_RE)) {
    const raw = m[1]?.trim();
    if (!raw || !isSafeWorkspaceRelativePath(raw)) continue;
    const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!seen.has(norm)) {
      seen.add(norm);
      found.push(norm);
    }
  }
  return found;
}

function collectForbiddenMutations(prompt) {
  const forbidden = new Set();
  for (const m of String(prompt || '').matchAll(FORBIDDEN_CLAUSE_RE)) {
    const clause = m[1] || '';
    for (const path of collectPromptPaths(clause)) {
      forbidden.add(path);
    }
    if (/\bsrc\//i.test(clause)) forbidden.add('src/');
  }
  return [...forbidden];
}

function collectRequestedSymbols(prompt, requiredFiles) {
  const lines = String(prompt || '').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  const ignoreNames = new Set(['test', 'equal', 'deepEqual', 'throws', 'ok', 'ifError', 'stringify', 'parse']);
  const reqJsFiles = requiredFiles.filter((p) => /\.[cm]?[jt]sx?$/i.test(p));

  for (const line of lines) {
    const linePaths = collectPromptPaths(line).filter(
      (p) => /\.[cm]?[jt]sx?$/i.test(p) && reqJsFiles.includes(p),
    );
    for (const m of line.matchAll(SYMBOL_SIGNATURE_RE)) {
      const name = m[1];
      if (!name || ignoreNames.has(name) || name.length < 2) continue;
      if (line.slice(Math.max(0, m.index - 1), m.index) === '.') continue;
      let fileHint = null;
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length, m.index + m[0].length + 120);
      const beforePaths = collectPromptPaths(before).filter((p) => /\.[cm]?[jt]sx?$/i.test(p));
      const inAfterMatch = /^\s*(?:in|from|on|inside|of)\s+`?([^\s`,;)]+)/i.exec(after);
      const afterPaths = inAfterMatch ? collectPromptPaths(inAfterMatch[1]).filter((p) => /\.[cm]?[jt]sx?$/i.test(p)) : [];
      if (afterPaths.length) {
        fileHint = afterPaths[0];
      } else if (beforePaths.length) {
        fileHint = beforePaths.at(-1);
      } else if (linePaths.length === 1) {
        fileHint = linePaths[0];
      } else if (reqJsFiles.length === 1) {
        fileHint = reqJsFiles[0];
      }
      if (!fileHint) continue;
      const key = `${fileHint}::${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name, argsHint: (m[2] || '').trim(), fileHint });
      }
    }
  }
  return out;
}

function collectJsonContracts(prompt, requiredFiles) {
  const jsonFiles = requiredFiles.filter((p) => p.toLowerCase().endsWith('.json'));
  if (!jsonFiles.length) return [];
  const lines = String(prompt || '').split(/\r?\n/);
  const contracts = [];
  for (const jf of jsonFiles) {
    const keys = new Set();
    for (const line of lines) {
      if (!line.includes(jf) && jsonFiles.length > 1) continue;
      for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9_]{1,40})`/g)) {
        if (!m[1].includes('.') && !m[1].includes('/')) keys.add(m[1]);
      }
      const braceMatch = line.match(/\{([^}]{1,200})\}/);
      if (braceMatch) {
        for (const token of braceMatch[1].split(',')) {
          const k = token.split(':')[0]?.trim().replace(/^["']|["']$/g, '');
          if (/^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(k)) keys.add(k);
        }
      }
    }
    contracts.push({ path: jf, requiredKeys: [...keys].slice(0, 16) });
  }
  return contracts;
}

/**
 * Deterministically extracts explicit and implicit task contracts from the user prompt
 * and already-inspected workspace artifacts without reading protected secrets.
 */
export function extractTaskContract({ prompt = '', workspaceRoot = null, filesRead = [] } = {}) {
  const promptText = String(prompt ?? '');
  const forbiddenMutations = collectForbiddenMutations(promptText);
  const forbiddenSet = new Set(forbiddenMutations);

  const promptPaths = collectPromptPaths(promptText);
  const requiredFiles = promptPaths.filter(
    (p) =>
      !forbiddenMutations.some((rule) =>
        rule.endsWith('/') ? p.startsWith(rule) : p === rule,
      ),
  );

  const expectedCommands = [];
  for (const m of promptText.matchAll(COMMAND_TOKEN_RE)) {
    const cmd = m[1]?.trim();
    if (cmd && !expectedCommands.includes(cmd)) expectedCommands.push(cmd);
  }

  let packageMeta = null;
  const contractFilesOnDisk = [];
  const inspectedContractFiles = [];
  const workspaceExports = {};
  const extraConstraintText = [];

  if (workspaceRoot && existsSync(resolve(String(workspaceRoot)))) {
    for (const rel of BUILTIN_CONTRACT_FILES) {
      const info = readConfinedText(workspaceRoot, rel);
      if (!info) continue;
      contractFilesOnDisk.push(info.rel);
    }

    const pkgInfo = readConfinedText(workspaceRoot, 'package.json');
    if (pkgInfo) {
      try {
        const pkg = JSON.parse(pkgInfo.text);
        packageMeta = {
          name: typeof pkg.name === 'string' ? pkg.name : null,
          type: typeof pkg.type === 'string' ? pkg.type : null,
          main: typeof pkg.main === 'string' ? pkg.main : null,
          scripts: pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : [],
          hasExports: Boolean(pkg.exports),
          hasBin: Boolean(pkg.bin),
        };
      } catch {
        packageMeta = { invalidJson: true };
      }
    }

    const inspectCandidates = new Set(
      (Array.isArray(filesRead) ? filesRead : [])
        .map((f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter((f) => isSafeWorkspaceRelativePath(f)),
    );
    for (const rel of [...inspectCandidates].slice(0, 24)) {
      const info = readConfinedText(workspaceRoot, rel);
      if (!info) continue;
      inspectedContractFiles.push(info.rel);
      if (/\.(?:md|txt)$/i.test(info.rel)) {
        extraConstraintText.push(info.text.slice(0, 4000));
      } else if (/\.[cm]?[jt]sx?$/i.test(info.rel)) {
        const exportsList = extractExportNamesFromJs(info.rel, info.text);
        if (exportsList.length) workspaceExports[info.rel] = exportsList;
      }
    }
  }

  const combinedText = [promptText, ...extraConstraintText].join('\n');
  const requestedSymbols = collectRequestedSymbols(promptText, requiredFiles);
  const jsonContracts = collectJsonContracts(promptText, requiredFiles);

  const edgeCaseKeywords = [];
  for (const [tag, re] of EDGE_CASE_PATTERNS) {
    if (re.test(combinedText)) edgeCaseKeywords.push(tag);
  }

  return {
    promptExcerpt: promptText.slice(0, 400),
    packageMeta,
    requiredFiles,
    forbiddenMutations,
    expectedCommands,
    requestedSymbols,
    jsonContracts,
    edgeCaseKeywords,
    contractFilesOnDisk,
    inspectedContractFiles,
    workspaceExports,
  };
}

/**
 * Evaluates workspace deliverable readiness, schema/export integrity, forbidden mutation guards,
 * and root-cause verification posture against an extracted task contract.
 */
export function evaluateContractReadiness({
  contract = null,
  reasoningState = null,
  workspaceRoot = null,
  verifierEvents = [],
} = {}) {
  if (!contract || typeof contract !== 'object') {
    return {
      evaluated: false,
      ready: true,
      gaps: [],
      missingDeliverables: [],
      invalidJsonFiles: [],
      missingExportedSymbols: [],
      missingContractReads: [],
      forbiddenViolations: [],
      checklistText: '',
    };
  }

  const filesRead = Array.isArray(reasoningState?.filesRead) ? reasoningState.filesRead : [];
  const filesMutated = Array.isArray(reasoningState?.filesMutated) ? reasoningState.filesMutated : [];
  const readSet = new Set(filesRead);
  const rootMutatedSrc = filesMutated.some((f) => /^(?:src|lib)\//i.test(f));

  const missingContractReads = [];
  if (workspaceRoot) {
    const preReadTargets = new Set([
      ...(Array.isArray(contract.contractFilesOnDisk) ? contract.contractFilesOnDisk : []),
    ]);
    for (const req of contract.requiredFiles ?? []) {
      const info = readConfinedText(workspaceRoot, req);
      if (info && !filesMutated.includes(req)) {
        preReadTargets.add(info.rel);
      }
    }
    for (const target of preReadTargets) {
      if (!readSet.has(target)) missingContractReads.push(target);
    }
  }

  const missingDeliverables = [];
  const invalidJsonFiles = [];
  const missingJsonKeys = [];
  const missingExportedSymbols = [];

  if (workspaceRoot && existsSync(resolve(String(workspaceRoot)))) {
    for (const req of contract.requiredFiles ?? []) {
      const info = readConfinedText(workspaceRoot, req);
      if (!info) {
        if (!isSafeWorkspaceRelativePath(req)) continue;
        try {
          const confined = resolveConfinedPath(workspaceRoot, req);
          if (!existsSync(confined.full)) {
            missingDeliverables.push(req);
          }
        } catch {
          // ignore unresolvable token
        }
        continue;
      }
      if (req.toLowerCase().endsWith('.json')) {
        try {
          const parsed = JSON.parse(info.text);
          const jc = (contract.jsonContracts ?? []).find((c) => c.path === req);
          if (jc?.requiredKeys?.length && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const k of jc.requiredKeys) {
              if (!Object.hasOwn(parsed, k)) {
                missingJsonKeys.push(`${req}:${k}`);
              }
            }
          }
        } catch {
          invalidJsonFiles.push(req);
        }
      }
    }

    for (const sym of contract.requestedSymbols ?? []) {
      if (!sym?.fileHint || !sym?.name) continue;
      const info = readConfinedText(workspaceRoot, sym.fileHint);
      if (!info) continue;
      const exported = extractExportNamesFromJs(info.rel, info.text);
      if (!exported.includes(sym.name)) {
        missingExportedSymbols.push(`${sym.fileHint}#${sym.name}`);
      }
    }
  }

  const forbiddenViolations = [];
  for (const mutated of filesMutated) {
    for (const rule of contract.forbiddenMutations ?? []) {
      if (rule.endsWith('/') ? mutated.startsWith(rule) : mutated === rule) {
        if (!forbiddenViolations.includes(mutated)) forbiddenViolations.push(mutated);
      }
    }
  }

  const unverifiedChanges = Boolean(reasoningState?.hasUnverifiedMutationsAfterLastPass);
  const rootCauseUnverified = Boolean(
    reasoningState?.reproducedFailureBeforeEdit &&
      filesMutated.length > 0 &&
      !reasoningState?.rootCauseVerifiedAfterEdit,
  );
  const hadToolEvidence =
    Array.isArray(verifierEvents) && verifierEvents.some((e) => e.type === 'tool/result');

  const gaps = [];
  if (rootMutatedSrc && missingContractReads.length > 0 && filesRead.length === 0) {
    gaps.push({
      kind: 'missing_contract_reads',
      severity: 'advisory',
      message: `修改源码前尚未读取工作区契约/既有文件: ${missingContractReads.slice(0, 6).join(', ')}`,
    });
  }
  if (forbiddenViolations.length > 0) {
    gaps.push({
      kind: 'forbidden_mutation',
      severity: 'blocking',
      message: `违反禁止修改约束，下列文件不可篡改: ${forbiddenViolations.join(', ')}`,
    });
  }
  if (invalidJsonFiles.length > 0) {
    gaps.push({
      kind: 'invalid_json',
      severity: 'blocking',
      message: `JSON 契约文件语法无效: ${invalidJsonFiles.join(', ')}`,
    });
  }
  if (missingJsonKeys.length > 0) {
    gaps.push({
      kind: 'missing_json_keys',
      severity: 'advisory',
      message: `JSON 产物缺少约定字段: ${missingJsonKeys.slice(0, 6).join(', ')}`,
    });
  }
  if (missingExportedSymbols.length > 0) {
    gaps.push({
      kind: 'missing_exports',
      severity: 'blocking',
      message: `已创建模块缺少契约要求的导出符号: ${missingExportedSymbols.join(', ')}`,
    });
  }
  if (hadToolEvidence && missingDeliverables.length > 0) {
    gaps.push({
      kind: 'missing_deliverables',
      severity: 'blocking',
      message: `Prompt 明确要求的交付文件尚不存在: ${missingDeliverables.join(', ')}`,
    });
  }
  if (unverifiedChanges) {
    gaps.push({
      kind: 'unverified_changes',
      severity: 'blocking',
      message: '存在尚未运行验证命令的代码修改',
    });
  }
  if (rootCauseUnverified && !unverifiedChanges && reasoningState?.verifications?.length === 0) {
    gaps.push({
      kind: 'root_cause_unverified',
      severity: 'advisory',
      message: '已复现初始失败但尚未确认改动后失败签名已消除',
    });
  }

  const hasBlocking = gaps.some((g) => g.severity === 'blocking');
  const lines = gaps.slice(0, 5).map((g, idx) => `${idx + 1}. [${g.kind}] ${g.message}`);
  const checklistText = lines.length
    ? `[契约与根因核对]\n${lines.join('\n')}`
    : '';
  const missingReadGap = gaps.find((g) => g.kind === 'missing_contract_reads');
  const preEditWarningText = missingReadGap
    ? `[契约与根因核对]\n1. [missing_contract_reads] ${missingReadGap.message}`
    : '';

  return {
    evaluated: true,
    ready: !hasBlocking,
    gaps,
    missingDeliverables,
    invalidJsonFiles,
    missingJsonKeys,
    missingExportedSymbols,
    missingContractReads: missingContractReads.slice(0, 8),
    forbiddenViolations,
    unverifiedChanges,
    rootCauseUnverified,
    checklistText,
    preEditWarningText,
  };
}
