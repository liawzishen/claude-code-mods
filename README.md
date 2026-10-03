# claude-code-mods

Mods that change Claude Code's UI, in the terminal and the desktop app's Code tab. Each folder is one mod: a plugin of function hooks.

| Mod | What it does |
| --- | --- |
| [`git-diff-timeline`](git-diff-timeline) | A Git Diff timeline above the prompt. Click one commit to see it or two to compare them, with their commit messages. A Branches tab compares two branches. A GitHub-style "Files changed" panel shows each file's diff. |
| [`session-status`](session-status) | A status line with the session's time, prompts and tool calls. |

## Use them

To load mods in every session, list their folders in the `env` block of `~/.claude/settings.json`. Separate the paths with `;` on Windows and `:` elsewhere:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\claude-code-mods\\git-diff-timeline;C:\\path\\to\\claude-code-mods\\session-status",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

A session reads this when it starts. With `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`, open sessions reload a mod when its files change.

To load a mod for one session only: `claude --plugin-dir ./git-diff-timeline`.

## Make a new mod

```
my-mod/
  .claude-plugin/plugin.json   { "name": "my-mod", "version": "0.1.0", "description": "..." }
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           export const register: Register = (on, options) => { ... }
```

See [CLAUDE.md](CLAUDE.md) for the rules the engine holds mods to.

## Check a mod

```bash
claude plugin test ./git-diff-timeline
claude plugin validate ./git-diff-timeline
```
