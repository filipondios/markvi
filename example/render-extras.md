---
title: Rendering extras
---

# Rendering extras

Three extras are enabled by default. Press `a` on this file: the YAML block at the top is the front matter — visible while editing, hidden in this view.

## Footnotes

A reference in the text[^gfm] and its definition, which may live anywhere in the file[^anywhere].

[^gfm]: GFM = GitHub Flavored Markdown, the dialect MarkVi follows here.
[^anywhere]: Most writers keep the definitions at the bottom of the file.

## GitHub alerts

Alerts are blockquotes whose first line names a type:

> [!NOTE]
> Highlights information the user should take into account, even if skimming.

> [!TIP]
> Helpful advice for doing things better or more easily.

> [!IMPORTANT]
> Crucial information necessary for users to succeed.

> [!WARNING]
> Urgent content that needs immediate user attention to avoid problems.

> [!CAUTION]
> Negative potential consequences of an action.

The marker line disappears; the rest of the blockquote stays as body text. An alert can hold lists, code and several paragraphs.

## Front matter

```yaml
---
title: Rendering extras
---
```

Keys and values are yours to choose: titles, tags, dates. MarkVi does not interpret them; it only keeps them out of the reading view so documents start clean at the first heading.

> [!TIP]
> A file that starts with `---` but never closes it keeps rendering as a horizontal rule — no configuration needed.

That is the end of the tour. Go back to [[index]], or start your own note with `:e my-first-note.md`.
