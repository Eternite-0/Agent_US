# Native workspace visual spec

The transcript is the content surface. Assistant prose, the work log, and file changes do not each get a panel. User messages have right alignment and a short end rule instead of a bubble. The title bar, sidebar, and inspector are desktop chrome, separated from the transcript with single rules. The composer is a normal layout row below the scroller, not an overlay.

| Element | Treatment |
| --- | --- |
| Transcript | `--thread-content-max-width` (704 px); 15 px assistant body with 1.68 line-height; adaptive gutters |
| Activity | 28 px minimum rows, 14 px icons, secondary text, monospace commands and paths; hover/focus only; warning/error carry color |
| Command / code | 5 px inset; no exterior border/shadow; output scrolls independently and chains vertical scrolling to the transcript at its bounds |
| File changes | Flat list with a single divider at each boundary; file names open Inspector; a separate disclosure opens the inline diff |
| Inputs | 8 px control / 10 px composer radius; borders imply editing, not elevation |
| Overlays | 8 px popover / 10 px dialog radius; only true overlays use `--shadow-popover` or `--shadow-dialog` |
| Motion | 150 ms opacity transition on detail reveal; progress uses a quiet opacity pulse; reduced-motion disables both |

Use the semantic colors in `src/styles/tokens.css` so equivalent surfaces look consistent in light, dark, and customized themes. Shared work-log and file-list styles belong to `src/components/activity-presentation.css`; workspace layout to `src/styles/codex.css`; keyframes to `src/styles/animations.css`. Keep presentation separate from stable operation IDs and disclosure state.

## References reviewed

- `Ninot1Quyi/chatgpt-desktop-community` (`db8ff5b`): `modules/conversations/renderer/{Conversation.jsx,items.jsx,Composer.jsx,styles.css}` and `renderer/src/theme.css` — user/assistant alignment, collapsible work logs, composer hierarchy, and secondary text.
- `openai/codex` (`0c7efeb`): `codex-rs/tui/src/exec_cell/render.rs`, `history_cell/`, and `chatwidget/` — succinct execution summaries and separation of output from status. This is public TUI source, not Codex Desktop CSS.

## Reproduce the checks

```sh
npx playwright install chromium
npm run test:e2e
npm run test:e2e:runtime
E2E_SCREENSHOT_DIR=/absolute/path/to/after npm run test:e2e:visual
```

Run these commands from `frontend/`. The visual suite captures the running app against a deterministic test API in light/dark at 1440×960, 1280×800, and 780×650, with layout assertions for the native presentation. The runtime suite separately tests the real Direct backend, terminal execution, streamed updates, and Prompt Cache with a scripted upstream model response. Neither suite substitutes fixtures into the production app.

For a before comparison, set `E2E_FRONTEND_DIR` to the absolute, symlink-resolved `frontend/` path of a separate worktree of `f79e164a24f1848e51ef7b4b03b69c4d68fcd0f9` with dependencies installed, and point `E2E_SCREENSHOT_DIR` at a different destination. Baseline mode tests the same input without imposing new visual requirements. `E2E_VISUAL_PORT` allows two runs without a port conflict.
