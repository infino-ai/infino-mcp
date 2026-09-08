// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dependency audit gate. Runs `npm audit` over production dependencies and
// fails on any high or critical advisory that is not named in
// .github/audit-allowlist.json. An allowlist entry is a decision with a
// deadline: it carries the advisory id, the package, the reason the advisory
// does not apply to this server, and an expiry date. An expired entry fails
// the gate exactly like a new advisory would, so an exemption is a reminder,
// not a permanent hole. An entry whose advisory has disappeared is reported
// so it gets pruned. No dependency beyond npm itself.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GATED = new Set(["high", "critical"]);

const allowlist = JSON.parse(
  readFileSync(new URL("../.github/audit-allowlist.json", import.meta.url), "utf8"),
);
for (const entry of allowlist) {
  for (const field of ["id", "package", "reason", "expires"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      console.error(`audit allowlist: entry ${JSON.stringify(entry)} is missing '${field}'`);
      process.exit(2);
    }
  }
}

// `npm audit` exits non-zero when it finds anything; the report is on stdout
// either way.
let raw;
try {
  raw = execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (err) {
  raw = err.stdout;
}
const report = JSON.parse(raw);

const today = new Date().toISOString().slice(0, 10);
const seen = new Set();
const failing = [];
const expired = [];
const allowed = [];

// Each vulnerable package lists what it is vulnerable `via`: advisory objects
// for its own advisories, or package names when it is only affected through a
// dependency. Only the advisory objects carry ids, and every chain bottoms out
// in one, so gating on those covers the chains too.
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== "object" || !GATED.has(via.severity)) continue;
    const id = String(via.url).split("/").pop();
    seen.add(id);
    const line = `${id}  ${via.name}  ${via.severity}  ${via.title}`;
    const entry = allowlist.find((a) => a.id === id);
    if (!entry) failing.push(line);
    else if (entry.expires < today)
      expired.push(`${line}\n      allowlisted until ${entry.expires}: ${entry.reason}`);
    else allowed.push(`${line}\n      allowlisted until ${entry.expires}: ${entry.reason}`);
  }
}

const stale = allowlist.filter((a) => !seen.has(a.id));
const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `npm audit (production): ${counts.total ?? 0} advisories ` +
    `(critical ${counts.critical ?? 0}, high ${counts.high ?? 0}, moderate ${counts.moderate ?? 0}, low ${counts.low ?? 0})`,
);
if (allowed.length) console.log(`\nallowlisted (${allowed.length}):\n  ` + allowed.join("\n  "));
if (stale.length) {
  console.log(`\nallowlist entries whose advisory is gone; remove them (${stale.length}):`);
  for (const a of stale) console.log(`  ${a.id}  ${a.package}`);
}
if (expired.length)
  console.log(`\nEXPIRED allowlist entries (${expired.length}):\n  ` + expired.join("\n  "));
if (failing.length)
  console.log(`\nUNALLOWLISTED high/critical advisories (${failing.length}):\n  ` + failing.join("\n  "));

if (failing.length || expired.length) {
  console.log(
    "\nFix the dependency, or add an allowlist entry with the reason it does not apply and an expiry date.",
  );
  process.exit(1);
}
console.log("\naudit gate: pass");
