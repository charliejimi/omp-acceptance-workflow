import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { TITLES, closeRegistry, day17Spec, doTheDoableWork, loadPackage, makeFixture, removeTemps, tempDir, writeSpec } from "./helpers";

afterEach(() => {
	resetSettingsForTest();
	removeTemps();
});
afterAll(closeRegistry);

/** Runs `/acceptance <args>` with the runner's own command context and a UI that records what it is asked to show. */
async function runCommand(runner: ExtensionRunner, args: string): Promise<{ widget: string[]; notes: string[] }> {
	const command = runner.getCommand("acceptance");
	if (!command) throw new Error("the /acceptance command is not registered");
	const widgets = new Map<string, unknown>();
	const notes: string[] = [];
	const ui = {
		setWidget: (key: string, content: unknown) => widgets.set(key, content),
		notify: (message: string) => notes.push(message),
	};
	await command.handler(args, { ...runner.createCommandContext(), ui, hasUI: true } as never);
	const widget = widgets.get("acceptance");
	return { widget: Array.isArray(widget) ? (widget as string[]) : [], notes };
}

describe("/acceptance (AC-7)", () => {
	it("status shows the verdict from the session-end check and one line per task", async () => {
		const work = makeFixture();
		const specPath = writeSpec(tempDir("aw-spec-"), day17Spec());
		const { runner, stop } = await loadPackage(work, specPath);
		doTheDoableWork(work);
		await stop(["completed", "completed", "blocked", "blocked", "completed"]);
		const { widget, notes } = await runCommand(runner, "status");
		expect(widget[0]).toContain("INCOMPLETE");
		for (const title of TITLES) expect(widget.filter(line => line.includes(title))).toHaveLength(1);
		expect(widget.find(line => line.includes("Pass staging e2e"))).toMatch(/^fail/);
		expect(widget.find(line => line.includes("Change port to 8080"))).toMatch(/^pass/);
		expect(notes[0]).toContain("INCOMPLETE");
	}, 60_000);

	it("check reruns the checks, shows pass or fail per task, and leaves the verdict file unchanged", async () => {
		const work = makeFixture();
		const specPath = writeSpec(tempDir("aw-spec-"), day17Spec());
		const { runner, stop } = await loadPackage(work, specPath);
		doTheDoableWork(work);
		await stop(["completed", "completed", "blocked", "blocked", "completed"]);
		const verdictPath = specPath.replace(/\.json$/, ".verdict.json");
		const before = fs.readFileSync(verdictPath);
		fs.writeFileSync(`${work}/CHANGELOG.md`, "nothing useful\n");
		const { widget } = await runCommand(runner, "check");
		expect(widget[0]).toContain("not saved");
		expect(widget.find(line => line.includes("Write CHANGELOG.md"))).toMatch(/^fail/);
		expect(widget.find(line => line.includes("Change port to 8080"))).toMatch(/^pass/);
		expect(fs.readFileSync(verdictPath).equals(before)).toBe(true);
	}, 60_000);

	it("status says the result is stale and lists the latest todo claims after a change (AC-16)", async () => {
		const work = makeFixture();
		const specPath = writeSpec(tempDir("aw-spec-"), day17Spec());
		const { runner, stop, todoUpdate } = await loadPackage(work, specPath);
		doTheDoableWork(work);
		await stop(["completed", "completed", "completed", "completed", "completed"]);
		await todoUpdate(["completed", "completed", "blocked", "blocked", "completed"]);
		const { widget } = await runCommand(runner, "status");
		expect(widget[0]).toContain("stale");
		expect(widget.find(line => line.includes("Make bun test pass") && line.includes("blocked"))).toBeDefined();
	}, 60_000);

	it("status without --acceptance says no spec is configured", async () => {
		const { runner } = await loadPackage(makeFixture());
		const { widget } = await runCommand(runner, "status");
		expect(widget[0]).toContain("no spec is configured");
	}, 30_000);
});
