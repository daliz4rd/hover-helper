# Hover Helper

**Hover over any piece of JavaScript to find out what it's called and what it does.**

When you're new to programming, a line like `const re = new RegExp("ab+c");` is a wall of symbols. Syntax highlighting helps, but only if it's available *and* you remember what each color means. Hover Helper takes a more direct approach: point at any part of the code and it tells you, in plain English, what that piece is.

Hover over `re` and you'll see:

> **Variable declaration (const)**
> Creates a variable named `re` and stores the result of `new RegExp("ab+c")` in it. Because it's const, it can't be reassigned later.
>
> **const:** const declares a variable that can't be reassigned…

## Features

- **Context-aware explanations.** The same word means different things in different places. `name` might be a parameter, a variable being declared, a property, or a shorthand object key, and Hover Helper tells them apart.
- **Explains everything.** It covers keywords, variables, functions, classes, properties, strings, numbers, regexes, operators, and even brackets ("Opens the list of arguments passed into `console.log`").
- **Links references to declarations.** For example: "Uses the value stored in the variable `re` (declared on line 1 with const)."
- **Catches beginner mistakes.** It warns when you reassign a `const`, or assign to a variable that was never declared.
- **Built-ins and common methods.** It recognizes `console`, `fetch`, `Math`, `.map()`, `.filter()`, `.test()`, and more.
- **Click to pin.** Click a token, or move the cursor onto it with the arrow keys, to keep its explanation in the side panel with a link to MDN.
- **Color key.** Hover over a category in the key to light up every matching token. Colors can be turned off entirely.
- **Works with broken code.** On a syntax error it shows where the error is and still explains the pieces it can.
- Light and dark themes, a mobile layout, and keyboard support.

## Running it locally

It's a static site with no build step and no dependencies to install. Serve the folder with any static file server, for example:

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765>. Opening `index.html` directly from disk won't work, because browsers block ES modules on `file://`.

## How it works

```
index.html          page layout
styles.css          theme + token colors
src/main.js         editor, hover tooltip, pinned explanation panel, color key
src/analyze.js      code → explained tokens
src/glossary.js     plain-English explanations + MDN links
src/examples.js     starter snippets
```

1. **Parse.** [Acorn](https://github.com/acornjs/acorn) parses the code into an abstract syntax tree (AST), collecting every token and comment along the way.
2. **Classify identifiers.** A tree walk looks at where each name sits: the `id` of a `VariableDeclarator`, a function's `params`, the `property` of a `MemberExpression` that's being called, and so on. Declarations are recorded so that later uses can say where the name came from.
3. **Explain the remaining tokens.** For keywords, operators, and brackets, the analyzer finds the innermost AST node the token belongs to. That tells it whether a `(` opens a function call, a parameter list, an `if` condition, or a grouping.
4. **Render.** The editor is a transparent `<textarea>` layered over a highlighted `<pre>`. You get a real text box to type in, and `document.elementsFromPoint()` looks "through" it to find the token under the mouse.

## Roadmap ideas

- Line numbers and an "explain this line" view
- More languages (Python next)
- A browser extension that adds hover explanations to code blocks on MDN, Stack Overflow, and GitHub
- A VS Code extension using the same analyzer
- Unit tests for the analyzer

## License

MIT
