// Advisory wire catalog, never a permit. Do not infer capabilities from provider/MCP text.
const lookup = [
  ['inspect_repository', '仓库入口/测试命令'],
  ['query_symbol_graph', '符号定义/跨文件调用与关联测试'],
  ['run_diagnostics', '结构化语法/类型/测试诊断'],
  ['glob', '找文件/列目录'],
  ['grep', '搜索内容'],
  ['read_file', '已知路径直接读'],
];
function alternatives(names) {
  return lookup.filter(([name]) => names.has(name)).map(([name, role]) => `${role}用 ${name}`).join('，');
}

export function modelToolCatalog(tools, policy, live) {
  const entries = [];
  for (const tool of tools) {
    const command = tool.meta?.requiresCommandCheck || tool.name === 'bash' || tool.name === 'start_process';
    // A runnable shell command is argument-dependent, even in read-only mode. Do not
    // guess a command, approved prefix, or user's approval decision to compute visibility.
    if (command && policy.nameDenial(tool.name, live)) continue;
    const decision = command ? 'conditional' : policy.evaluate(tool, {}, live).decision;
    if (decision !== 'deny') entries.push({ tool, decision });
  }
  const names = new Set(entries.map(({ tool }) => tool.name));
  // Promote `edit_file` (#1 single-file) -> `apply_patch` (#2 multi-file) -> `run_diagnostics`
  // -> `inspect_repository`/`query_symbol_graph` -> `write_file` -> `bash` deterministically.
  const priority = (name) => {
    if (name === 'edit_file') return 0;
    if (name === 'apply_patch') return 1;
    if (name === 'run_diagnostics') return 2;
    if (name === 'inspect_repository' || name === 'query_symbol_graph') return 3;
    if (name === 'write_file') return 4;
    if (name === 'bash') return 5;
    return 3;
  };
  const indexed = entries.map((entry, idx) => ({ entry, idx }));
  indexed.sort((a, b) => priority(a.entry.tool.name) - priority(b.entry.tool.name) || a.idx - b.idx);

  return indexed.map(({ entry: { tool, decision } }) => {
    let description = tool.description;
    if (tool.name === 'edit_file') {
      description += ' 首选推荐：单文件精确上下文局部修改首选 edit_file；target 直接复制自 read_file 的原始代码内容（不要包含行号前缀）。';
    } else if (tool.name === 'apply_patch') {
      description += ' 多文件或多处不连续 hunk 的原子修改优先使用 apply_patch（而非整文件 write_file）。';
    } else if (tool.name === 'write_file' && (names.has('edit_file') || names.has('apply_patch'))) {
      description += ' 修改已有文件优先使用 edit_file 或 apply_patch；write_file 仅用于新建文件或整文件覆写。';
    } else if (tool.name === 'run_diagnostics') {
      description += ' 优先用于快速结构化语法/类型/测试检查。';
    } else if (tool.name === 'query_symbol_graph') {
      description += ' 优先用于直接查询符号定义范围、跨文件调用方/导入方及关联测试。';
    }
    if (decision === 'conditional') {
      const routes = tool.name === 'bash' && alternatives(names);
      description += `${routes ? ` 仓库侦察不用 shell：${routes}。` : ''}命令受策略逐条检查${live.permissionMode === 'read-only' ? '，仅限策略识别的只读命令' : '，可能需审批'}。`;
      if (tool.name === 'bash') description += '测试按给定命令原样单独运行，不加管道、重定向或退出码包装。';
    } else if (decision === 'ask') description += ' 需审批。';
    return { name: tool.name, description, parameters: tool.parameters };
  });
}

// No autonomous fallback, rewritten command, suggested arguments or changes to receipts.
export function selectionRecoveryHint({ tc, receipt, parsedArgs }, getModelTools) {
  if (tc.name !== 'bash' || receipt?.status !== 'rejected_before_effect' ||
      !['POLICY_DENIED', 'APPROVAL_DENIED'].includes(receipt.errorCode)) return '';
  const stop = '未执行。不要重试或绕过拒绝；必须执行该操作时请说明阻塞。';
  // Only recommend native discovery for a simple, non-mutating repository listing.
  // Never translate commands carrying paths, data, shell syntax or writes after denial.
  if (!/^\s*(?:ls(?:\s+-[alh]+)*|pwd|dir)\s*$/i.test(parsedArgs?.command ?? '')) return stop;
  const routes = alternatives(new Set((getModelTools?.() ?? []).map(t => t.name)));
  return routes ? `${stop} 对于另行允许的仓库查询：${routes}。` : stop;
}
