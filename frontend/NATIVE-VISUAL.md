# Native workspace visual spec

The transcript is the content surface. Assistant prose, the work log, and file changes do not each get a panel. User messages are right-aligned on a faint, small-radius background, without a border or shadow. The title bar, sidebar, and inspector are desktop chrome, separated from the transcript with single rules. The composer is a normal layout row below the scroller, not an overlay.

| Element | Treatment |
| --- | --- |
| Transcript | `--thread-content-max-width` (720 px); 14.5 px default assistant body with 1.65 line-height; adaptive gutters |
| Activity | 26 px minimum rows, 14 px icons, secondary text, monospace commands and paths; the disclosure marker stays beside its label; warning/error carry color |
| Command / code | 5 px inset; no exterior border/shadow; output scrolls independently and chains vertical scrolling to the transcript at its bounds |
| File changes | Flat list shown below the final response only after successful delivery; file names open Inspector; a separate disclosure opens the inline diff |
| Inputs | 8 px control / 10 px composer radius; borders imply editing, not elevation |
| Overlays | 8 px popover / 10 px dialog radius; only true overlays use `--shadow-popover` or `--shadow-dialog` |
| Motion | 150 ms interruptible height/opacity on explicit disclosure; progress uses a quiet opacity pulse; reduced-motion disables both |

Use the semantic colors in `src/styles/tokens.css` so equivalent surfaces look consistent in light, dark, and customized themes. Shared work-log and file-list styles belong to `src/components/activity-presentation.css`; workspace layout to `src/styles/codex.css`; keyframes to `src/styles/animations.css`. Keep presentation separate from stable operation IDs and disclosure state. Successful verification stays in receipts or Reviewer, not in a transcript badge; only actionable failures or reconciliation need an inline notice.

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

## iOS-inspired desktop interaction pass

This is a desktop design reference, not a phone layout. Use Apple's [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) and [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) guidance for brief, optional feedback. The [ChatGPT App Store listing](https://apps.apple.com/us/app/chatgpt/id6448311069) is a public visual reference; it does not establish the app's private UI implementation or exact animation curves.

| Interaction | Desktop treatment |
| --- | --- |
| Navigation / selected values | Low-intensity accent fill and readable text for workspace navigation, settings, Inspector, capability filters, and menu selection. |
| Press / focus | 90 ms button feedback; 0.96 scale only for small command buttons, with color-only feedback under Reduce Motion. Keyboard focus gets a high-contrast outline. |
| Popover / dialog | 150 ms anchored entry or 200 ms dialog entry; 110 ms quiet exit. A closing overlay stops receiving input immediately. Theme-aware opaque surfaces, no blur or heavy shadow. |
| Content / live work | Markdown prose stays unboxed. Only user-facing disclosure bodies interpolate their height. The transcript resolves its anchor immediately at each layout change; streamed output never starts a scroll animation or a new disclosure animation. OS and in-app reduced-motion settings stop decoration and the expandable sidebar transition. |
| Inspector | 200 ms width/opacity on drawer open and close, bypassed during resize. The active indicator follows tab selection; Arrow keys, Home/End, and Delete operate tabs. The tab menu restores focus on Escape. Unified, split and inline diffs emphasize changed text spans without modifying the line contents. |

Visual regression runs the same desktop routes in both themes, including the settings, search, scheduling dialog, capability and evaluation surfaces. Fixture screenshots establish layout, not completeness of real provider data. Browser tests also cover focus restoration from model selection and reduced-motion behavior independently of the operating system.
