# Security disclosure

A security report is held to a higher evidentiary bar than a bug report, because a wrong one is loud, public, and hard to walk back.

## Before anything else

Never file publicly. Use GitHub private security advisories, SECURITY.md instructions, or the maintainer's stated contact. A public issue for a real vulnerability is a disclosure failure regardless of intent.

## The bar for filing

All four must hold. If any one fails, it is not a report yet.

1. **Reachable.** You traced the untrusted input from a real entry point to the vulnerable line, and you named every validation layer on that path and why each one lets the value through. Type coercion, pydantic or zod schemas, enum parsing, and clamps kill most candidate findings at this step. Check for them explicitly.
2. **Attacker-controlled.** The value that causes the problem comes from someone outside the trust boundary. A config value only the operator can set is usually not a vulnerability, it is a footgun. Say which, honestly.
3. **Demonstrated.** You have a proof of concept that shows the impact, not a description of what would happen. If you cannot build one, describe precisely what stopped you.
4. **Not already known.** Search open and closed issues, existing advisories, the changelog, and recent commits touching that code.

## Impact, stated plainly

Write what an attacker gets, in concrete terms: reads arbitrary files as the running user, executes commands in the host context, bypasses the approval prompt for privileged tools, spoofs an allowlisted sender. Then state the preconditions honestly: local same-user access, a race window, a specific non-default setting.

Do not inflate severity. A finding that requires local same-user access is not Critical, and calling it Critical is the fastest way to have the real ones ignored.

## Report structure

```
## Summary
One sentence: what an attacker can do.

## Affected component
File, function, version or commit.

## Attack path
entry point -> each layer with what it does and does not validate -> vulnerable line

## Proof of concept
Minimal reproduction with observed output.

## Impact
Concrete capability gained, plus preconditions.

## Suggested fix
The smallest change that closes it, and what it might break.
```

## Common false positives

Check yourself against these before filing. Each one has closed many reports as invalid.

- The dangerous line is real but the input is schema-validated upstream, so the bad value never arrives.
- The "attacker" needs privileges that already imply full compromise, so nothing is gained.
- A TOCTOU window exists but requires same-user local access, where the attacker can already act directly.
- The behaviour is documented and intentional, and the docs say so.
- A hardcoded trusted flag looks like a bypass, but the surrounding call site is only reachable from an already-authorized path.

## After filing

Expect the maintainer to push back. Answer with code references, not restatements. If they show your trace is wrong, agree fast and say which hop you got wrong. Withdrawing one report cleanly costs far less than defending it badly.

Do not disclose publicly, blog, or post about it until the advisory is published or the embargo the maintainer set has passed.
