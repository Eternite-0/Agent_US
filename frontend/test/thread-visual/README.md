# Native thread visual regression

The workspace, transcript and composer use a shared neutral document plane. The sidebar and title bar share the chrome plane; the Inspector is a split pane (an overlay only when width requires it). Ordinary prose, activity rows, and file rows have no shadow or enclosing card. Use `tokens.css` for typography, color, focus, and spacing: use the small inset radius/surface only for terminal text, code, and diff previews; reserve elevation for floating UI.

- The composer owns its own row, never a position over the transcript. Its surface matches the thread, with a single edge and compact controls. Cache telemetry stays on the auxiliary text line.
- Direct and Swarm use the same compact operation row. Status and elapsed time are secondary; failure or approval can use semantic color. Only the running indicator pulses. Terminal expansion fades in without animating its dimensions.
- Expanded terminal output has its own scrollport and remains selectable and copyable. Vertical scroll chaining is native. Files stay available through the Inspector while work is in progress; the transcript delivery list appears below the final reply after successful completion.
- Dark mode uses the same layout and hierarchy, not a second set of component rules. No added blur, glow, or static shadow on transcript content.

## Capture the same scenes on two revisions

Install the frontend dependencies on both revisions. Use the **current** test driver for both capture runs so the viewport, test data, and actions are identical. From the current frontend directory:

```sh
npx playwright install chromium
E2E_FRONTEND_DIR=/absolute/path/to/baseline-worktree/frontend \
  E2E_VISUAL_PORT=4184 E2E_SCREENSHOT_DIR=/tmp/thread-visual/before \
  npm run test:e2e:visual
E2E_SCREENSHOT_DIR=/tmp/thread-visual/after npm run test:e2e:visual
```

The captures are Playwright screenshots of the actual running frontend. Deterministic API fixtures exist only in the test driver. The browser-runtime suite separately exercises the actual Direct backend and terminal execution through a scripted provider, and the SSE suite exercises scrolling, persistent disclosure, and delivery timing. Neither suite replaces production data.

The visual driver records both themes at 1440×960, 1280×800, and 780×650. It covers home, Direct prose, five operations, short and long terminal output, Markdown, the inline diff, the Inspector diff, approval, Swarm, and expanded Reviewer evidence.
