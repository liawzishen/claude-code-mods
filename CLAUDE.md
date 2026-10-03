# Working on these mods

Each top-level folder is one Claude Code mod: a plugin whose hooks module exports `register(on, options)`.

## Shape of a mod

- `.claude-plugin/plugin.json`: name, version, description; `"types": "./types/index.d.ts"` when the mod keeps `$.state`; `userConfig` for options (git-diff-timeline's `position`: `band` | `pane`).
- `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`.
- `hooks/register.tsx`: `on(event, matcher?, hook)`, and every hook is `($, e, next)`. Return without `next` to answer the event yourself; `next(e)` passes it on.
- `types/index.d.ts`: the `$.state` contract, declared in `interface PluginState` under the mod's name.

## Rules the engine enforces

- The hooks module has no DOM and no Node. Reach everything through `$` (`$.process.run`, `$.fs`, `$.ui`, `$.state`, `$.clock`).
- `$` may only be passed to functions declared at the top level of the file. `claude plugin validate` refuses anything else.
- JSX compiles against the global `h`. Take elements from `$.ui.resolve(e)`: Box, Text, Button, Select, Code, Markdown, Link; `Svg` on desktop only; `Raster`/`Image` on the terminal only.
- `$.ui.resolve(e)` hands back every element name on every surface; one the surface lacks draws nothing. Choose elements by `e.surface`, never by `'Svg' in ui`.
- A `Select` takes 1 to 64 options. More, and the engine refuses the whole tree and draws its own, so the band vanishes: cut a long list (git-diff-timeline spreads 64 waypoints over a long history).
- A render hook never writes state. Write from a handler (`onPress`, `onSelect`) or another event with `update($, atom, fn)` from `claude-code`.
- Test files cannot import `node:*`. Mock git with a beneath hook: `on('process.run', (_$, e) => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }))`.

## The look

- Minimal first. Physical cues only where they help a control read as one: a recessed track, raised knobs, one light from above. No glows.
- One accent, Claude's own: the `claude` theme key on `Text`, `#d77757` in an `Svg`. Green and red only for lines added and removed.
- `Text` colours are theme keys (`claude`, `success`, `error`), not hex, so they follow the person's theme, the colour-blind ones included.
- An `Svg` card is light, and dark under `@media (prefers-color-scheme: dark)`: light colours as attributes, a class per role that the dark rules restyle (`git-diff-timeline/hooks/card.ts`).

## Git data

- `origin/*` branches are this computer's copy as of the last fetch, not live data. Say when that was.
- Never touch the network on a timer or a refresh. Only a person's press (the `Fetch` button) may run `git fetch`.
- Hand git a branch as its full ref (`refs/heads/x`) followed by `--`, so a branch name can be taken neither for an option nor for a file.

## What the desktop app does (tested 2026-10-03, engine 2.1.286)

- An `Svg` is drawn as an image and shows in the band above the prompt. Clicks on it go nowhere.
- A `Client` region gets no mouse events on desktop. Make things clickable with `Button` or `Select`.
- A pane opened from a person's press or command shows in the right side panel.

## Before you commit

```bash
claude plugin test ./<mod>
claude plugin validate ./<mod>
```

Commit with the GitHub noreply email: the account blocks pushes that expose a private address.
