# Direct chat browser regression

From `frontend/` (Node 24+):

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The default suite starts Vite and a test-only loopback HTTP server. It answers the frontend's normal Direct REST routes and streams real `text/event-stream` frames over `/v1/stream` through the Vite proxy: durable events have sequence IDs and are replayable; assistant, reasoning, and tool-output deltas are ephemeral. The browser does not intercept requests, select demo mode, or inject React state. A test-only control endpoint advances the fixture after each observed UI checkpoint. All traffic and records are confined to the disposable test server.

| Case | Deterministic coverage |
| --- | --- |
| A | Live assistant growth follows the transcript tail; reasoning, nested live tool output and the durable final survive the handoff. |
| B | Focus and press Page Up with 24 historical turns; expanding and closing historical disclosures holds their viewport anchors. |
| C | Small (7 px) and normal (120 px) wheel deltas scroll a nested tool output away from its edges, and chain to the transcript at the top and bottom. |
| D | A 30-event SSE burst, a newer REST snapshot, and two older responses (one stale success, one failure) cannot replace the new turn or bleed across sessions. |
| E | Render 100 turns at desktop and narrow widths, use Home and End to reach the first and last turns, then Page Up and jump back to latest, and verify that the composer stays reachable. |

`E2E_PORT` overrides the default loopback Vite port `4179`. `E2E_CHROMIUM_PATH` can point at an installed Chromium executable. Playwright's normal arguments may be passed after `--`, for example `npm run test:e2e -- --grep 'D —'`. Failure screenshots and traces are temporary and disabled for the live provider suite. For Linux CI, install Chromium with `npx playwright install --with-deps chromium` before invoking the deterministic suite.

## Isolated Direct runtime regression

`npm run test:e2e:runtime` invokes the separate browser-runtime harness. It scripts the LLM separately from this suite while exercising authentic Direct HTTP/SSE and shell tools.

## Optional authenticated Direct provider run

Install backend dependencies separately (`npm ci` in `backend/`). Supply the following through your shell or secret manager, then run `npm run test:e2e:direct` from `frontend/`:

- `E2E_PROVIDER_ENDPOINT`: OpenAI-compatible base URL, including `/v1` where required.
- `E2E_PROVIDER_MODEL`: a model that can stream long answers and invoke a shell tool.
- `E2E_PROVIDER_API_KEY`: provider credential. Do not put it in a command line, file in the workspace, or CI logs.

Without all three variables this command explicitly skips. With them it boots the real Direct service with a fresh temporary `BACKEND_DATA` and empty workspace, a generated bearer token, and an explicitly registered provider. It asserts anonymous access is rejected and uses the Vite proxy to authenticate browser and test requests. No existing backend, pool data, or provider configuration is reused. Only this opt-in workflow sends the test prompts to the provider and can incur charges. The provider must produce the long responses and actually run the harmless `printf` tool call; the protocol suite has no such dependency. The external-provider run is a smoke test for live streaming, tail following, detached reading, durable final/tool output and session switching. Forced HTTP races and 100-turn stress coverage run deterministically above, not against an external provider.

## Before/after screenshot capture

Set `E2E_SCREENSHOT_DIR` to an absolute directory. This writes named PNGs at the same checkpoints as the assertions; it does not create tracked snapshots. For a baseline, archive the tracked frontend, desktop Vite helper, shared command parser, and root package manifest to a temporary location. From the repository root (POSIX example):

```sh
root="$(mktemp -d)"
root="$(cd "$root" && pwd -P)"
mkdir -p "$root/base"
git archive 82fb6f6 package.json frontend desktop backend/src/swarm/command.js | tar -xf - -C "$root/base"
npm --prefix "$root/base/frontend" ci
E2E_CAPTURE_BASELINE=1 E2E_FRONTEND_DIR="$root/base/frontend" \
  E2E_SCREENSHOT_DIR="$root/before-82fb6f6" npm --prefix frontend run test:e2e
E2E_SCREENSHOT_DIR="$root/after" npm --prefix frontend run test:e2e
```

Baseline capture checks that the app reaches each checkpoint but does not require the new behavior to pass. The default suite always enforces the regression assertions. Use the same browser and display scale for both captures.

## Isolated runtime and visual checks

- `npm run test:e2e:runtime` starts the **real** `DirectAgentRuntime`, Vite proxy, SQLite history and shell executor in a temporary workspace. The model adapter is scripted, so no provider is needed. The browser proves the first command is still the same DOM node, visible and expanded after a second actual command executes and the completed history arrives.
- `npm run test:e2e:visual` captures home, Markdown (table/quote/code/image), file changes with the Inspector open, pending approvals, Swarm and Reviewer. These are deterministic visual fixtures served/intercepted only by Playwright; they are **not** a live Swarm or provider validation. Supply `E2E_SCREENSHOT_DIR` to capture the current build, and repeat with the archived `E2E_FRONTEND_DIR` to capture the same baseline states.
- For Ubuntu run `npx playwright install --with-deps chromium`; for Windows run `npx playwright install chromium`. On both use Node 24, install backend and frontend dependencies, and run `npm run test:e2e`, `npm run test:e2e:runtime`, and `npm run test:e2e:visual` from `frontend/`. Small wheel deltas represent continuous scrolling in browser automation, not a physical touchpad test.
