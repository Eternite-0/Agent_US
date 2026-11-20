# AGENTS.md — Agent_US Workspace Guidelines

## Active Architecture
- Primary runtime is **Direct Multi-Turn Streaming Agent** (`backend/src/direct-agent.js`) backed by **AccountPool** (`backend/src/pool.js`), **Workspace Tools** (`backend/src/workspace-tools.js`), **Patch & Diagnostics** (`backend/src/patch-and-diagnostics.js`), **Context & Hooks** (`backend/src/agent-context.js`), **MCP Hub** (`backend/src/mcp-client.js`), and **CheckinService** (`backend/src/checkin.js`).
- Primary REST/SSE surface is `/v1/*` (`backend/src/v1-routes.js`). Legacy `/api/v1/*` DAG routes (`backend/src/routes.js`, `backend/src/engine.js`) remain mounted only for backward compatibility; do not introduce new DAG requirements into direct chat flows.

## Directory Boundaries
- Edit code inside `backend/`, `frontend/`, and `desktop/`.
- Do **not** read, edit, or search `upstream/` (archived external reference clones, git-ignored) or `backend/var/` (local SQLite databases, encryption keys, and `.provider-env.json` secrets).
- Never commit or log API keys, bearer tokens, or `.pool-key` / `.dev-token` contents.

## Conventions & Verification
- OS/Runtime: Windows, PowerShell 7, Node.js 24+ (ESM), TypeScript 5.9, Vite 6.
- Keep `DirectAgentRuntime` system prompt static across turns (session-pinned `nonce`; volatile workspace/git/date facts belong in the runtime context tail message to preserve Prompt Cache hits).
- Before finishing changes, run:
  - Backend: `cd backend && npm run check` plus relevant `node --test test/<suite>.test.js`.
  - Frontend: `cd frontend && npx tsc --noEmit && npm run build`.
  - Desktop: `node --check desktop/main.mjs`.
