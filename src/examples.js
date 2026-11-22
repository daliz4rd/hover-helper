// Starter snippets shown in the "Try an example" menu.
export const EXAMPLES = [
  {
    name: "Variables & a regex",
    code: `const re = new RegExp("ab+c");
let matches = 0;

if (re.test("abbbc")) {
  matches++;
}

console.log(matches);
`,
  },
  {
    name: "Functions",
    code: `// A function that greets someone
function greet(name, greeting = "Hello") {
  return \`\${greeting}, \${name}!\`;
}

const shout = (text) => text.toUpperCase();

const message = greet("Ada");
console.log(shout(message));
`,
  },
  {
    name: "Arrays & loops",
    code: `const scores = [88, 92, 75, 64];
let total = 0;

for (const score of scores) {
  total += score;
}

const average = total / scores.length;
const passed = scores.filter((s) => s >= 70);

if (average > 80) {
  console.log("Great job!");
} else {
  console.log(\`Average: \${average.toFixed(1)}\`);
}
`,
  },
  {
    name: "Objects & classes",
    code: `class Pet {
  #sound;

  constructor(name, sound) {
    this.name = name;
    this.#sound = sound;
  }

  speak() {
    return \`\${this.name} says \${this.#sound}\`;
  }
}

const dog = new Pet("Rex", "woof");
const { name } = dog;
const info = { name, legs: 4, isGood: true };

console.log(dog.speak(), info);
`,
  },
  {
    name: "Async & errors",
    code: `/**
 * Loads a user's profile from the server.
 */
async function loadUser(id) {
  try {
    const response = await fetch(\`/api/users/\${id}\`);
    const user = await response.json();
    return user?.profile ?? null;
  } catch (error) {
    console.error("Could not load user", error);
    return null;
  }
}
`,
  },
  {
    name: "Spot the bug",
    code: `const count = 1;

// Hover over "count" on the next line to see what's wrong
count = count + 1;

total = count * 2;
`,
  },
];
