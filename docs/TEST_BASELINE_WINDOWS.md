# Windows test baseline

This baseline was recorded on 2026-09-03 from core commit `d3a248d` using
Node.js 24.20.0 on Windows.

## Summary

| Check | Result |
| --- | --- |
| Core test suite | 483 passed, 3 failed, 486 total |
| FX25 suite | 10 passed, 0 failed |
| Home Assistant add-on packaging | 7 passed, 0 failed |
| TypeScript production build | Passed |

The three core failures are existing Windows test-environment assumptions, not
FX25 or power-control regressions:

1. `tests/bridge/util.test.ts` expects POSIX `SIGTERM` reporting. On Windows the
   spawned Node process exits with code 1 instead.
2. Two cases in `tests/util/lgcloud/state.test.ts` use POSIX `/tmp` paths, which
   resolve to the nonexistent `C:\tmp` directory on Windows.

The OpenSSL SNI certificate integration test was skipped because `openssl` was
not available on `PATH`. Its unit-level hostname, cache, and TLS-option tests
passed.

## Commands

PowerShell was used to enumerate TypeScript test files because the package test
script contains the POSIX `find` command:

```powershell
$testFiles = (Get-ChildItem -LiteralPath tests -Recurse -Filter '*.test.ts').FullName
node --import tsx --test --test-reporter=spec $testFiles
```

The full suite must run outside the restricted Windows sandbox when Node 24
reports `uv_os_get_passwd returned ENOMEM` while loading `tsx`.

The package build script completed TypeScript compilation and alias rewriting,
then failed only because its final `cp -r` command is POSIX-specific. The
equivalent Windows build completed with:

```powershell
.\node_modules\.bin\tsc.cmd -p tsconfig.build.json
.\node_modules\.bin\tsc-alias.cmd -p tsconfig.build.json
Copy-Item -LiteralPath html -Destination dist -Recurse -Force
```

Add-on packaging was verified independently from the add-on repository:

```powershell
node --test tests/packaging.test.mjs
```

This document records the observed baseline without changing the product or
tests to hide platform-specific failures.
