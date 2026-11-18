"""Single approved tools/call to an administrator-configured stdio MCP server."""
import json, subprocess, sys
p = subprocess.Popen(json.loads(sys.argv[1]), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def send(value):
    p.stdin.write(json.dumps({'jsonrpc':'2.0', **value})+'\n')
    p.stdin.flush()
def rpc(i, method, params):
    send({'id':i,'method':method,'params':params})
    for line in p.stdout:
        msg=json.loads(line)
        if msg.get('id') == i:
            if 'error' in msg: raise RuntimeError('MCP request rejected')
            return msg['result']
    raise RuntimeError('MCP disconnected')
rpc(1,'initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'agent-us','version':'1'}})
send({'method':'notifications/initialized'})
print(json.dumps(rpc(2,'tools/call',{'name':sys.argv[2],'arguments':json.loads(sys.argv[3])})))
p.terminate()
