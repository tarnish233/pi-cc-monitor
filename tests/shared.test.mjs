/** Only rendering and task-panel sources remain shared between Loop and Monitor. */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { extensionDir, siblingExtensionDir } from "./helpers.mjs";

const self = path.basename(extensionDir);
const SIBLINGS = ["pi-cc-loop", "pi-cc-monitor"].filter((name) => name !== self);
const SHARED = {
	"render.ts": SIBLINGS,
	"tasks.ts": SIBLINGS,
	"log-tail.ts": SIBLINGS,
};

for (const [file, siblings] of Object.entries(SHARED)) {
	for (const sibling of siblings) {
		const theirs = siblingExtensionDir(sibling);
		const present = fs.existsSync(path.join(theirs, "package.json"));
		test(`${file} is identical in ${self} and ${sibling}`, { skip: !present && "sibling checkout not found" }, () => {
			const mine = fs.readFileSync(path.join(extensionDir, file), "utf8");
			const theirsFile = fs.readFileSync(path.join(theirs, file), "utf8");
			assert.ok(mine === theirsFile, `${file} differs from ${path.join(theirs, file)}; copy the newer one over`);
		});
	}
}
