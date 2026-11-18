# Input and output are data, never host paths. The outer container owns the hard deadline.
import base64, json, os, pathlib, stat, subprocess, sys

work = pathlib.Path('/work')
request = json.load(sys.stdin)
for name, encoded in request['files'].items():
    path = work / name
    if not path.resolve().is_relative_to(work) or path == work:
        raise ValueError('bad input path')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(encoded, validate=True))

os.makedirs('/tmp/codex', exist_ok=True)
proc = subprocess.Popen(['/usr/local/bin/codex', 'app-server', '--listen', 'stdio://'],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def send(message):
    proc.stdin.write(json.dumps(message) + '\n')
    proc.stdin.flush()

streamed = {'stdout': bytearray(), 'stderr': bytearray()}
def rpc(i, method, params):
    send({'id': i, 'method': method, 'params': params})
    for line in proc.stdout:
        item = json.loads(line)
        if item.get('method') == 'command/exec/outputDelta':
            params=item['params']; key=params['stream']; target=streamed[key]
            target.extend(base64.b64decode(params['deltaBase64'])[:max(0,8192-len(target))])
        if item.get('id') == i:
            if 'error' in item:
                raise RuntimeError(method + ': ' + str(item['error'])[:500])
            return item['result']
    raise RuntimeError('codex disconnected')

rpc(1, 'initialize', {'clientInfo': {'name': 'agent_us', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
send({'method': 'initialized', 'params': {}})
# The worker boundary is the outer read-only, networkless container. Codex only executes commands.
result = rpc(2, 'command/exec', {'command': request['argv'], 'cwd': '/work', 'processId':'tool',
             'tty': request.get('tty',False), 'timeoutMs': 8000, 'outputBytesCap': 8192,
             'sandboxPolicy': {'type':'dangerFullAccess'}})
proc.terminate()
files = {}
total = 0
for path in work.rglob('*'):
    mode = path.lstat().st_mode
    if stat.S_ISDIR(mode):
        continue
    if not stat.S_ISREG(mode) or path.stat().st_size > 65536 or len(files) >= 64:
        raise ValueError('unsupported artifact')
    data = path.read_bytes()
    total += len(data)
    if total > 262144:
        raise ValueError('workspace limit')
    files[str(path.relative_to(work))] = base64.b64encode(data).decode()
print(json.dumps({'exitCode':result['exitCode'], 'stdout':(result['stdout'] or streamed['stdout'].decode(errors='replace'))[:8192], 'stderr':(result['stderr'] or streamed['stderr'].decode(errors='replace'))[:8192], 'files': files}))
