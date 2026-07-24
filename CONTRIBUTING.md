# Contributing to ttracker

Thanks for your interest in contributing! ttracker is a small, focused tool and contributions are welcome.

## How to contribute

1. **Fork** the repo
2. **Create a branch** for your change
3. **Make your changes** and test them locally
4. **Open a pull request** against `main`

All PRs require review and approval before merging.

## What to work on

- Check the [open issues](https://github.com/sharon-fdm/ttracker/issues) for ideas
- Bug fixes are always welcome
- New features should be discussed in an issue first

## Guidelines

- **Zero dependencies.** ttracker uses only Node.js built-in modules. Do not add npm dependencies.
- **Single file server.** The dashboard, API, and server all live in `server.js`. Keep it that way.
- **macOS + iTerm2.** This tool is macOS-only by design (AppleScript, iTerm2 API). Cross-platform is out of scope.
- **Solarized palette.** All UI colors must come from the [solarized color scheme](https://ethanschoonover.com/solarized/). Both light and dark modes must work.
- **Keep it simple.** This is a personal productivity tool, not enterprise software. Prefer straightforward solutions.

## Testing

Run the server and test manually:

```bash
node server.js
# Open http://localhost:3847
```

There is no automated test suite (yet). Test your changes by using the dashboard.

## Code style

- Standard JavaScript (no TypeScript, no transpilation)
- Inline HTML in template literals
- CSS variables for theming
- AppleScript via `osascript` for iTerm2 interaction

## Questions?

Open an issue and ask.
