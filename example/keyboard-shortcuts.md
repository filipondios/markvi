# Keyboard shortcuts

The reference card. Counts work like in Vim: `5j`, `3]]`, `2gt`, `10G`. A pending key is shown in the bottom status bar.

## The rendered view (this one)

| Key | Action |
| --- | ------ |
| `j` / `k` | Next / previous block |
| `Ctrl-d` / `Ctrl-u` | Half-page down / up |
| `gg` / `G` | Beginning / end of the document |
| `]]` / `[[` | Next / previous heading |
| `/` and `?` | Search within the document |
| `n` / `N` | Next / previous match |
| `f` | Follow a link with hints |
| `x` | Toggle the task at the cursor |
| `Ctrl-o` / `Ctrl-i` | Back / forward in history |
| `Ctrl-^` | Alternate with the previous file |
| `a` / `i` | Enter the editor at the current line |
| `:` | Open the command line |

## The leader key

`space` (or whatever `leader` is set to in `config.toml`) starts a sequence. Press it and wait ~300 ms to see the available continuations.

| Sequence | Action |
| -------- | ------ |
| `space` + `f` | Find a file (fuzzy); create it if nothing matches |
| `space` + `/` | Search text in all files |
| `space` + `r` | Recent files |
| `space` + `a` | Alternate file (same as `Ctrl-^`) |
| `space` + `t` | Table of contents |
| `space` + `b` | Backlinks to the current file |
| `space` + `x` | Close the active tab |

## Tabs

| Key | Action |
| --- | ------ |
| `gt` / `gT` | Next / previous tab (also works in the editor) |
| `{n}gt` | Go to tab n |

Browsers reserve `Ctrl-w` and `Ctrl-t` for themselves, which is why closing a tab lives behind `space` + `x`.

## The editor

It starts in Normal mode, like Vim. `a` / `i` start typing; `Esc` returns to Normal mode.

| Command | Action |
| ------- | ------ |
| `:w` | Save without exiting |
| `:wq`, `:x`, `ZZ` | Save and return to the view |
| `:q` | Back to the view if there are no changes; warns otherwise |
| `:q!`, `ZQ` | Discard changes and return to the view |
| `:e name` | Open another file |
| `:mv new-name` | Rename or move the current file |
| `:rm` | Delete the current file, with confirmation |
| `:set nu` / `:set nonu` | Absolute line numbers (on by default) |
| `:set rnu` / `:set nornu` | Relative line numbers |
| `:set so=N` | Lines kept around the cursor |
| `:config` | Show which configuration file is in use |

Try `:set rnu` here, then `5j`, then `:set nornu`.

> [!IMPORTANT]
> Mappings are customizable in `config.toml`: `[keymap.leader]` for the leader sequences, `[keymap.view]` to remap view keys, and `[keymap.normal]` / `[keymap.insert]` / `[keymap.visual]` for Vim-style mappings such as `jk = "<Esc>"`. See `example/config.toml` for a commented example.

Next: [[finding-files]] goes deeper into `:e`, `:mv` and `:rm`.
