# Wiki links

Wiki links connect notes by name, without paths or extensions. Try them with `f` (link hints) or by clicking.

## The basics

- [[index]] — opens a file by name, case-insensitive, extension optional.
- [[index|the tour]] — the text after `\|` replaces the label.
- [[keyboard-shortcuts#The editor]] — a section of another file.
- [[#The basics]] — a section of the current document.

## Paths

When several files share a name, a path suffix tells them apart (`[[folder/note]]`). Links inside code blocks and inline code are left alone, and `\[[` escapes one: \[[index]].

## Broken links

A link to a file that does not exist shows in red with a dashed underline. Click it (or follow it with `f`) and MarkVi offers to create the file next to the current one. Try it: [[practice-target]].

## Backlinks

`space` + `b` lists every line of every file that links here — both `[[wiki]]` links and ordinary relative links such as `[text](index.md)`. The list can be filtered; `Enter` opens the source file with the line highlighted.

This file is linked from [[index]], so it will appear in its backlinks.

> [!NOTE]
> Regular relative links work too: `[the index](index.md)` behaves like a wiki link inside the directory, and links can also point to images and other files, which are served from the same folder.

Next: [[render-extras]] — the final chapter.
