/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

const assert = require("node:assert/strict");
const {mkdtempSync, readFileSync, readdirSync, statSync} = require("node:fs");
const {tmpdir} = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

/** Reads and parses one repository JSON file. */
function readJson(relativePath) {
    return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

/** Recursively returns regular files while excluding private and generated trees. */
function projectFiles(directory = root) {
    const files = [];
    for (const entry of readdirSync(directory)) {
	if ([".git", "node_modules", "env.sh"].includes(entry) || entry.endsWith(".tgz")) continue;
	const absolutePath = path.join(directory, entry);
	if (statSync(absolutePath).isDirectory()) files.push(...projectFiles(absolutePath));
	else files.push(absolutePath);
    }
    return files;
}

test("package and configuration metadata match supported Homebridge releases", () => {
    const manifest = readJson("package.json");
    const config = readJson("config.schema.json");

    assert.equal(manifest.engines.node, "^22.10.0 || ^24.0.0");
    assert.equal(manifest.engines.homebridge, "^1.8.0 || ^2.0.0");
    assert.ok(manifest.keywords.includes("homebridge-plugin"));
    assert.ok(manifest.keywords.includes("supports-hap"));
    assert.equal(manifest.scripts.prepublishOnly, "npm test");
    assert.deepEqual(config.schema.required, ["username", "password"]);
    assert.equal(config.schema.additionalProperties, false);
    assert.deepEqual(config.schema.properties.password["x-schema-form"], {type: "password"});
    assert.equal(config.schema.properties.configCacheSeconds.default, 30);
    assert.equal(config.schema.properties.swingMode.default, "H");
});

test("private environment files and generated archives are ignored everywhere", () => {
    const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
    const npmignore = readFileSync(path.join(root, ".npmignore"), "utf8");
    for (const pattern of ["/env.sh", "*.tgz"]) {
	assert.match(gitignore, new RegExp(`^${pattern.replace("*", "\\*")}$`, "m"));
	assert.match(npmignore, new RegExp(`^${pattern.replace("*", "\\*")}$`, "m"));
    }
    const source = projectFiles()
	.map(file => readFileSync(file, "utf8"))
	.join("\n");
    assert.doesNotMatch(source, /DEFAULT_REMOTE_(?:HOST|USER|TMP|HOMEBRIDGE_DIR)/);
    assert.doesNotMatch(source, /\/(?:Users|home)\/[A-Za-z0-9._-]+\//);
});

test("runtime and test code carries an MIT copyright header", () => {
    const codeFiles = projectFiles().filter(file => /\.(?:js|sh)$/.test(file));
    for (const file of codeFiles) {
	const source = readFileSync(file, "utf8");
	assert.match(source.slice(0, 300), /MIT License/,
	    `${path.relative(root, file)} is missing its MIT header`);
	assert.match(source.slice(0, 300), /Copyright/,
	    `${path.relative(root, file)} is missing its copyright notice`);
    }
});

test("deployment helper parses and prints help without loading env.sh", () => {
    const script = path.join(root, "scripts", "install-synology-test.sh");
    const syntax = spawnSync("bash", ["-n", script], {encoding: "utf8"});
    assert.equal(syntax.status, 0, syntax.stderr);
    const help = spawnSync(script, ["--help"], {
	cwd: root,
	encoding: "utf8",
	env: {...process.env, ENV_FILE: path.join(root, "definitely-missing-env.sh")}
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /HOMEBRIDGE_SYNOLOGY_HOST/);
});

test("npm package contains runtime files and excludes local-only material", () => {
    const cache = mkdtempSync(path.join(tmpdir(), "homebridge-intesisweb-npm-"));
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--cache", cache], {
	cwd: root,
	encoding: "utf8"
    });
    assert.equal(packed.status, 0, packed.stderr);
    const report = JSON.parse(packed.stdout);
    const files = report[0].files.map(file => file.path);
    for (const required of ["index.js", "lib/platform.js", "lib/features/swing.js", "config.schema.json"]) {
	assert.ok(files.includes(required), `package is missing ${required}`);
    }
    assert.equal(files.some(file => file.startsWith("test/") || file.startsWith("scripts/")), false);
    assert.equal(files.some(file => file === "env.sh" || file.endsWith(".tgz")), false);
});
