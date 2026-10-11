import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
// Registers every discovery provider as a side effect, as omp's own discovery tests do.
import "@oh-my-pi/pi-coding-agent/discovery";
import { clearOmpExtensionCliRoots, injectOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { PACKAGE, closeRegistry, loadPackage, makeFixture, removeTemps } from "./helpers";

let scratch: string;
let home: string;
let project: string;

beforeEach(() => {
	clearCache();
	clearOmpExtensionCliRoots();
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aw-discovery-"));
	home = path.join(scratch, "home");
	project = path.join(scratch, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
});
afterEach(() => {
	clearOmpExtensionCliRoots();
	resetSettingsForTest();
	removeTemps();
	fs.rmSync(scratch, { recursive: true, force: true });
});
afterAll(closeRegistry);

describe("omp loads and discovers the package (AC-1)", () => {
	it("loads the extension with no errors and registers the acceptance flag and command", async () => {
		const { runner } = await loadPackage(makeFixture());
		expect([...runner.getFlags().keys()]).toContain("acceptance");
		expect(runner.getCommand("acceptance")).toBeDefined();
	}, 30_000);

	it("discovers the acceptance-workflow skill from the package passed with -e", async () => {
		injectOmpExtensionCliRoots([PACKAGE], home, project);
		const provider = getCapability(skillCapability.id)?.providers.find(p => p.id === "omp-plugins");
		if (!provider) throw new Error("omp-plugins skill provider is not registered");
		const ctx: LoadContext = { cwd: project, home, repoRoot: project } as LoadContext;
		const skills = (await provider.load(ctx)).items as { name: string; path: string; frontmatter?: { description?: string } }[];
		const skill = skills.find(s => s.name === "acceptance-workflow");
		expect(skill?.path).toBe(path.join(PACKAGE, "skills", "acceptance-workflow", "SKILL.md"));
		expect(skill?.frontmatter?.description?.length ?? 0).toBeGreaterThan(40);
	});

	it("discovers the acceptance-verifier agent without edit or write tools", async () => {
		injectOmpExtensionCliRoots([PACKAGE], home, project);
		const { agents } = await discoverAgents(project, home);
		const verifier = agents.find(a => a.name === "acceptance-verifier");
		expect(verifier).toBeDefined();
		expect(verifier?.filePath).toBe(path.join(PACKAGE, "agents", "acceptance-verifier.md"));
		expect(verifier?.tools).toEqual(expect.arrayContaining(["read", "bash"]));
		expect(verifier?.tools).not.toContain("edit");
		expect(verifier?.tools).not.toContain("write");
	});
});
