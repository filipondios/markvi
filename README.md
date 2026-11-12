<p align="center">
  <img src="./public/img/logo-full.png" alt="opios" width="150">
</p>

<p align="center"><em>A local Markdown viewer and editor for your browser with Vim-style keybindings.</em></p>

## Usage

```
bun install
bun run server.ts ./example        # http://127.0.0.1:3000
bun run server.ts ~/notes -p 4000  # another directory and port
```

The app only listens on `127.0.0.1`. The directory is scanned for `.md` files, ignoring hidden files and other irrelevant entries.

## Keybindings

In the rendered view:

| Key                 | Action                           |
| ------------------- | -------------------------------- |
| `j` / `k`           | Next / previous block            |
| `Ctrl-d` / `Ctrl-u` | Half-page down / up              |
| `gg` / `G`          | Beginning / end of document      |
| `]]` / `[[`         | Next / previous heading          |
| `/` / `?`           | Search within the document       |
| `n` / `N`           | Next / previous match            |
| `f`                 | Follow a link using hints        |
| `gt` / `gT`         | Next / previous tab              |
| `{n}gt`             | Go to tab n                      |
| `Ctrl-o` / `Ctrl-i` | Back / forward in history        |
| `:`                 | Command (`:e`, `:q`, `:w`)       |
| `a` / `i`           | Enter the editor in Normal mode  |
| `space` + `f`       | Search files                     |
| `space` + `t`       | Document table of contents (TOC) |
| `space` + `x`       | Close the active tab             |

Counts work just like in Vim: `5j`, `3]]`, `2gt`, `10G`. The pending key is displayed in the bottom status bar. Pressing `space` and waiting about 300 ms opens a panel showing the available continuations.

## Document Table of Contents

`space` + `t` opens the document heading index, featuring fuzzy search and a section preview. Pressing `Enter` scrolls the view to the selected heading; in the editor, it moves the cursor to that heading's line. It works both in the rendered view and in the editor's Normal mode.

## Vim Editor

The editor starts in Normal mode. To type, press `a` / `i` again (or `o`, `O`, etc.) once inside the editor, just like in Vim. `Esc` only returns to Normal mode.

`a` / `i` open the editor at the line currently being viewed (or at the selected text, if there is a selection). Double-clicking a block opens the editor at that block's corresponding line. When you exit, the view returns to the block at that line.

Saving is only available through ex commands: `:w`, `:wq`, `:x`, or `ZZ`.

| Command                   | Action                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `:w`                      | Save without exiting                                                                                  |
| `:wq`, `:x`, `ZZ`         | Save and return to the rendered view                                                                  |
| `:q`                      | Return to the rendered view if there are no changes; otherwise, show a warning and stay in the editor |
| `:q!`, `ZQ`               | Discard changes and return to the rendered view                                                       |
| `:set nu` / `:set nonu`   | Absolute line numbers (enabled by default)                                                            |
| `:set rnu` / `:set nornu` | Relative line numbers (disabled by default)                                                           |
| `:set so=N`               | Number of visible lines around the cursor (default: `0`)                                              |

Exiting the editor always returns to the rendered view of the same tab: `:q` never closes a tab. To close a tab, use `space` + `x`.

With line wrapping enabled, `j` / `k` move by screen lines in Normal and Visual modes. When used with an operator (`dj`, `yk`), they operate on logical file lines instead. `gt` / `gT` also switch tabs from Normal mode. The default register is internal to the editor, not the system clipboard.

The browser reserves `Ctrl+W`, `Ctrl+T`, and `Ctrl+N` for its own actions (close tab, open tab, and new window), so these shortcuts cannot be used as they would be in Vim.

## Live Reload and Conflicts

The server watches the directory using `fs.watch` and sends notifications over SSE. If a file changes on disk and there are no local edits, the tab reloads automatically. If there is an unsaved draft, the bottom status bar displays a conflict notification with options to reload or overwrite the file.

Saves use `ETag`/`If-Match`: if the file changes between reading and saving, the server responds with `409` instead of overwriting someone else's changes.

## Build as a Command-Line Tool

```
bun run build # generates dist/markvi
install -m 755 dist/markvi ~/.local/bin/markvi
markvi ~/notes # replace notes with your directory
```

The binary bundles the frontend and does not require `bun` to be installed at runtime.

## Licenses

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for the full license text.

The interface uses **Obel Mono 1.003** (© 2026 The Obel Mono Project Authors, authored by Cody Collier), self-hosted in `public/fonts/` under the [SIL Open Font License 1.1](public/fonts/OFL,txt). The full license text is available in `public/fonts/OFL.txt`, and the authors are listed in `public/fonts/AUTHORS.txt`.
