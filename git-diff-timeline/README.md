# git-diff-timeline

A Claude Code mod that puts a Git Diff timeline above the prompt.

- **History:** a range slider over the branch's commits (first parent, so a merged pull request is one commit). A pill on top sums up the comparison; the track is labelled with each day and the two ends. Under the card, one row picks what to compare:
  - **From** and **To** list the commits by message and day, merges by their pull or merge request title. Pick a To to see that commit on its own; pick a From too to compare a range.
  - **‹ Older** and **Newer ›** move the comparison one commit at a time, and the track follows it. Past the oldest commit loaded, Older reads 60 more, up to 600. The app gives a mod no mouse drag or wheel, so these are buttons.
  - **Branch** shows the history of any local or remote branch. It is read in place: nothing is checked out and your files do not change.
- **Branches:** compare two branches the way a pull request would (`base...compare`): commits ahead and behind, where they split, and what the compare branch adds.
- **Remote branches:** `origin/main` is this computer's copy of the server's `main` as of the last fetch. Git never updates it by itself, so it is not live data. While a remote branch is in view, the strip says how long ago the last fetch was (a warning after a day) and has a **Fetch** button that runs `git fetch --all --prune` and tells what moved. The mod never fetches on its own.
- **View diff:** a side panel listing the compared commits and each changed file, with its diff. Picking opens it.

It reads local git, and touches the network only when you press Fetch, so it works with GitHub, GitLab or any other remote. On the desktop the card is light, and dark when the app is; on the terminal the slider is drawn in text.

## Install

Load the folder as a plugin directory, for every session, through the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/git-diff-timeline",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

Or for one session: `claude --plugin-dir /path/to/git-diff-timeline`.

`/gitdiff` opens the files view. The `position` option (`band` or `pane`) chooses between the strip above the prompt and a side pane.

## Test

```bash
claude plugin test .
claude plugin validate .
```
