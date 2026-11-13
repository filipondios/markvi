# Finding and managing files

Everything happens inside the directory the server was started with. Try each command from here; `:q!` undoes nothing on disk, so for `:rm` practice you may want to copy this folder first.

## Opening files

- `space` + `f` — the file finder: type a few letters, `↑↓` to choose, `Enter` to open.
- `:e name` — from the command line. Without `.md`, the name is matched fuzzily. `:e todo` may open `todo-list.md` if it is the only match.
- `:e name.md` — exact: `:e notes/new.md` always creates the file when it is missing.

New files always get the `.md` extension, live inside the directory, and are never hidden files.

## The alternate file

`Ctrl-^` (or `space` + `a`) jumps back to the previously opened file — press it again to bounce between two files like in Vim.

## Renaming and deleting

| Command | Notes |
| ------- | ----- |
| `:mv new-name` | Rename or move the current file; save your changes first (`:w`) |
| `:rm` | Deletes after a confirmation |
| `:rm!` | Deletes without asking, ignoring external changes on disk |

> [!CAUTION]
> Renaming a file does not rewrite links that point to it. If other notes link here with a wiki link, update them by hand.

## Full-text search

`space` + `/` searches the text of every Markdown file at once. Results appear live as you type; a preview highlights the matching block, and `Enter` opens the file right at that line.

## Multiple tabs

Open several files (`space` + `f` again) and move between them with `gt` / `gT` or `{n}gt` for a specific one. `space` + `x` closes the active tab.

> [!TIP]
> The file finder doubles as a creator: type a name that does not exist, and the finder offers to create it.

Next: [[wiki-links]] shows the fastest way to connect notes.
