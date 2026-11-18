import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {docker} from './docker.js';
import {id,Fault} from './store.js';
export class Magpie {
 constructor(providers){this.providers=providers;this.name='agent-magpie-'+id();this.token=randomBytes(32).toString('hex');}
 async start(){if(this.child&&await this.healthy())return;await this.stop();
  const child=spawn('docker',['run','--rm','-i','--pull=never','--name',this.name,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=128','--memory=384m','--tmpfs','/tmp:rw,nosuid,nodev,size=96m,mode=1777','-p','127.0.0.1::3426','agent-us/magpie:v0.1.4490'],{stdio:['pipe','ignore','ignore'],windowsHide:true});this.child=child;
  child.stdin.on('error',()=>{});let failed=false;child.on('error',()=>{failed=true;});child.stdin.write(JSON.stringify({token:this.token,providers:this.providers})+'\n');
  for(let i=0;i<45&&!failed&&child.exitCode===null;i++){await delay(160);try{if(!this.base){const port=(await docker(['port',this.name,'3426/tcp'],{signal:AbortSignal.timeout(2000)})).trim().match(/^127\.0\.0\.1:(\d+)$/);if(port)this.base='http://127.0.0.1:'+port[1];}if(await this.healthy())return;}catch{}}
  await this.stop();throw new Fault('MAGPIE_UNAVAILABLE',503);
 }
 async healthy(){if(!this.base)return false;try{const res=await fetch(this.base+'/health',{headers:{Authorization:'Bearer '+this.token},signal:AbortSignal.timeout(1500)});return res.ok&&(await res.text()).includes('"magpie"');}catch{return false;}}
 async stop(){this.base=null;const child=this.child;if(!child)return;this.child=null;child.stdin.end();await docker(['rm','-f',this.name],{signal:AbortSignal.timeout(5000)}).catch(()=>{});child.kill();}
}
