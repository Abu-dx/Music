# Phase 1 Pilot Regression Gate (Design)

## Scope
- Keep default main flow stable.
- Validate pilot append flow with existing runtime profile.
- Validate explicit failure semantics when source path is unavailable.

## Case 1: main + pilot coexist, default remains main
1. Run a normal main separation and wait success.
2. Start one pilot separation on the same `projectId`.
3. Assert manifest contains:
   - `activeResultId = "main"`
   - `resultSets` has `main` and one `pilot_6s_*`
   - `stems` includes both `parentResultId=main` and `parentResultId=pilot_6s_*`
4. Restart app, reopen same project.
5. Assert `project:getResult` / `project:getStems` default read still resolves to main (no mixed stems).

## Case 2: restored project missing source path should fail explicitly
1. Prepare a restored project where:
   - `project.originalFilePath` is null/empty
   - renderer does not provide `sourceFilePath`
2. Trigger `project:startPilotSeparation`.
3. Assert start fails with explicit error code prefix:
   - `PILOT_SOURCE_PATH_REQUIRED`
4. Assert renderer shows actionable message:
   - ask user to re-select source audio file
5. Assert no silent fallback to stem/cache files is used.

## Pass Criteria
- Both cases pass.
- main default semantics unchanged.
- No worker protocol changes required.
