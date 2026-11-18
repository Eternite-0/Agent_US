import { Context } from '@deepseek-ai/cordis';
import Llm from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';

export const TaskPlugin = {name:'agent-us-task-engine', apply(ctx, {store}) { ctx.provide('taskEngine',store); }};
export async function bundle(store, persona='') {
  const ctx=new Context();
  try {
    for(const plugin of [Llm,Sessions,Projections]) await ctx.plugin(plugin);
    await ctx.plugin(Prompt,{personaPrefix:persona});
    for(const plugin of [Tools,Native,Agents]) await ctx.plugin(plugin);
    await ctx.plugin(Loop,{agents:[]});
    await ctx.plugin(TaskPlugin,{store});
    if(!ctx.agentLoop || !ctx.taskEngine) throw Error('BUNDLE_UNAVAILABLE');
    return ctx;
  } catch(error) { await ctx.fiber.dispose(); throw error; }
}
