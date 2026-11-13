# Markdown basics

Everything you see here is plain Markdown. Open the editor with `a` (or `i`) to study the source, then press `Esc` and `:q!` to leave without saving.

## Emphasis

*Italic*, **bold**, ***both***, ~~strikethrough~~ and `inline code`. Combine them freely.

## Lists

- Unordered items
  - Nested items indent with two spaces
- [ ] An unchecked task
- [x] A checked task — press `x` on it to toggle right from the view

1. Ordered lists
2. Number themselves

## Quotes

> A blockquote holds anything you like.
>
> > And quotes can nest.

## Tables

| Syntax | Result |
| ------ | ------ |
| `\| a \| b \|` | a two-column row |
| `---` under the header | turns text into a table |

Alignment can be forced with `:---`, `:---:` or `---:`.

## Code

Inline: `const x = 1`.

A fenced block with a language gets syntax highlighting:

```javascript
// Press j and k: each block highlights in turn as the reading cursor.
function greet(name) {
  return `Hello, ${name}!`;
}
```

## Separators

---

`---` alone is a horizontal rule. Three or more of `-`, `*` or `_` all work.

> [!NOTE]
> After editing, saving is only available through the command line: `:w` saves without leaving, `:wq` (or `ZZ`) saves and returns to this view.

Next: [[keyboard-shortcuts]] collects every keybinding in one place.
