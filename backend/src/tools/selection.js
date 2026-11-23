// Advisory wire catalog, never a permit. Do not infer capabilities from provider/MCP text.
const lookup = [['inspect_repository', '仓库入口/测试命令'], ['glob', '找文件/列目录'],
  ['grep', '搜索内容'], ['read_file', '已知路径直接读']];
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
  return entries.map(({ tool, decision }) => {
    let description = tool.description;
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
