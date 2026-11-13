---
title: Welcome to MarkVi
tags: [guide, index]
---

# Welcome to MarkVi

This directory is a guided tour. Every file is both documentation and a live demo: what you are reading is rendered Markdown, and pressing `a` or `i` opens the editor at this very line so you can see the source behind it. Press `:wq` afterwards to save, or `:q!` to discard your experiment.

Press `space` and wait a moment: a panel lists every shortcut available after the leader key.

## The tour

| File | What it covers |
| ---- | -------------- |
| [[markdown-basics]] | Markdown you can try: headings, lists, tasks, tables, code |
| [[keyboard-shortcuts]] | Every keybinding of the view and the editor |
| [[finding-files]] | Opening, creating, renaming and deleting files |
| [[wiki-links]] | `[[Note]]` links, sections and backlinks |
| [[render-extras]] | Footnotes, GitHub alerts and front matter |

## Five things to try right now

1. `j` / `k` move block by block; `Ctrl-d` / `Ctrl-u` jump half a page; `gg` and `G` go to the ends.
2. `]]` / `[[` jump to the next / previous heading. With a count, `3]]` repeats it.
3. `f` shows hints over every link: press one to follow it.
4. `space` + `t` opens the table of contents of this document.
5. `:` opens a command line. Type `:e finding-files` and press `Enter` to open the next chapter.

> [!TIP]
> Everything is local: the server only reads the directory you gave it. Close the browser whenever you like; your notes are plain `.md` files on disk.

---

*MarkVi — a local Markdown viewer and editor with Vim-style keybindings.*
