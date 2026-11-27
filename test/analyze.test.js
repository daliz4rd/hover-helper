import { test } from "node:test";
import assert from "node:assert/strict";
import * as acorn from "acorn";
import { analyze } from "../src/analyze.js";


test("check text to find b and label", () => {
	//steps
	//step 1 run the analyzer
	const result = analyze("const a = 1, b = 2;", acorn);
	const tok = result.tokens.find((t) => t.text === "b");
	assert.equal(tok.label, "Variable declaration (const)");
});
