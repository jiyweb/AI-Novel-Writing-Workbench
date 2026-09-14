const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const desktopPackagePath = path.join(repoRoot, "desktop", "package.json");

const BUMP_KINDS = ["major", "minor", "patch"];

function printHelp() {
  console.log([
    "Usage: node scripts/bump-desktop-version.cjs [options] [X.Y.Z]",
    "",
    "Bumps desktop/package.json version before a desktop package release.",
    "",
    "Options:",
    "  (no arguments)   Auto bump the patch number, e.g. 0.4.24 -> 0.4.25",
    "  --patch          Auto bump patch (default in auto mode)",
    "  --minor          Auto bump minor, e.g. 0.4.24 -> 0.5.0",
    "  --major          Auto bump major, e.g. 0.4.24 -> 1.0.0",
    "  X.Y.Z            Set an explicit stable semver, must be greater than current",
    "  --dry-run        Print the resolved next version without writing the file",
    "  -h, --help       Show this help",
    "",
    "Environment:",
    "  AI_NOVEL_SKIP_VERSION_BUMP=1   Skip the auto bump (ignored when X.Y.Z is given explicitly)",
    "",
    "Versions must be stable semver without a leading v, for example 0.3.20.",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    version: "",
    bumpKind: "patch",
    kindFlagSet: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--patch" || arg === "--minor" || arg === "--major") {
      options.bumpKind = arg.slice(2);
      options.kindFlagSet = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.version) {
      throw new Error(`Unexpected extra version argument: ${arg}`);
    }
    options.version = arg.trim();
  }

  if (options.version && options.kindFlagSet) {
    throw new Error("Do not combine an explicit X.Y.Z with --patch/--minor/--major.");
  }

  return options;
}

function parseStableSemver(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`${label} must be stable semver like 0.3.20, got ${version || "(empty)"}.`);
  }
  return match.slice(1).map((part) => Number(part));
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) {
      return 1;
    }
    if (left[index] < right[index]) {
      return -1;
    }
  }
  return 0;
}

function bumpParts(parts, kind) {
  const [major, minor, patch] = parts;
  if (kind === "major") {
    return [major + 1, 0, 0];
  }
  if (kind === "minor") {
    return [major, minor + 1, 0];
  }
  return [major, minor, patch + 1];
}

function joinVersion(parts) {
  return parts.join(".");
}

function readDesktopPackageJson() {
  return JSON.parse(fs.readFileSync(desktopPackagePath, "utf8"));
}

function printNextSteps(nextVersion) {
  console.log([
    "",
    "Next release steps:",
    "1. Update docs/releases/release-notes.md and README.md for user-visible changes.",
    "2. Commit the version bump and release notes, then merge the release candidate into main.",
    "3. Run: node scripts/trigger-desktop-release.cjs --dry-run",
    `4. Publish with tag v${nextVersion} only after the dry run passes.`,
  ].join("\n"));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const packageJson = readDesktopPackageJson();
  const currentVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  const currentParts = parseStableSemver(currentVersion, "desktop/package.json version");

  // Auto mode (no explicit version): this is the packaging pipeline path and can be skipped.
  if (!options.version && process.env.AI_NOVEL_SKIP_VERSION_BUMP === "1") {
    console.log(`[desktop-version] auto bump skipped (AI_NOVEL_SKIP_VERSION_BUMP=1); keeping ${currentVersion}.`);
    return;
  }

  let nextVersion;
  let mode;
  if (options.version) {
    const nextParts = parseStableSemver(options.version, "Target version");
    if (compareSemver(nextParts, currentParts) <= 0) {
      throw new Error(`Target version ${options.version} must be greater than current version ${currentVersion}.`);
    }
    nextVersion = options.version;
    mode = "explicit";
  } else {
    if (!BUMP_KINDS.includes(options.bumpKind)) {
      throw new Error(`Unknown bump kind: ${options.bumpKind}`);
    }
    nextVersion = joinVersion(bumpParts(currentParts, options.bumpKind));
    mode = "auto";
  }

  console.log(`[desktop-version] current=${currentVersion}`);
  console.log(`[desktop-version] next=${nextVersion} (${mode === "auto" ? `auto ${options.bumpKind}` : "explicit"})`);

  if (options.dryRun) {
    console.log("[desktop-version] dry run; desktop/package.json was not changed.");
    if (mode === "explicit") {
      printNextSteps(nextVersion);
    }
    return;
  }

  packageJson.version = nextVersion;
  fs.writeFileSync(desktopPackagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  console.log(`[desktop-version] updated desktop/package.json to ${nextVersion}.`);
  if (mode === "explicit") {
    printNextSteps(nextVersion);
  }
}

try {
  main();
} catch (error) {
  console.error(`[desktop-version] ${error.message}`);
  process.exit(1);
}
