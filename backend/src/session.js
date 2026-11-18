import {createUserMessage,LlmAdapter} from '@deepseek-ai/dsh-llm';
import {bundle} from './bundle.js';
import {Fault} from './store.js';

// A fresh Cordis scope exposes exactly this attempt's tools and adapter.
export async function runSession({store,task,session,model,adapter,persona,input,workspace,tools=[],signal,maxSteps=8,onUsage}) {
 const ctx=await bundle(store,persona);
 let agent;
 let calls=0;
 class Metered extends LlmAdapter {
   resolveModel(...args){return adapter.resolveModel(...args);}
   async *stream(options){if(++calls>maxSteps)throw new Fault('STEP_BUDGET');
    for await(const chunk of adapter.stream(options)){if(chunk.type==='usage')onUsage?.(chunk.usage);yield chunk;}}
 }
 const abort=()=>agent?.cancel({kind:'user'});
 try {
  ctx.llm.registerAdapter([model.provider],new Metered());
  for(const tool of tools) ctx.tools.register(tool);
  agent=await ctx.agentLoop.create(session.id,{provider:model.provider,model:model.model,maxTokens:4096},{cwd:workspace});
  signal.addEventListener('abort',abort,{once:true});signal.throwIfAborted();
  agent.followup(createUserMessage({content:[{type:'text',text:input}],source:{kind:'user'}}));
  await agent.whenIdle();signal.throwIfAborted();
  const events=agent.session.snapshotEvents();const end=events.findLast(e=>e.type==='turn/end');
  const last=events.findLast(e=>e.type==='assistant/message');
  const text=last?.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  if(!text||end?.data.reason.kind!=='completed'||last.data.interrupted||events.at(-1)?.type==='assistant/attempt')throw new Fault('MODEL_DID_NOT_FINISH');
  return text;
 }finally{signal.removeEventListener('abort',abort);await ctx.fiber.dispose();}
}

