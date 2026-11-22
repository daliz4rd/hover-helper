// Turns a string of JavaScript into a list of explained tokens.
//
// How it works:
//  1. Parse the code with Acorn, collecting every token and comment.
//  2. Walk the syntax tree (AST) to work out what each identifier *is* in
//     context: a variable being declared, a parameter, a function call...
//  3. For every other token (keywords, operators, brackets, literals) look at
//     the innermost AST node it sits inside to give a context-aware explanation.
//
// If the code has a syntax error we fall back to tokens only, which still
// lets us explain keywords, literals, and operators.

import { CATEGORIES, KEYWORDS, OPERATORS, BUILTINS, COMMON_MEMBERS } from "./glossary.js";

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  preserveParens: true,
  allowHashBang: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
};

/** Wrap a piece of code so the UI can render it as <code>. */
const c = (s) => "`" + String(s).replace(/`/g, "'") + "`";

const isNode = (v) => v !== null && typeof v === "object" && typeof v.type === "string" && typeof v.start === "number";
const isFunction = (n) => n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);
const isClass = (n) => n && (n.type === "ClassDeclaration" || n.type === "ClassExpression");

/**
 * @param {string} code
 * @param {{parse: Function, tokenizer: Function}} acorn
 * @returns {{tokens: Array<Token>, error: null | {message: string, line: number, column: number, pos: number}}}
 *
 * @typedef {{start: number, end: number, text: string, category: string,
 *            label: string, here: string, concept: string}} Token
 */
export function analyze(code, acorn) {
  const lineOf = makeLineLookup(code);
  const snippet = (node, max = 28) => {
    const s = code.slice(node.start, node.end).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  };

  // ---- 1. Parse ---------------------------------------------------------
  let ast = null, rawTokens = [], comments = [], error = null;
  for (const sourceType of ["module", "script"]) {
    const t = [], cm = [];
    try {
      ast = acorn.parse(code, { ...PARSE_OPTIONS, sourceType, onToken: t, onComment: cm });
      rawTokens = t; comments = cm; error = null;
      break;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      if (!error) { error = e; rawTokens = t; comments = cm; }
    }
  }
  if (!ast) {
    // The tokenizer alone often gets further than the parser (e.g. a missing
    // bracket is a grammar problem, not a token problem).
    const t = [], cm = [];
    try {
      for (const tok of acorn.tokenizer(code, { ecmaVersion: "latest", allowHashBang: true, onComment: cm })) t.push(tok);
    } catch { /* keep whatever we got */ }
    const lastEnd = (arr) => (arr.length ? arr[arr.length - 1].end : 0);
    if (lastEnd(t) > lastEnd(rawTokens)) { rawTokens = t; comments = cm; }
  }

  // ---- 2. Walk the AST --------------------------------------------------
  const parents = new Map();       // node -> parent node
  const owner = [];                // char offset -> innermost node covering it
  const idNodes = [];              // [{node, ancestors}] for Identifier/PrivateIdentifier
  if (ast) {
    walk(ast, [], (node, ancestors) => {
      parents.set(node, ancestors[ancestors.length - 1] ?? null);
      for (let i = node.start; i < node.end; i++) owner[i] = node;
      if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
        idNodes.push({ node, ancestors: ancestors.slice() });
      }
    });
  }

  // First pass: classify identifiers and record declarations.
  const decls = new Map(); // name -> [{start, line, kind, holds}]
  const roles = idNodes.map(({ node, ancestors }) => {
    const role = classifyIdentifier(node, ancestors, snippet, lineOf);
    if (role?.declares) {
      const list = decls.get(node.name) ?? [];
      list.push({ start: node.start, line: lineOf(node.start), kind: role.declares, holds: role.holds });
      decls.set(node.name, list);
    }
    return role;
  });

  // Second pass: resolve references now that every declaration is known.
  const idInfo = new Map(); // start offset -> explained token
  idNodes.forEach(({ node, ancestors }, i) => {
    let role = roles[i];
    if (!role) return;
    if (role.ref) role = resolveReference(node, ancestors, role, decls);
    idInfo.set(node.start, role);
  });

  // ---- 3. Explain every token ------------------------------------------
  const ctx = { code, owner, parents, snippet, lineOf, idInfo, hasAst: !!ast };
  const out = [];
  for (const tok of rawTokens) {
    if (tok.type.label === "eof" || tok.end <= tok.start) continue;
    const text = code.slice(tok.start, tok.end);
    out.push({ start: tok.start, end: tok.end, text, ...describeToken(tok, text, ctx) });
  }
  for (const cm of comments) {
    const text = code.slice(cm.start, cm.end);
    out.push({ start: cm.start, end: cm.end, text, ...describeComment(cm) });
  }
  out.sort((a, b) => a.start - b.start);

  // Fill in category labels for the badge.
  for (const t of out) t.categoryLabel = CATEGORIES[t.category]?.label ?? t.category;

  return {
    tokens: out,
    error: error && {
      message: error.message.replace(/\s*\(\d+:\d+\)$/, ""),
      line: error.loc?.line ?? lineOf(error.pos),
      column: (error.loc?.column ?? 0) + 1,
      pos: error.pos,
    },
  };
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Generic depth-first walk over every node, parents before children. */
function walk(node, ancestors, visit) {
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const child of v) if (isNode(child)) walk(child, ancestors, visit); }
    else if (isNode(v)) walk(v, ancestors, visit);
  }
  ancestors.pop();
}

function makeLineLookup(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Climb out of destructuring patterns to see whether this identifier is being
 * *declared* (as a variable, parameter, or caught error).
 */
function bindingContext(id, ancestors) {
  let child = id;
  let destructured = false;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const p = ancestors[i];
    switch (p.type) {
      case "ObjectPattern":
      case "ArrayPattern":
        destructured = true; child = p; continue;
      case "RestElement":
        child = p; continue;
      case "AssignmentPattern":
        if (p.left === child) { child = p; continue; }
        return null;
      case "Property":
        if (p.value === child && ancestors[i - 1]?.type === "ObjectPattern") { child = p; continue; }
        return null;
      case "VariableDeclarator":
        return p.id === child ? { kind: ancestors[i - 1].kind, declarator: p, declaration: ancestors[i - 1], loop: ancestors[i - 2], destructured } : null;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return p.params.includes(child) ? { kind: "param", fn: p, fnParent: ancestors[i - 1], destructured } : null;
      case "CatchClause":
        return p.param === child ? { kind: "catch", destructured } : null;
      case "AssignmentExpression":
        return p.left === child && destructured ? { kind: "assignPattern" } : null;
      default:
        return null;
    }
  }
  return null;
}

function functionName(fn, fnParent) {
  if (fn.id) return c(fn.id.name);
  if (fnParent?.type === "VariableDeclarator" && fnParent.id.type === "Identifier") return c(fnParent.id.name);
  if (fnParent?.type === "MethodDefinition" || fnParent?.type === "Property") {
    if (!fnParent.computed && fnParent.key.name) return "the " + c(fnParent.key.name) + " method";
  }
  return fn.type === "ArrowFunctionExpression" ? "this arrow function" : "this function";
}

/** Work out what an identifier is from where it sits in the tree. */
function classifyIdentifier(id, ancestors, snippet, lineOf) {
  const p = ancestors[ancestors.length - 1];
  const g = ancestors[ancestors.length - 2];
  const isPrivate = id.type === "PrivateIdentifier";
  const name = isPrivate ? "#" + id.name : id.name;

  switch (p?.type) {
    case "MemberExpression":
      if (p.property === id && !p.computed) {
        const obj = c(snippet(p.object));
        const known = !isPrivate && Object.hasOwn(COMMON_MEMBERS, id.name) ? COMMON_MEMBERS[id.name] : null;
        const privateNote = isPrivate ? " The # means it's private to the class." : "";
        if (g?.type === "CallExpression" && g.callee === p) {
          return {
            category: "function", label: isPrivate ? "Private method call" : "Method call", concept: "method",
            here: `Calls the ${c(name)} method on ${obj}${known ? `, which ${known}` : ""}.${privateNote}`,
          };
        }
        const writing = g?.type === "AssignmentExpression" && g.left === p;
        return {
          category: "property", label: isPrivate ? "Private field" : "Property", concept: isPrivate ? "private" : "property",
          here: `${writing ? "Stores a value in" : "Reads"} the ${c(name)} property of ${obj}${known ? ` (${known})` : ""}.${privateNote}`,
        };
      }
      break;

    case "Property":
      if (p.key === id && !p.computed) {
        if (p.shorthand && p.value !== id) return null; // the value side explains it
        if (p.shorthand && g?.type === "ObjectExpression") break; // same node as value: treat as reference
        if (g?.type === "ObjectPattern") {
          if (p.shorthand) break; // handled as a binding below
          return {
            category: "property", label: "Property being unpacked", concept: "destructuring",
            here: `Takes the ${c(name)} property out of the object and puts it into ${c(snippet(p.value))}.`,
          };
        }
        if (p.kind === "get" || p.kind === "set") {
          return { category: "function", label: p.kind === "get" ? "Getter" : "Setter", concept: "getterSetter", here: `Defines a ${p.kind}ter for the ${c(name)} property.` };
        }
        if (p.method || isFunction(p.value)) {
          return { category: "function", label: "Method definition", concept: "method", here: `Defines a method called ${c(name)} on this object.` };
        }
        return { category: "property", label: "Property name", concept: "object", here: `Names a property called ${c(name)} in this object. Its value comes after the colon.` };
      }
      break;

    case "MethodDefinition":
      if (p.key === id && !p.computed) {
        const stat = p.static ? "static " : "";
        if (p.kind === "constructor") return { category: "function", label: "Constructor", concept: "constructor", here: "The setup function that runs automatically when you create an object with new." };
        if (p.kind === "get" || p.kind === "set") return { category: "function", label: `${stat}${p.kind === "get" ? "Getter" : "Setter"}`, concept: "getterSetter", here: `Defines a ${p.kind}ter for ${c(name)} on this class.` };
        return {
          category: "function", label: `${p.static ? "Static method" : "Method"} definition`, concept: isPrivate ? "private" : "method",
          here: `Defines a ${stat}${isPrivate ? "private " : ""}method called ${c(name)} that ${p.static ? "is called on the class itself" : "every object made from this class can use"}.`,
        };
      }
      break;

    case "PropertyDefinition":
      if (p.key === id && !p.computed) {
        return {
          category: "property", label: isPrivate ? "Private field" : (p.static ? "Static field" : "Class field"), concept: isPrivate ? "private" : "classField",
          here: `Declares a ${isPrivate ? "private " : ""}field called ${c(name)}${p.value ? ", with a starting value" : ""}.${isPrivate ? " Only code inside this class can use it." : ""}`,
        };
      }
      break;

    case "FunctionDeclaration":
    case "FunctionExpression":
      if (p.id === id) {
        return {
          category: "function", label: "Function name", concept: "function", declares: "function",
          here: p.type === "FunctionDeclaration"
            ? `Declares a function named ${c(name)}. You can run it later by writing ${c(name + "()")}.`
            : `Names this function ${c(name)} (mostly useful for error messages and recursion).`,
        };
      }
      break;

    case "ClassDeclaration":
    case "ClassExpression":
      if (p.id === id) {
        return { category: "class", label: "Class name", concept: "class", declares: "class", here: `Declares a class named ${c(name)}. Create objects from it with ${c("new " + name + "()")}.` };
      }
      if (p.superClass === id) return { ref: true, extends: true };
      break;

    case "ImportSpecifier":
      if (p.imported === id && p.local !== id && p.local.start !== id.start) {
        return { category: "variable", label: "Imported name", concept: "import", here: `The name ${c(name)} as the other file exported it. It's renamed to ${c(p.local.name)} here.` };
      }
      if (p.local === id) return { category: "variable", label: "Import", concept: "import", declares: "import", here: `Brings ${c(name)} in from another file so it can be used here.` };
      break;

    case "ImportDefaultSpecifier":
      return { category: "variable", label: "Default import", concept: "import", declares: "import", here: `Brings in the main (default) export of another file under the name ${c(name)}.` };

    case "ImportNamespaceSpecifier":
      return { category: "variable", label: "Namespace import", concept: "import", declares: "import", here: `Bundles everything the other file exports into one object called ${c(name)}.` };

    case "ExportSpecifier":
      if (p.exported === id && p.local !== id && p.local.start !== id.start) {
        return { category: "variable", label: "Export name", concept: "export", here: `Other files will import this under the name ${c(name)}.` };
      }
      break;

    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      if (p.label === id) return { category: "keyword", label: "Label", concept: "label", here: `A label named ${c(name)}, used to target a specific loop with break or continue.` };
      break;

    case "MetaProperty":
      return { category: "keyword", label: "Meta property", concept: "statement", here: `Part of ${c(snippet(p))}, a special built-in value.` };

    case "CallExpression":
      if (p.callee === id) return { ref: true, call: true };
      break;

    case "NewExpression":
      if (p.callee === id) return { ref: true, construct: true };
      break;
  }

  const binding = bindingContext(id, ancestors);
  if (binding) return describeBinding(id, name, binding, p, snippet);

  if (p?.type === "AssignmentExpression" && p.left === id) return { ref: true, assign: true, operator: p.operator };
  if (p?.type === "UpdateExpression") return { ref: true, update: p.operator };
  const shorthand = p?.type === "Property" && p.shorthand && g?.type === "ObjectExpression";
  return { ref: true, shorthand };
}

function describeBinding(id, name, b, parent, snippet) {
  const defaulted = parent?.type === "AssignmentPattern" && parent.left === id;
  const rest = parent?.type === "RestElement";
  const unpack = b.destructured ? " It's unpacked (destructured) from the value on the right." : "";

  if (b.kind === "param") {
    const fn = functionName(b.fn, b.fnParent);
    let here = `An input to ${fn}: it holds whatever value is passed in when the function is called.`;
    if (rest) here = `Collects all remaining arguments passed to ${fn} into an array named ${c(name)}.`;
    if (defaulted) here += ` If nothing is passed, it defaults to ${c(snippet(parent.right))}.`;
    if (b.destructured) here += " It's unpacked (destructured) from the argument.";
    return { category: "parameter", label: rest ? "Rest parameter" : "Parameter", concept: "parameter", declares: "param", here };
  }
  if (b.kind === "catch") {
    return { category: "parameter", label: "Error variable", concept: "try", declares: "catch", here: `Holds the error that was thrown, so the catch block can inspect it.` };
  }
  if (b.kind === "assignPattern") {
    return { ref: true, assign: true, operator: "=" , destructured: true };
  }

  // const / let / var
  const kind = b.kind;
  const init = b.declarator.init;
  const loop = b.loop && b.loop[b.declaration === b.loop.left ? "left" : "init"] === b.declaration ? b.loop : null;
  let holds = null;
  let here;
  if (loop?.type === "ForOfStatement") {
    here = `Creates the loop variable ${c(name)}, which holds each item of ${c(snippet(loop.right))} in turn.`;
  } else if (loop?.type === "ForInStatement") {
    here = `Creates the loop variable ${c(name)}, which holds each property name of ${c(snippet(loop.right))} in turn.`;
  } else if (!b.destructured && isFunction(init)) {
    holds = "function";
    here = `Declares ${c(name)} and stores a function in it, so you can call it with ${c(name + "()")}.`;
  } else if (!b.destructured && isClass(init)) {
    holds = "class";
    here = `Declares ${c(name)} and stores a class in it.`;
  } else if (init && !b.destructured) {
    const simple = init.type === "Literal" || init.type === "ArrayExpression" || init.type === "ObjectExpression";
    here = `Creates a variable named ${c(name)} and stores ${simple ? "" : "the result of "}${c(snippet(init))} in it.`;
  } else if (init || b.destructured) {
    here = `Creates a variable named ${c(name)}.${unpack}`;
  } else {
    here = `Creates a variable named ${c(name)} with no value yet (it starts as undefined).`;
  }
  if (defaulted) here += ` If that value is missing, it defaults to ${c(snippet(parent.right))}.`;
  if (kind === "const") here += " Because it's const, it can't be reassigned later.";

  return {
    category: holds ?? "variable",
    label: holds === "function" ? `Function (stored in ${kind})` : holds === "class" ? `Class (stored in ${kind})` : `Variable declaration (${kind})`,
    concept: holds ?? kind,
    declares: kind,
    holds,
    here,
  };
}

/** Find the declaration a name most likely refers to. */
function findDecl(decls, name, pos) {
  const list = decls.get(name);
  if (!list) return null;
  let best = null;
  for (const d of list) if (d.start <= pos) best = d;
  return best ?? list[0]; // e.g. a function used before it's declared (hoisting)
}

function describeDeclKind(d) {
  switch (d.kind) {
    case "const": case "let": case "var": return `declared on line ${d.line} with ${d.kind}`;
    case "param": return `a parameter declared on line ${d.line}`;
    case "catch": return `the caught error from line ${d.line}`;
    case "import": return `imported on line ${d.line}`;
    default: return `declared on line ${d.line}`;
  }
}

function resolveReference(id, ancestors, role, decls) {
  const name = id.name;
  const d = findDecl(decls, name, id.start);
  const builtin = !d && Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : null;
  const where = d ? describeDeclKind(d) : null;
  const isFn = d && (d.kind === "function" || d.holds === "function");
  const isCls = d && (d.kind === "class" || d.holds === "class");

  if (role.call) {
    if (builtin) return { category: "builtin", label: "Built-in function call", concept: "builtin", mdn: builtin[1], here: `Calls the built-in ${c(name)} function. ${builtin[0]}` };
    if (d) return { category: "function", label: "Function call", concept: "functionCall", here: `Runs the function ${c(name)} (${where}). The values inside ( ) are passed in as arguments.` };
    return { category: "function", label: "Function call", concept: "functionCall", here: `Calls a function named ${c(name)}. It isn't defined in this snippet, so it probably comes from somewhere else.` };
  }
  if (role.construct) {
    if (builtin) return { category: "builtin", label: "Built-in class", concept: "new", mdn: builtin[1], here: `Creates a new ${c(name)} object. ${c(name)} is built into JavaScript: ${lowerFirst(builtin[0])}` };
    return { category: "class", label: "Class (constructor)", concept: "new", here: `Creates a new object from the ${c(name)} class${d ? ` (${where})` : ""}.` };
  }
  if (role.extends) {
    if (builtin) return { category: "builtin", label: "Built-in class", concept: "extends", mdn: builtin[1], here: `This class builds on the built-in ${c(name)} class. ${builtin[0]}` };
    return { category: "class", label: "Parent class", concept: "extends", here: `This class builds on (inherits from) ${c(name)}${d ? `, ${where}` : ""}.` };
  }
  if (role.assign) {
    let here = role.operator === "="
      ? `Gives ${c(name)} a new value${d ? ` (it was ${where})` : ""}.`
      : `Updates ${c(name)} using its current value (${c(role.operator)})${d ? `; it was ${where}` : ""}.`;
    if (role.destructured) here = `Gives ${c(name)} a new value unpacked from the right-hand side${d ? ` (it was ${where})` : ""}.`;
    if (d?.kind === "const") here += ` Warning: ${c(name)} was declared with const, so reassigning it causes an error!`;
    if (!d && !builtin) here += " It isn't declared in this snippet; did you forget const or let?";
    const category = d?.kind === "param" ? "parameter" : d || builtin ? "variable" : "unknown";
    return { category, label: "Reassignment", concept: "assignment", here };
  }
  if (role.update) {
    let here = `${role.update === "++" ? "Adds 1 to" : "Subtracts 1 from"} ${c(name)}${d ? ` (${where})` : ""}.`;
    if (d?.kind === "const") here += ` Warning: ${c(name)} is const, so this will cause an error!`;
    return { category: d?.kind === "param" ? "parameter" : "variable", label: "Variable", concept: "increment", here };
  }

  const shorthand = role.shorthand ? ` This is shorthand for ${c(name + ": " + name)}, which makes a property with the same name and value.` : "";
  if (isFn) return { category: "function", label: "Function reference", concept: "function", here: `Refers to the function ${c(name)} (${where}) without calling it, for example to pass it somewhere as a value.${shorthand}` };
  if (isCls) return { category: "class", label: "Class reference", concept: "class", here: `Refers to the class ${c(name)} (${where}).${shorthand}` };
  if (d?.kind === "param") return { category: "parameter", label: "Parameter", concept: "parameter", here: `Uses the value passed into the parameter ${c(name)} (${where}).${shorthand}` };
  if (d?.kind === "catch") return { category: "parameter", label: "Error variable", concept: "try", here: `Uses the caught error ${c(name)}.${shorthand}` };
  if (d?.kind === "import") return { category: "variable", label: "Imported value", concept: "import", here: `Uses ${c(name)}, which was ${where}.${shorthand}` };
  if (d) return { category: "variable", label: "Variable", concept: "variable", here: `Uses the value stored in the variable ${c(name)} (${where}).${shorthand}` };
  if (name === "undefined") return { category: "literal", label: "undefined", concept: "undefined", here: "The special value meaning \"no value has been assigned\"." };
  if (builtin) return { category: "builtin", label: "Built-in", concept: "builtin", mdn: builtin[1], here: `${c(name)}: ${builtin[0]}` };
  return { category: "unknown", label: "Undeclared name", concept: "undeclared", here: `${c(name)} isn't declared in this snippet.${shorthand}` };
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Non-identifier tokens
// ---------------------------------------------------------------------------

function describeToken(tok, text, ctx) {
  const label = tok.type.label;
  const node = ctx.owner[tok.start];
  const parent = node ? ctx.parents.get(node) : null;

  if (label === "name" || label === "privateId") {
    const info = ctx.idInfo.get(tok.start);
    if (info) return info;
    if (Object.hasOwn(KEYWORDS, text) && label === "name") return describeKeyword(text, node, parent, ctx);
    if (Object.hasOwn(BUILTINS, text)) return { category: "builtin", label: "Built-in", concept: "builtin", mdn: BUILTINS[text][1], here: `${c(text)}: ${BUILTINS[text][0]}` };
    if (label === "privateId") return { category: "property", label: "Private field", concept: "private", here: `${c(text)} is a private class member.` };
    return ctx.hasAst
      ? { category: "unknown", label: "Name", concept: "undeclared", here: `The name ${c(text)}.` }
      : { category: "unknown", label: "Name", concept: "syntaxError", here: `The name ${c(text)}. Because of the syntax error, Hover Helper can't tell yet whether it's a variable, function, or something else.` };
  }

  if (tok.type.keyword) {
    if (text === "true" || text === "false") return { category: "literal", label: "Boolean", concept: "boolean", here: `The boolean value ${c(text)}.` };
    if (text === "null") return { category: "literal", label: "null", concept: "null", here: "The value null: deliberately \"nothing\"." };
    return describeKeyword(text, node, parent, ctx);
  }

  switch (label) {
    case "string": return describeString(text, node, parent, ctx);
    case "num": {
      const big = text.endsWith("n");
      const kind = /^0[xX]/.test(text) ? " written in hexadecimal" : /^0[bB]/.test(text) ? " written in binary" : /^0[oO]/.test(text) ? " written in octal" : "";
      return { category: "number", label: big ? "BigInt" : "Number", concept: big ? "bigint" : "number", here: `The number ${c(text)}${kind}.${argNote(node, parent, ctx)}` };
    }
    case "regexp": {
      const v = tok.value ?? {};
      const flags = v.flags ? ` Flags: ${[...v.flags].map((f) => `${c(f)} (${REGEX_FLAGS[f] ?? "?"})`).join(", ")}.` : "";
      return { category: "regex", label: "Regex literal", concept: "regex", here: `A regular expression with the pattern ${c(v.pattern ?? text)}.${flags}${argNote(node, parent, ctx)}` };
    }
    case "template":
    case "invalidTemplate":
      return { category: "string", label: "Template text", concept: "template", here: "Plain text inside a template literal (backtick string)." };
  }

  return describeOperator(text, node, parent, ctx);
}

const REGEX_FLAGS = { g: "find all matches", i: "ignore upper/lower case", m: "multi-line", s: "dot matches newlines", u: "Unicode", v: "Unicode sets", y: "sticky", d: "match indices" };

function argNote(node, parent, ctx) {
  if (parent && (parent.type === "CallExpression" || parent.type === "NewExpression") && parent.arguments.includes(node)) {
    return ` It's passed as an argument to ${c(ctx.snippet(parent.callee))}.`;
  }
  return "";
}

function describeString(text, node, parent, ctx) {
  const base = { category: "string", label: "String", concept: "string" };
  if (parent && /^(ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration|ImportExpression)$/.test(parent.type) && parent.source === node) {
    return { ...base, label: "Module path", concept: "import", here: `The location of the file (module) to ${parent.type.startsWith("Export") ? "re-export" : "import"} from.` };
  }
  if (parent?.type === "ExpressionStatement" && parent.directive) {
    return { ...base, label: "Directive", concept: "statement", here: `${c(text)} is a directive: a special instruction to JavaScript itself.` };
  }
  if (parent && (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node) {
    return { ...base, label: "Property name (string)", concept: "object", here: `A property name written as a string, ${c(text)}.` };
  }
  const len = node?.type === "Literal" && typeof node.value === "string" ? node.value.length : null;
  const lenNote = len != null ? ` It's ${len} character${len === 1 ? "" : "s"} long.` : "";
  return { ...base, here: `A string (a piece of text): ${c(text)}.${lenNote}${argNote(node, parent, ctx)}` };
}

function describeKeyword(text, node, parent, ctx) {
  const [concept, phrase] = KEYWORDS[text] ?? ["statement", "A JavaScript keyword."];
  const base = { category: "keyword", label: `Keyword: ${text}`, concept, here: phrase };
  const s = (n) => c(ctx.snippet(n));
  if (!node) return base;

  switch (text) {
    case "const": case "let": case "var": {
      const decl = node.type === "VariableDeclaration" ? node : null;
      const names = decl?.declarations.map((d) => (d.id.type === "Identifier" ? c(d.id.name) : "several variables (destructuring)")).join(", ");
      if (names) base.here = `${phrase.replace(/\.$/, "")}: ${names}.`;
      break;
    }
    case "if":
      if (node.type === "IfStatement") base.here = `Checks whether ${s(node.test)} is true. If it is, the block that follows runs.`;
      break;
    case "while":
      if (node.type === "WhileStatement") base.here = `Keeps repeating the following block as long as ${s(node.test)} is true.`;
      break;
    case "return":
      if (node.type === "ReturnStatement") base.here = node.argument ? `Ends the function and sends ${s(node.argument)} back to whoever called it.` : "Ends the function early, returning undefined.";
      break;
    case "new":
      if (node.type === "NewExpression") base.here = `Creates a new object using ${s(node.callee)}.`;
      break;
    case "function":
      if (isFunction(node)) {
        const named = node.id ? ` named ${c(node.id.name)}` : " with no name (an anonymous function)";
        const kind = `${node.async ? "async " : ""}${node.generator ? "generator " : ""}function`;
        base.here = `Starts ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}${named}.`;
      }
      break;
    case "in":
      if (node.type === "BinaryExpression") { base.concept = "forIn"; base.here = `Checks whether the property ${s(node.left)} exists in ${s(node.right)}.`; }
      break;
    case "default":
      if (node.type === "ExportDefaultDeclaration") { base.concept = "export"; base.here = "Marks this as the file's main (default) export."; }
      break;
    case "async":
      if (isFunction(node) || node.type === "MethodDefinition" || node.type === "Property") base.here = "Marks this function as asynchronous, so it can use await and always returns a Promise.";
      break;
    case "await":
      if (node.type === "AwaitExpression") base.here = `Waits for ${s(node.argument)} to finish, then gives back its result.`;
      else if (node.type === "ForOfStatement") base.here = "Makes this for...of loop wait for each item (for async iterables).";
      break;
    case "typeof":
      if (node.type === "UnaryExpression") base.here = `Gives the type of ${s(node.argument)} as a string, like "number" or "string".`;
      break;
    case "class":
      if (isClass(node)) base.here = node.id ? `Starts the definition of a class named ${c(node.id.name)}.` : "Starts a class definition.";
      break;
    case "extends":
      if (isClass(node) && node.superClass) base.here = `Makes this class build on ${s(node.superClass)}, inheriting its methods.`;
      break;
    case "this":
      base.here = "Refers to the current object, usually the one the method was called on.";
      break;
    case "throw":
      if (node.type === "ThrowStatement") base.here = `Raises ${s(node.argument)} as an error.`;
      break;
  }
  return base;
}

function describeOperator(text, node, parent, ctx) {
  const [concept, phrase] = OPERATORS[text] ?? ["arithmetic", "An operator."];
  const r = { category: /^[()[\]{},;:.]$|^`$|^\$\{$/.test(text) ? "punctuation" : "operator", label: `Operator: ${text}`, concept, here: phrase };
  if (r.category === "punctuation") r.label = PUNCT_NAMES[text] ?? `Punctuation: ${text}`;
  const t = node?.type;
  const s = (n) => c(ctx.snippet(n));
  const open = "([{".includes(text);
  const verb = open ? "Opens" : "Closes";

  switch (text) {
    case "(": case ")":
      if (t === "CallExpression" || t === "NewExpression") Object.assign(r, { concept: "argument", here: `${verb} the list of arguments passed into ${s(node.callee)}.` });
      else if (isFunction(node)) Object.assign(r, { concept: "parameter", here: `${verb} the function's parameter list (its inputs).` });
      else if (t === "IfStatement" || t === "WhileStatement" || t === "DoWhileStatement") Object.assign(r, { concept: t === "IfStatement" ? "if" : "while", here: `${verb} the condition being checked.` });
      else if (t === "SwitchStatement") Object.assign(r, { concept: "switch", here: `${verb} the value being switched on.` });
      else if (/^For/.test(t ?? "")) Object.assign(r, { concept: t === "ForOfStatement" ? "forOf" : "for", here: `${verb} the loop's setup.` });
      else if (t === "CatchClause") Object.assign(r, { concept: "try", here: `${verb} the name for the caught error.` });
      else if (t === "ParenthesizedExpression") Object.assign(r, { concept: "grouping", here: `${verb} a group, so ${s(node.expression)} is worked out first.` });
      else if (t === "ImportExpression") Object.assign(r, { concept: "import", here: `${verb} the path of the module to load.` });
      break;
    case "{": case "}": {
      if (t === "BlockStatement") {
        const what = blockOwnerName(parent, node);
        Object.assign(r, { concept: isFunction(parent) ? "function" : "block", here: `${verb} ${what}.` });
      } else if (t === "ObjectExpression") Object.assign(r, { concept: "object", here: `${verb} an object literal: a set of key: value pairs.` });
      else if (t === "ObjectPattern") Object.assign(r, { concept: "destructuring", here: `${verb} an object destructuring pattern, which pulls properties out into variables.` });
      else if (t === "ClassBody") Object.assign(r, { concept: "class", here: `${verb} the body of the class.` });
      else if (t === "SwitchStatement") Object.assign(r, { concept: "switch", here: `${verb} the list of cases.` });
      else if (t === "ImportDeclaration") Object.assign(r, { concept: "import", here: `${verb} the list of names being imported.` });
      else if (t === "ExportNamedDeclaration") Object.assign(r, { concept: "export", here: `${verb} the list of names being exported.` });
      else if (t === "TemplateLiteral" && text === "}") Object.assign(r, { concept: "template", here: "Ends the ${ } slot inside the template string." });
      break;
    }
    case "[": case "]":
      if (t === "ArrayExpression") Object.assign(r, { here: `${verb} an array (a list of values).` });
      else if (t === "MemberExpression") Object.assign(r, { concept: "accessor", here: `${verb} a lookup into ${s(node.object)} by index or key.` });
      else if (t === "ArrayPattern") Object.assign(r, { concept: "destructuring", here: `${verb} an array destructuring pattern, which pulls items out into variables.` });
      else if (t === "Property" || t === "MethodDefinition" || t === "PropertyDefinition") Object.assign(r, { concept: "object", here: `${verb} a computed property name (the name is worked out from an expression).` });
      break;
    case ".":
      if (t === "MemberExpression") r.here = `Reaches into ${s(node.object)} to get its ${c(ctx.snippet(node.property))}.`;
      break;
    case "?.":
      if (t === "MemberExpression" || t === "CallExpression") r.here = `Continues only if ${s(t === "MemberExpression" ? node.object : node.callee)} isn't null or undefined; otherwise the result is undefined instead of an error.`;
      break;
    case "=":
      if (t === "VariableDeclarator" && node.id.type !== "Identifier") Object.assign(r, { concept: "destructuring", here: "Unpacks values from the right-hand side into the new variables on the left." });
      else if (t === "VariableDeclarator") r.here = `Gives the new variable ${s(node.id)} its starting value.`;
      else if (t === "AssignmentExpression") r.here = `Stores the value on the right into ${s(node.left)}.`;
      else if (t === "AssignmentPattern") Object.assign(r, { concept: "parameter", here: `Sets a default value for ${s(node.left)}, used when nothing is provided.` });
      else if (t === "PropertyDefinition") Object.assign(r, { concept: "classField", here: "Gives this class field its starting value." });
      break;
    case ":":
      if (t === "ConditionalExpression") Object.assign(r, { concept: "ternary", category: "operator", here: `Separates the two choices: if the condition is false, the result is ${s(node.alternate)}.` });
      else if (t === "SwitchCase") Object.assign(r, { concept: "switch", here: "Ends the case label; the code for this case follows." });
      else if (t === "LabeledStatement") Object.assign(r, { concept: "label", here: "Ends a loop label." });
      else if (t === "Property") r.here = `Separates the property name ${s(node.key)} from its value.`;
      break;
    case "?":
      if (t === "ConditionalExpression") r.here = `If ${s(node.test)} is true, the result is ${s(node.consequent)}; otherwise it's what comes after the :.`;
      break;
    case "...":
      if (t === "SpreadElement") r.here = `Spreads out the items of ${s(node.argument)} individually.`;
      else if (t === "RestElement") r.here = `Gathers all the remaining items into ${s(node.argument)}.`;
      break;
    case ",":
      if (t === "CallExpression" || t === "NewExpression") Object.assign(r, { concept: "argument", here: "Separates the arguments being passed in." });
      else if (isFunction(node)) Object.assign(r, { concept: "parameter", here: "Separates the function's parameters." });
      else if (t === "ArrayExpression") Object.assign(r, { concept: "array", here: "Separates items in the array." });
      else if (t === "ObjectExpression") Object.assign(r, { concept: "object", here: "Separates properties in the object." });
      else if (t === "VariableDeclaration") Object.assign(r, { concept: "variable", here: "Separates multiple variables declared together." });
      break;
    case ";":
      if (t === "ForStatement") Object.assign(r, { concept: "for", here: "Separates the three parts of the for loop: setup; condition; update." });
      break;
    case "*":
      if (isFunction(node) || t === "MethodDefinition" || t === "Property") Object.assign(r, { concept: "generator", here: "Marks this as a generator function." });
      else if (t === "ImportNamespaceSpecifier" || t === "ExportAllDeclaration") Object.assign(r, { concept: "import", here: "Means \"everything\": all of the module's exports." });
      else if (t === "YieldExpression") Object.assign(r, { concept: "yield", here: "yield* hands out every value from another iterable, one at a time." });
      break;
    case "+": case "-":
      if (t === "UnaryExpression") r.here = text === "-" ? `Makes ${s(node.argument)} negative.` : `Converts ${s(node.argument)} to a number.`;
      else if (t === "BinaryExpression" && text === "+") r.here = `Adds ${s(node.left)} and ${s(node.right)} (or joins them, if either is a string).`;
      break;
    case "++": case "--":
      if (t === "UpdateExpression") r.here = `${text === "++" ? "Adds 1 to" : "Subtracts 1 from"} ${s(node.argument)}.`;
      break;
    case "===": case "!==": case "==": case "!=": case "<": case ">": case "<=": case ">=":
      if (t === "BinaryExpression") r.here = `${phrase} Compares ${s(node.left)} with ${s(node.right)}, giving true or false.`;
      break;
    case "&&": case "||": case "??":
      if (t === "LogicalExpression") r.here = `${phrase} (Left: ${s(node.left)}, right: ${s(node.right)}.)`;
      break;
    case "=>":
      if (t === "ArrowFunctionExpression") r.here = "Separates the arrow function's inputs (left) from what it does (right).";
      break;
  }
  return r;
}

const PUNCT_NAMES = {
  "(": "Parenthesis", ")": "Parenthesis", "{": "Curly brace", "}": "Curly brace",
  "[": "Square bracket", "]": "Square bracket", ",": "Comma", ";": "Semicolon",
  ":": "Colon", ".": "Dot", "`": "Backtick", "${": "Template slot",
};

function blockOwnerName(parent, block) {
  if (!parent) return "a block of code";
  if (isFunction(parent)) return "the body of the function";
  switch (parent.type) {
    case "IfStatement": return parent.alternate === block ? "the code that runs when the if condition is false" : "the code that runs when the if condition is true";
    case "ForStatement": case "ForOfStatement": case "ForInStatement": case "WhileStatement": case "DoWhileStatement": return "the loop body, which repeats";
    case "TryStatement": return parent.finalizer === block ? "the finally block" : "the try block";
    case "CatchClause": return "the code that handles the error";
    case "StaticBlock": return "a static initialization block";
    default: return "a block of code";
  }
}

function describeComment(cm) {
  const doc = cm.type === "Block" && cm.value.startsWith("*");
  return {
    category: "comment",
    label: doc ? "Documentation comment" : cm.type === "Line" ? "Line comment" : "Block comment",
    concept: "comment",
    here: doc
      ? "A documentation comment (JSDoc). Editors read these to show hints about the code below."
      : "A note for humans. JavaScript ignores everything in a comment.",
  };
}
