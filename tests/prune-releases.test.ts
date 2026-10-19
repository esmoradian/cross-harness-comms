import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneReleases } from "../packages/core/src/lifecycle.ts";

// The launcher downloads each version's core to `<data>/releases/<version>/comms`. `pruneReleases` keeps the current version
// and the two newest other plain versions, by version order, removes older ones, ignores anything else, and never throws.

let data: string;
const releases = () => join(data, "releases");
beforeEach(() => { data = mkdtempSync(join(tmpdir(), "comms-prune-")); });
afterEach(() => rmSync(data, { recursive: true, force: true }));

function download(version: string) {
  mkdirSync(join(releases(), version), { recursive: true });
  writeFileSync(join(releases(), version, "comms"), `#!/bin/sh\necho ${version}\n`, { mode: 0o700 });
}
const entries = () => readdirSync(releases()).sort();

test("pruneReleases: keeps the current version and the two newest others by version order, removing the rest", async () => {
  // Lexical order would wrongly rank 0.1.9 and 0.1.8 above 0.1.10.
  for (const version of ["0.1.7", "0.1.8", "0.1.9", "0.1.10"]) download(version);
  await pruneReleases(data, "0.1.7");
  expect(entries()).toEqual(["0.1.10", "0.1.7", "0.1.9"]);
});

test("pruneReleases: counts newer versions than the current one among the two kept", async () => {
  for (const version of ["0.1.9", "0.1.10", "0.1.28", "0.1.29", "0.1.30", "0.2.0", "1.0.0"]) download(version);
  await pruneReleases(data, "0.1.29");
  expect(entries()).toEqual(["0.1.29", "0.2.0", "1.0.0"]);
});

test("pruneReleases: keeps the current version even when it has no directory, and leaves fewer than three alone", async () => {
  for (const version of ["0.1.28", "0.1.29"]) download(version);
  await pruneReleases(data, "0.2.0");
  expect(entries()).toEqual(["0.1.28", "0.1.29"]);
});

test("pruneReleases: ignores entries that are not plain version directories", async () => {
  for (const version of ["0.1.1", "0.1.2", "0.1.3", "0.1.4"]) download(version);
  mkdirSync(join(releases(), "latest"));
  mkdirSync(join(releases(), "0.0.9-dev.1"));
  mkdirSync(join(releases(), "v0.0.1"));
  writeFileSync(join(releases(), "0.0.1"), "a file named like a version\n");
  writeFileSync(join(releases(), "comms.12345"), "a leftover download\n");
  await pruneReleases(data, "0.1.4");
  expect(entries()).toEqual(["0.0.1", "0.0.9-dev.1", "0.1.2", "0.1.3", "0.1.4", "comms.12345", "latest", "v0.0.1"]);
});

test("pruneReleases: does nothing and does not throw when there is no releases directory", async () => {
  await pruneReleases(data, "0.2.0");
  expect(readdirSync(data)).toEqual([]);
  await pruneReleases(join(data, "missing"), "0.2.0");
  writeFileSync(releases(), "not a directory\n");
  await pruneReleases(data, "0.2.0");
  expect(readdirSync(data)).toEqual(["releases"]);
});
