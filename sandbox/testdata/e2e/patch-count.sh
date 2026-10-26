#!/usr/bin/env bash
# The sandbox e2e job's negative case (#641): make the registry's count
# return one more than it stores, a breaking return change signet dev --ci
# must catch (exit 10, the call named in JUnit).
set -euo pipefail
lib="$(dirname "$0")/../../../packages/contracts/identity-registry/src/lib.rs"
perl -0pi -e 's/(pub fn count\(env: Env\) -> u32 \{\n\s*Self::bump_instance\(&env\);\n\s*env\.storage\(\)\.instance\(\)\.get\(&DataKey::Count\)\.unwrap_or\(0\))/$1 + 1/ or die "count() not found in $ARGV\n"' "$lib"
