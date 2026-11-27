# Browser security limits and privacy model

Pariksha uses standard browser APIs (`MediaDevices`, `MediaStreamTrack`, `Page Visibility`, `Fullscreen`, `Clipboard`, and scoped DOM mutation checks) to deter casual misconduct and record structured audit logs during online exams. Because the exam runs in a regular web browser rather than a kernel-level kiosk, administrators and instructors should understand what browser proctoring can and cannot prove.

## Technical limits of web-based proctoring

1. **Installed extensions cannot be listed**: Normal websites have no API to list installed or active browser extensions.
2. **Extension checks are heuristic**: Pariksha looks for known injected DOM elements and `chrome-extension://` or `moz-extension://` script tags. Accessibility tools, password managers, or grammar checkers can trigger these checks, so they default to `AUDIT_ONLY` with `HEURISTIC` confidence instead of automatic strikes.
3. **OS screen recording cannot be blocked**: A web page cannot detect or stop macOS, Windows, or Linux screen recorders, hardware capture cards, or virtual displays.
4. **Secondary devices are invisible**: Phones, tablets, printed notes, or a second laptop sitting next to the candidate cannot be detected from browser APIs.
5. **System shortcuts stay under OS control**: Browsers do not let websites block `Cmd+Tab`, `Alt+Tab`, Mission Control, Spotlight, or hardware media keys. We detect the resulting focus loss or fullscreen exit after the switch happens.
6. **Media state is reported by the client**: Track readiness (`live` vs `ended`), `displaySurface`, and permission state come from the candidate's browser and could be spoofed by a patched browser binary or virtual webcam driver.
7. **Active camera track does not verify identity**: Knowing that a video track is live confirms stream continuity in the browser, not who is sitting in front of the camera.
8. **Screen-share scope depends on user selection**: Even when an exam policy requires `MONITOR` (entire screen), multi-monitor setups or OS window pickers can leave secondary displays unshared.
9. **Benign notifications can blur the window**: Low-battery alerts, calendar popups, or OS permission prompts can trigger `WINDOW_BLUR`. Pariksha groups simultaneous tab-switch, blur, and fullscreen-exit signals inside a configurable deduplication window so one OS interruption does not burn multiple strikes.
10. **Unstable Wi-Fi can trigger missed heartbeats**: Brief network drops or laptop sleep cycles can exceed the heartbeat timeout without any intent to cheat. Grace windows and read-only instructor logs let staff review context before penalizing a student.
11. **Deterrence, not hardware isolation**: Keyboard and right-click blocks raise friction against copy-paste sharing, but anyone with local devtools or a modified client can bypass client-side JavaScript handlers. Server-side timers, question snapshots, and database triggers protect grading integrity regardless of client tampering.
12. **High-stakes exams need managed environments**: High-stakes certification or entrance exams should pair Pariksha with supervised computer labs or managed kiosk browsers.

## Privacy and data handling

- **No default video or audio recording**: Pariksha requests `{ video: true, audio: false }` and keeps webcam and screen-share `MediaStream` objects strictly inside browser memory for local preview and track-ended events. No video chunks, screenshots, or audio streams are uploaded or stored on the server.
- **No persistent browser storage for exam state**: Questions, draft answers, preflight tokens, CSRF tokens, and strike counts live only in React memory and PostgreSQL. Nothing is written to `localStorage`, `sessionStorage`, `IndexedDB`, or service worker caches, avoiding leftover exam data on shared lab machines.
- **Production block on unproctored dev mode**: The `allowUnproctoredDev` flag exists only for local development and automated Phase 4 tests. When `NODE_ENV=production`, the API rejects approving, configuring, or starting any exam with `allowUnproctoredDev` enabled (`403 UNPROCTORED_FORBIDDEN_IN_PRODUCTION`).
- **Spreadsheet formula escaping**: CSV exports of questions and integrity events prefix cells starting with `=`, `+`, `-`, `@`, tab, or carriage return with a single quote (`'`) so exported logs cannot trigger formula execution in Excel or Google Sheets.
