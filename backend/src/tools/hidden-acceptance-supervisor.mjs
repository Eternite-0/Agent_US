import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ENVELOPE_BEGIN = '<<<AGENT_US_HIDDEN_ENVELOPE_V1>>>';
const ENVELOPE_END = '<<<END_AGENT_US_HIDDEN_ENVELOPE_V1>>>';
const SCHEMA_VERSION = 1;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function readSecretFromStdin() {
  const raw = readFileSync(0, 'utf8').trim();
  if (!raw) {
    throw new Error('Supervisor did not receive HMAC key payload on stdin');
  }
  const parsed = JSON.parse(raw);
  if (!parsed?.hmacKey || !parsed?.envelopeNonce) {
    throw new Error('Invalid supervisor stdin secret payload');
  }
  return {
    hmacKey: String(parsed.hmacKey),
    envelopeNonce: String(parsed.envelopeNonce),
  };
}

function buildSanitizedWorkerEnv(sourceEnv, extraAllowKeys = []) {
  const env = {};
  const allowKeys = [
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'PATHEXT',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'HOME',
    'USERPROFILE',
    'TMP',
    'TEMP',
    'TMPDIR',
    'APPDATA',
    'LOCALAPPDATA',
    'TZ',
    'LANG',
    'LC_ALL',
    'NODE_ENV',
    'CI',
    'WORKSPACE_ROOT',
    'AGENT_US_WORKSPACE_ROOT',
    'AGENT_US_EVAL_WORKSPACE',
    'HOST_CANARY_PATH',
    'NO_PROXY',
    'no_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NPM_CONFIG_OFFLINE',
    'NPM_CONFIG_AUDIT',
    'NPM_CONFIG_FUND',
    'NPM_CONFIG_IGNORE_SCRIPTS',
    'NPM_CONFIG_UPDATE_NOTIFIER',
    'GIT_TERMINAL_PROMPT',
    'GIT_CONFIG_NOSYSTEM',
    'PYTHONDONTWRITEBYTECODE',
    'PIP_NO_INDEX',
    'PIP_DISABLE_PIP_VERSION_CHECK',
  ];
  for (const key of allowKeys) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  const blockedUpper = new Set([
    'NODE_OPTIONS',
    'AGENT_US_SANDBOX_CONFIG',
    'AGENT_US_HIDDEN_HMAC_KEY',
  ]);
  const sensitiveRe = /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|AUTH|COOKIE|BEARER|SIGNING_KEY)/i;
  if (Array.isArray(extraAllowKeys)) {
    for (const rawKey of extraAllowKeys) {
      const key = String(rawKey ?? '');
      if (!key || blockedUpper.has(key.toUpperCase()) || sensitiveRe.test(key)) continue;
      if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
    }
  }
  return env;
}

function killWorkerTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

async function runSingleWorker({
  workerPath,
  suitePath,
  suiteSha256,
  expectedTest,
  expectedCount,
  workerEnv,
  timeoutMs,
  childExecArgv,
}) {
  const testToken = randomBytes(24).toString('hex');
  return new Promise((resolveWorker) => {
    const child = spawn(process.execPath, [...childExecArgv, workerPath], {
      cwd: process.cwd(),
      env: workerEnv,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let stdoutAcc = '';
    let stderrAcc = '';
    let startMsg = null;
    let endMsg = null;
    let tamperingDetected = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killWorkerTree(child);
    }, Math.max(500, timeoutMs));

    const inspectChunk = (chunkText) => {
      if (chunkText.includes(ENVELOPE_BEGIN) || chunkText.includes(ENVELOPE_END)) {
        tamperingDetected = true;
      }
    };

    child.stdout?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (stdoutAcc.length < 256 * 1024) stdoutAcc += text;
      inspectChunk(text);
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (stderrAcc.length < 256 * 1024) stderrAcc += text;
      inspectChunk(text);
      process.stderr.write(text);
    });

    let initSent = false;
    const sendInit = () => {
      if (initSent) return;
      initSent = true;
      try {
        child.send({
          type: 'init',
          suitePath,
          suiteSha256,
          targetIndex: expectedTest.index,
          targetId: expectedTest.id,
          targetName: expectedTest.name,
          minAssertions: expectedTest.minAssertions ?? 1,
          expectedCount: expectedCount ?? 1,
          testToken,
        });
      } catch {
        tamperingDetected = true;
        killWorkerTree(child);
      }
    };

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'worker_ready') {
        sendInit();
        return;
      }
      if (msg.testToken !== testToken) {
        tamperingDetected = true;
        return;
      }
      if (msg.type === 'test_start' && !startMsg) {
        startMsg = msg;
      } else if (msg.type === 'test_end' && !endMsg) {
        endMsg = msg;
      } else if (msg.type === 'test_end') {
        tamperingDetected = true;
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWorker({
        index: expectedTest.index,
        id: expectedTest.id,
        name: expectedTest.name,
        started: Boolean(startMsg),
        completed: false,
        passed: false,
        skipped: false,
        todo: false,
        prematureExit: true,
        tamperingDetected,
        assertionCount: 0,
        workerExitCode: 1,
        workerSignal: null,
        reason: 'worker_spawn_error',
        error: err?.message ?? String(err),
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (
        stdoutAcc.includes(ENVELOPE_BEGIN) ||
        stdoutAcc.includes(ENVELOPE_END) ||
        stderrAcc.includes(ENVELOPE_BEGIN) ||
        stderrAcc.includes(ENVELOPE_END)
      ) {
        tamperingDetected = true;
      }

      const missingCompletion = !endMsg || endMsg.completed !== true;
      const prematureExit = missingCompletion && !timedOut;
      const skipped = Boolean(endMsg?.skipped);
      const todo = Boolean(endMsg?.todo);
      const assertionCount = Number.isInteger(endMsg?.assertionCount) ? endMsg.assertionCount : 0;
      const minAssertions = Number.isInteger(expectedTest.minAssertions)
        ? expectedTest.minAssertions
        : 1;
      const exitCode = code ?? 1;

      const passed =
        !tamperingDetected &&
        !timedOut &&
        !missingCompletion &&
        !skipped &&
        !todo &&
        Boolean(startMsg) &&
        Boolean(endMsg?.passed) &&
        exitCode === 0 &&
        signal == null &&
        assertionCount >= minAssertions;

      let reason = 'passed';
      if (tamperingDetected || endMsg?.tamperingDetected) reason = 'tampering_detected';
      else if (timedOut) reason = 'worker_timeout';
      else if (prematureExit) reason = 'premature_exit_before_completion';
      else if (skipped || todo) reason = 'skipped_or_todo_test';
      else if (assertionCount < minAssertions) reason = 'insufficient_assertions';
      else if (signal != null) reason = `worker_signal_${signal}`;
      else if (!passed) reason = endMsg?.reason ?? 'assertion_failed';

      resolveWorker({
        index: expectedTest.index,
        id: expectedTest.id,
        name: expectedTest.name,
        started: Boolean(startMsg),
        completed: Boolean(endMsg?.completed) && !timedOut && !prematureExit,
        passed,
        skipped,
        todo,
        prematureExit,
        tamperingDetected: Boolean(tamperingDetected || endMsg?.tamperingDetected),
        assertionCount,
        workerExitCode: exitCode,
        workerSignal: signal ?? null,
        durationMs: endMsg?.durationMs ?? null,
        reason,
        error: endMsg?.error ?? (passed ? null : reason),
      });
    });
  });
}

async function main() {
  const { hmacKey, envelopeNonce } = readSecretFromStdin();
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error('Usage: hidden-acceptance-supervisor.mjs <manifest.json>');
  }

  const dir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const suitePath = join(dir, manifest.suiteFile);
  const workerPath = join(dir, manifest.workerFile);

  const actualSuiteSha = sha256Hex(readFileSync(suitePath));
  const actualWorkerSha = sha256Hex(readFileSync(workerPath));
  let integrityTampered =
    actualSuiteSha !== manifest.suiteSha256 || actualWorkerSha !== manifest.workerSha256;

  const expectedTests = Array.isArray(manifest.expectedTests) ? manifest.expectedTests : [];
  const childExecArgv = Array.isArray(manifest.childExecArgv) ? manifest.childExecArgv : [];
  const extraEnvKeys = Array.isArray(manifest.extraEnvKeys) ? manifest.extraEnvKeys : [];
  const workerEnv = buildSanitizedWorkerEnv(process.env, extraEnvKeys);
  if (typeof manifest.workerSandboxConfigJson === 'string' && manifest.workerSandboxConfigJson) {
    workerEnv.AGENT_US_SANDBOX_CONFIG = manifest.workerSandboxConfigJson;
  }
  const perTestTimeoutMs = Number(manifest.perTestTimeoutMs || manifest.timeoutMs || 25000);

  const results = [];
  if (!integrityTampered) {
    for (const expTest of expectedTests) {
      const record = await runSingleWorker({
        workerPath,
        suitePath,
        suiteSha256: manifest.suiteSha256,
        expectedTest: expTest,
        expectedCount: expectedTests.length,
        workerEnv,
        timeoutMs: perTestTimeoutMs,
        childExecArgv,
      });
      if (record.tamperingDetected) integrityTampered = true;
      results.push(record);
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const todoCount = results.filter((r) => r.todo).length;
  const allPassed =
    !integrityTampered &&
    expectedTests.length > 0 &&
    results.length === expectedTests.length &&
    passedCount === expectedTests.length &&
    failedCount === 0 &&
    skippedCount === 0 &&
    todoCount === 0;

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    envelopeNonce,
    sessionNonce: manifest.sessionNonce,
    taskId: manifest.taskId,
    attemptId: manifest.attemptId,
    artifactDigest: manifest.artifactDigest,
    suiteSha256: actualSuiteSha,
    workerSha256: actualWorkerSha,
    started: true,
    completed: true,
    tamperingDetected: integrityTampered,
    expectedCount: expectedTests.length,
    executedCount: results.length,
    passedCount,
    failedCount,
    skippedCount,
    todoCount,
    tests: results,
  };

  const signature = createHmac('sha256', hmacKey)
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');

  const envelope = {
    payload,
    algorithm: 'hmac-sha256',
    signature,
  };

  process.stdout.write(
    `\n${ENVELOPE_BEGIN}\n${JSON.stringify(envelope)}\n${ENVELOPE_END}\n`,
  );

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exit(1);
});
