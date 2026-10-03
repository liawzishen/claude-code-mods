# git-diff-timeline

A Claude Code mod that puts a Git Diff timeline above the prompt.

- **History:** a range slider over the branch's commits (first parent, so a merged pull request is one commit), with a bar for each commit's size. Click a commit to see its changes; click a second commit to compare the two. A pill on top sums up the pick; the commit messages being compared show under the timeline, with merges named by their pull or merge request title.
  - **Branch** shows the history of any local or remote branch. It is read in place: nothing is checked out and your files do not change.
  - **Scrolling:** ‹ and › page through the commits. **Go to** jumps to a commit (a long history is offered as 64 waypoints). At the oldest commit loaded, ‹ reads 60 older ones, up to 600. A small bar in the card's corner shows where the window sits. The app gives a mod no mouse drag or wheel, so the controls are buttons.
- **Branches:** compare two branches the way a pull request would (`base...compare`): commits ahead and behind, where they split, and what the compare branch adds.
- **Remote branches:** `origin/main` is this computer's copy of the server's `main` as of the last fetch. Git never updates it by itself, so it is not live data. The strip says when the last fetch was (a warning after a day) and has a **Fetch** button that runs `git fetch --all --prune` and tells what moved. The mod never fetches on its own.
- **Files changed:** a side panel listing the compared commits and each changed file, with its diff.

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
