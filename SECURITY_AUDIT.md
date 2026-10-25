# Security and privacy review — Project Save (browser candidate)

**Date:** 2026-10-25
**Reviewer:** Claude (Anthropic, model Opus 5.5), an AI-assisted review requested by the project owner. This is **not** an independent human audit or a certification.
**Scope:** the complete source of the candidate listed below. No dependencies installed, nothing published, and only synthetic, disposable temp folders were used.
**Result:** **No network exfiltration or code-injection paths were found.** One deployment-level issue must be resolved before publishing (H1). Several privacy and reliability issues should be fixed or disclosed first (M1–M4).

## Reviewed snapshot

| File | SHA-256 |
|---|---|
| .gitignore | `4b2d60904ee80aa6a85801e92a83834a4e4534cd32a988f320ce1569baa955e0` |
| app.mjs | `f13aba79b0bca2508c8c82342d993c9d63870934dfc0fcd109ca672e52ced461` |
| backup.mjs | `1015b371ee4ae5521b4742f3b0ed2e2a20b1feb051e3f733d81ec317246d1966` |
| index.html | `6b843aa059c6146ba4af97037c5827f68167a8fa2d95dcf07c4e6e9933e43caf` |
| README.md | `bf976f30a5d938837d1b3cc07400e6bada2e6cfaf4d538bfb506bad2dbe72d3f` |
| style.css | `b8314036b35022d6ee640fe03c5f8dac8f50ed79d49de829b060da4795dbc3d4` |
| test.mjs | `604aafe737de4fe6e06f27d3a4939c0424f2b5a7ede406f3e7c0c6f0e53da28a` |

This review covers only these bytes. Any later change needs its own review. `node --test test.mjs` passed: 14/14 tests on Node 24.14.0.

## What was checked and held up

- **No network activity.** The code has no `fetch`, XHR, WebSocket, `sendBeacon`, `postMessage`, `window.open` or `location` writes. The page loads no third-party scripts, fonts, styles or analytics, and `style.css` has no `url()` or `@import`. The CSP (`default-src 'none'; connect-src 'none'; script-src 'self'; form-action 'none'; base-uri 'none'`) blocks application connections as a second layer.
- **No HTML injection.** File names, paths and the contents of `last-result.json` reach the page only through `textContent`. There is no `innerHTML`, `eval` or `Function`.
- **Least privilege.** The source folder is requested with `read` only. Preview needs only read access to the destination, and the test suite confirms Preview writes nothing.
- **Path safety.** `validPath` rejects empty, `.`, `..`, absolute, backslash, NUL and `:` segments. It is applied to scanned names, manifest keys, TAR/PAX member names and history archive names before any handle is created. Tests cover malicious manifest paths.
- **TAR/gzip parser.** It verifies header checksums, accepts only octal sizes, caps PAX records at 1 MiB, accepts only regular files and PAX `x` records, and refuses duplicate members and non-zero trailers. It never performs a general extraction: only named members are streamed to their sinks. Truncated and corrupt archives are rejected (tested).
- **SHA-256.** It matches Node `crypto` across block-boundary sizes and chunkings (tested). The length encoding is correct beyond 512 MiB.
- **Write ordering.** Previous bytes and the previous manifest are archived, re-read, verified and indexed in `history.json` before any `current/` file is overwritten. The new manifest is written last. Chrome's writable streams write to a swap file and replace the target on `close()`. The interruption test restores the previous state correctly.
- **Object-prototype names.** Files named `__proto__`, `constructor` and `hasOwnProperty` copy, verify, restore and re-run correctly (repro 6).

## Findings

Severity applies to a public GitHub Pages release. "Demonstrated" means it was reproduced with synthetic data. "Code-read" means it is established from the source but not run in a real browser.

### H1 — A shared `*.github.io` origin exposes saved folder handles to other sites under the same account (deployment, code-read)
If the app is served at `https://<user>.github.io/project-save/`, its origin is `https://<user>.github.io`. Every other GitHub Pages project of that user or organization shares that origin. Any of them, including a compromised or careless one, can:
- open the `project-save` IndexedDB and obtain the stored `FileSystemDirectoryHandle`s;
- use any folder permission already granted to the origin without a prompt (persistent "Allow on every visit" grants make this durable);
- otherwise trigger a permission prompt that names the trusted-looking origin.

The same applies to the `project-save-file-operation` Web Lock. The CSP does not help, because it applies only to this page.
**Repair:** serve the app from an origin used by nothing else: a custom domain or subdomain, or a dedicated GitHub account or organization whose `*.github.io` hosts only this app. Say this in the README publication section, and do not publish under a personal `github.io` that hosts other projects.

### M1 — Default exclusions miss common credential files, and the page overstates the protection (privacy, demonstrated — repro 1)
These files were all **included** in a backup: `id_rsa`, `id_ed25519`, `.ssh/id_ecdsa`, `.aws/credentials`, `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc`, `.envrc`, `*.p12`, `*.pfx`, `*.keystore`, `service-account.json`. The README says exclusions are not a secret scanner, but `index.html` says "environment secrets, private keys … are excluded by name", and `id_rsa` is a private key.
**Repair:**
- Add `.ssh` and `.aws` as excluded directories (also `.gnupg`, `.docker`, `.kube`).
- Exclude these file names: `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (not `*.pub`), `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc`, `.envrc`.
- Exclude these extensions: `.p12`, `.pfx`, `.keystore`, `.jks`.
- Reword `index.html` to "some common secret files are excluded by name; others will be copied". Add a test.

### M2 — Data that reaches the backup cannot be purged without breaking history (privacy, demonstrated — repro 7)
A file deleted from the source stays in `current/` and in every history archive that contains it. History is never pruned. A secret copied by mistake (see M1) therefore persists unencrypted on the drive. Deleting it by hand from `current/` or `history/` makes Verify or historical restore fail. `identity.json` also records the source folder's name.
**Repair:** document a purge procedure: delete the stale file from `current/`, and accept that the checkpoints that contain it are lost. Better, add an explicit "purge path" action that rewrites the affected archives and updates `history.json`. Mention it in the privacy section.

### M3 — One unreadable source file aborts the whole backup (reliability, demonstrated — repro 2)
A `NotReadableError` on a single file, for example one locked by another program on Windows, ends `copy()`. No manifest is written, so on a first backup nothing is recorded as protected.
**Repair:** catch read errors for each file, record them in a `failed` list, keep the previous manifest entry for those paths, commit everything else, and show the failures prominently. Treat the run as incomplete, not successful.

### M4 — No on-disk lock; an unfinished operation record is ignored (concurrency, demonstrated — repro 3)
Web Locks work only within one origin and one browser profile. A second browser, profile or machine writing to the same drive is not blocked. `copy()` also never reads `.project-save/operation.json`: it runs over a `complete:false` record without warning. The README's "can help diagnosis" is never surfaced to the user.
**Repair:** before writing, read `operation.json`. If it is incomplete and recent (or carries another lease ID), warn and ask for confirmation. Write a lease containing a random ID and a heartbeat time, and re-check it before the manifest commit. Show "last operation was interrupted" in the UI.

### L1 — Historical restore decompresses the archive once per file (resource use, demonstrated — repro 4)
Restoring 40 files from one archive needed 43 full decompressions, because `restore()` calls `inspectArchive` for each file. For large archives, time grows with files × archive size.
**Repair:** group the needed members by archive and make one `inspectArchive` pass per archive, with a sink `Map` that holds every needed path.

### L2 — Malformed metadata raises `TypeError` instead of a clear refusal (robustness, demonstrated — repro 5)
A `history.json` record without `members`, or a manifest entry of `null`, crashes with a raw `TypeError`. No unsafe write follows.
**Repair:** validate `history.json` (name, a 64-hex `sha256`, a `members` object of path → hash) the way `validateManifest` does, and reject non-object entries in `validateManifest`.

### L3 — No framing protection (theoretical)
A `<meta>` CSP cannot set `frame-ancestors`, and GitHub Pages cannot send `X-Frame-Options`. Chrome blocks directory pickers in cross-origin iframes and partitions their storage, so the risk is low.
**Repair:** at startup, `if (window.top !== window.self)` disable every action and show a notice.

### L4 — Name-based exclusions can silently drop real work (data loss, demonstrated — repro 1)
The excluded patterns include single-file Keynote documents (`talk.key`), any `.db` file, and any folder named `build`, `dist`, `temp`, `tmp` or `coverage` at any depth (for example `build/chapter.docx`). Preview lists these exclusions, but users may not read the list.
**Repair:** show the skipped count prominently before the first backup. Consider matching folders such as `build` and `dist` only where a project marker is present (for example `package.json` or `pyproject.toml`), or making exclusions editable.

### L5 — Verify does not check history archives (reliability, code-read)
Archive corruption is found only at restore time.
**Repair:** add an optional "Verify history" that re-hashes every archive against `history.json`.

## Theoretical risks that remain by design (disclose, do not fix)
- **Compromised hosting.** Whoever can change the deployed files, through the GitHub account, the repository or a Pages takeover, gets the same folder access users granted. Neither CSP nor hashes give authenticity. Mitigations:
  - turn on 2FA and branch protection, and restrict who can deploy;
  - publish signed tags, with release file hashes in the release notes;
  - offer a self-hosted option at a pinned commit.
- **Backups are unencrypted.** Paths, names and hashes are readable by anyone with the drive. The README already says so.
- **Pages logs.** GitHub Pages logs visitor IP addresses. The README already says so.

## Not tested — needs real-browser validation before release
- Folder picker grants, permission expiry and re-grant, and "Allow on every visit" behavior.
- Whether `showDirectoryPicker` and `requestPermission` still have user activation when called after the Web Lock `await`.
- Symlinks and Windows junctions inside the source, especially a junction pointing at the backup folder, which `assertSeparate` cannot detect.
- Leftover `.crswap` files after a crash, and real atomicity on drive removal or a full disk.
- Unicode NFC/NFD name collisions (macOS).
- Memory and time on projects with 10⁵ or more files.

## Claims to correct before publishing
- `index.html` privacy text: secrets and private keys are only **partly** excluded (M1).
- `index.html` and `README.md` say "not yet independently security-reviewed". That remains accurate after this AI-assisted review. Keep it until a human review is done, and link this file.

## Reproductions
The synthetic scripts used for repros 1–7 are kept with the private review materials and can be re-run with `node repro.mjs <path-to>/backup.mjs`. They use Node adapters like those in `test.mjs`; they are not evidence of browser behavior.

---

# Re-review — remediated snapshot

**Date:** 2026-10-25. Same reviewer and limits as above: AI-assisted, not an independent human audit. Synthetic temp folders only; nothing published or installed.
**Result:** the fixes for the original findings work as described, and **no network exfiltration or code-injection paths were found**. Four new medium issues were found, all reproduced. Fix them before release. Public deployment remains blocked until a dedicated origin is chosen (H1).

## Reviewed snapshot (re-review)

| File | SHA-256 |
|---|---|
| .gitignore | `4b2d60904ee80aa6a85801e92a83834a4e4534cd32a988f320ce1569baa955e0` |
| LICENSE | `166dc03be81c585bfbb85935bccc2a21edf18c19b2cd202ab5b328a2477b45f3` |
| app.mjs | `81f11530b595b66283ededd531d21dbd4b14174e5e9154181b87a637bced1ebc` |
| backup.mjs | `5b4b9b9b7a1b8627a00456db47fdab30ebd5c7af325ad108d97d5b078023c102` |
| index.html | `724d7efc0db92c312850f38f0d32223f596b405d7af736b360d6a8909d7bef21` |
| README.md | `53e68f72f450e7cbb8fdfcc795dbd8a034cbb36c121d06ffa6c00b0b5ad5cf1d` |
| style.css | `2db13f91d1df5990604492c21438b92be77848377c49225f715bed1633aa22b8` |
| test.mjs | `c4cff76c5e47d46ca66d818301c6778fbbfa5104f381a4375010481fac58aea7` |

`node --test test.mjs`: 28/28 tests passed (Node 24.14.0). The original repro script was re-run, and a second script (`project_save_security_repro2.mjs`, R1–R7) was added for this pass. Both are kept with the private review materials.

## Status of the original findings

| ID | Status | Evidence |
|---|---|---|
| H1 shared origin | **Fixed in code; deployment still open.** File actions are disabled unless the page runs on localhost or the one configured HTTPS origin. The check runs before IndexedDB is opened. See N8 for a remaining gap. | R7; `deploymentPolicy` |
| M1 credential files | **Fixed.** None of the 13 credential fixtures is copied any more. The page wording is corrected. | repro 1 |
| M2 retained data | **Documented only.** The README gives a manual "retire the whole backup set" procedure. There is no selective purge, and backups are still unencrypted. | README §Privacy |
| M3 unreadable file | **Fixed**, with a gap (N3). Partial backups now commit and are labelled. | repro 2 |
| M4 concurrent writers | **Reduced, not eliminated.** A lease on the drive and an interrupted-run check were added. This is best-effort, with no atomic compare-and-swap. See N4. | repro 3, R3 |
| L1 repeated decompression | **Fixed.** Restoring 40 files now makes 4 archive reads: 1 checksum read and 3 decompressions. Before the fix it took 43. | repro 4 |
| L2 malformed metadata | **Mostly fixed.** History and manifest rows are validated. See N6 for what remains. | repro 5 |
| L3 framing | **Fixed in code.** A page shown inside a frame disables all actions. | R7 |
| L4 over-exclusion | **Reduced.** Skipped counts, a confirmation step and include overrides were added. See N5. | — |
| L5 history verification | **Fixed.** History can be checked on request. | code-read |

Verified correct in this pass:
- The order of the abort/commit steps when copying a file (`copyFile`): the source is re-hashed and the lease checked before `close()`, and a source failure aborts the write.
- Directories that fail to read keep their earlier manifest entries and are not reported as stale.
- Restoring several files from one archive now opens one output file at a time, and output files are aborted if the restore fails.
- File controls stay disabled until the risk notice is acknowledged.
- The CSP is unchanged and still blocks all connections.

## New findings

### N1 — Medium — Names that differ only in letter case lose a file, and the backup still reports success (demonstrated, R1)
A source on a case-sensitive filesystem (Linux, or case-sensitive APFS) can contain `Notes.txt` and `notes.txt`. On the usual NTFS or exFAT backup drive they map to the same file. The second copy overwrites the first, each copy passes its own check, and the run reports `backupComplete: true, copied: 2` while `current/` holds one file. Verify then flags `Notes.txt`. Restoring the current backup then fails completely (see N2). Unicode NFC/NFD pairs (two encodings of the same accented name) are expected to behave the same way; that was not tested.
**Repair:** during `scan()`, group paths by `path.normalize('NFC').toLowerCase()`. Report every member of a colliding group as `failed`, with the reason "name differs only by case or Unicode form", and do not copy them. Apply the same check to a manifest before restoring.

### N2 — Medium — One unrecoverable file blocks the entire restore (demonstrated, R1; code-read)
`restore()` plans every file before writing anything, and throws `No verified copy is available for: <path>` at the first file it cannot recover. So a single damaged or colliding file makes all other files unrecoverable from the app.
**Repair:** restore every file that can be verified, list the ones that cannot, and return `verified: false` with a "partial restore" label. Partial backups (`manifestIncomplete`) are already labelled this way.

### N3 — Medium — A failed repair copy clears Verify's repair flag, and the damaged backup copy is trusted again (demonstrated, R2)
Verify finds `current/x` damaged (same size and modification time). The next backup tries to recopy `x`, but the source is locked, so the copy fails. That run still writes `findings.json` as `{repair: []}`. The following backup copies nothing and reports `backupComplete: true`, and the damaged bytes (`"BAD!"`) remain in `current/`. The problem stays hidden until someone runs Verify again.
**Repair:** after a backup, write `repair` as the earlier repair paths that were not successfully recopied, plus all `failed` paths.

### N4 — Medium — Lease refresh relies only on a 15-second timer, so long runs in a background tab can lose their own lease (mechanism demonstrated, R3; browser timing untested)
The lease expires after 60 seconds and is refreshed only by `setInterval`. Chrome slows timers in hidden tabs; after 5 minutes hidden, timers may fire only once a minute. R3 stops the timer and moves the clock forward 61 seconds: the run aborts with "lease was lost or expired" and leaves `operation.json` marked incomplete, so the next backup needs the recovery confirmation. A single large file that takes more than 60 seconds is exposed in the same way.
**Repair:** in `TargetLease.assert()` (called before every commit), renew the lease whenever the last heartbeat is more than 15 seconds old, and renew it every few MB during long copies. Consider a longer expiry, such as 5 minutes, together with that inline renewal. Test in Chrome with the tab hidden.

### N5 — Low — Including a folder also includes every secret and cache folder inside it (demonstrated, R5)
With the include override `build/keep`, the backup also takes `build/keep/.env`, `build/keep/id_rsa` and `build/keep/node_modules/…`. The page says overrides "can include credentials", but users would not expect a folder override to switch off all exclusions beneath it.
**Repair:** apply an override only to the path named. Keep the default exclusions for anything inside it unless those paths are listed separately. List the affected paths in the confirmation dialog.

### N6 — Low — Some metadata is still unvalidated, and a stuck lease has no documented recovery (demonstrated, R6)
- `manifest.failed` is not validated. A string value passes through `restore()` and would break the result display after a successful restore.
- A `lease.json` with an expiry far in the future locks the destination indefinitely, and the README does not say how to clear it.
- Leases compare expiry times taken from different machines' clocks, so a machine whose clock runs ahead can treat a live lease as expired.

**Repair:**
- Validate `failed` as an array of `{path, scope, error}` objects.
- Treat any lease expiring more than twice its normal lifetime ahead as stale.
- Document how to remove `.project-save/lease.json` once no other writer is running.
- Note in the README that two machines' clocks must agree.

### N7 — Low — Verify is refused after an interrupted run (demonstrated, R4)
`verify()` takes the write lease without the recovery flag, so it throws on an incomplete `operation.json`. Its own "Previous write was interrupted…" note can never be shown. Restore still works.
**Repair:** allow Verify to read and check the last committed manifest, and skip writing `findings.json` while a run is marked interrupted. Otherwise, remove the unreachable note.

### N8 — Low — The origin check cannot tell a shared `*.github.io` origin apart (demonstrated, R7)
If `DEDICATED_PUBLIC_ORIGIN` is set to `https://user.github.io`, every project path on that origin passes the check. That is exactly the H1 situation, now enabled by a configuration mistake.
**Repair:** when the host ends in `.github.io`, allow only a site served from the root (`/`), meaning a dedicated user or organization site, and refuse project-path deployments.

### N9 — Untested — Permission prompts may arrive after the browser's click allowance expires (code-read)
Chrome lets a page call `requestPermission` only shortly after a user click (about 5 seconds).
- **Restore** asks for read access to the backup folder only after the output-folder picker closes.
- **Remember this pair** and **Preview/Backup/Verify** ask for permissions after waiting on a Web Lock. Remember this pair asks for two permissions in a row.

If a saved folder is not already granted in that session, these calls may fail with a `SecurityError`.
**Repair:** request the backup folder's read permission in the Restore click handler before opening the output picker, or add a "Reconnect folders" button that only requests permissions. Test each flow in Chrome and Edge with a freshly opened tab.

## Remaining release gates
- No dedicated origin has been chosen, verified or protected against takeover (H1).
- All browser-only checks from the first review are still pending, plus N4 and N9.
- `LICENSE` has no file extension, and GitHub Pages may serve it as a download rather than a page. Consider linking to the repository copy, or adding a `LICENSE.txt` copy for the page link.
- The legal effect of the MIT disclaimer and the risk notice needs qualified advice; this review does not assess it.

---

# Third review — second remediation

**Date:** 2026-10-25. Same reviewer and limits as above: AI-assisted, not an independent human audit. Synthetic temp folders only; nothing published or installed.
**Result:** the N1–N9 fixes work as described. The CSP is unchanged, and **no network, exfiltration or code-injection paths were found** (`fetch`, XHR, beacon, WebSocket, `innerHTML`, `eval` and `window.open` are all absent). The page's only links are local. There are no new security or privacy findings. Four reliability issues remain, all involving unusual file names or stale repair flags; S1 and S2 are medium. Public deployment is still blocked on a dedicated origin (H1).

## Reviewed snapshot (third review)

| File | SHA-256 |
|---|---|
| .gitignore | `4b2d60904ee80aa6a85801e92a83834a4e4534cd32a988f320ce1569baa955e0` |
| LICENSE.txt | `166dc03be81c585bfbb85935bccc2a21edf18c19b2cd202ab5b328a2477b45f3` |
| app.mjs | `cf51e786ae1d54bef2d52842d1c5875bf5d774345530d0e57c34cb7cd141a08d` |
| backup.mjs | `f5a9ff3899a18f5b62b1da58cf504b83e715a929cdcc271b2d4a012ce9e20aa6` |
| index.html | `13eaeee8ad477290e9e9b3133f96b6529799b66ae8609041af2cff89011f2c2d` |
| README.md | `f63c883b586f20e26772adf6a241ab17cb1c44441ada252d75cae989aa7b3757` |
| style.css | `f898f32e8372afcd64172e9a554d685ae8c27cdcc63208585ae6bd5c42c94069` |
| test.mjs | `a6c17e176e5496dadce9ac1a62f079641ed8646f6ad66bad42f8dd4f42cb340e` |

`node --test test.mjs`: 37/37 tests passed (Node 24.14.0). Repro 1–7 behave as fixed. R1–R5 behave as fixed. R6 now stops with a "Damaged manifest failures" refusal: this is the intended validation and is counted as a pass. A third script, `project_save_security_repro3.mjs` (S1–S4), is kept with the private review materials.

## Status of N1–N9

| ID | Status | Evidence |
|---|---|---|
| N1 case/Unicode collisions | **Fixed, conservatively.** Every colliding file is marked failed and not copied; the run reports incomplete. It errs too far toward caution; see S4. | R1 |
| N2 all-or-nothing restore | **Fixed.** Healthy files are restored, failures are listed, and the result is labelled `restoreComplete:false`. A failing output file is aborted on its own; extraction still makes one pass per archive. | R1 (restored 0 / failed listed); code-read |
| N3 cleared repair flags | **Fixed.** The flag stays set until the recopy succeeds. See S3 for one leftover case. | R2 (backup restored to `good`) |
| N4 timer-only lease | **Fixed in the engine.** Leases now last 5 minutes and are renewed inline every 8 MiB of copying, hashing and archive work; the timer is only a fallback. If another owner takes over, the run aborts before its next commit. | R3 passes with the timer disabled |
| N5 folder override | **Fixed.** An override admits only the named path; nested `.env`, `id_rsa` and `node_modules` stay excluded. | R5 |
| N6 metadata / stuck lease | **Fixed.** Failure lists, completion flags and leases are schema-checked. An implausibly far-future lease is refused, and the README now documents the manual reset. | R6 |
| N7 Verify after interruption | **Fixed.** Verify runs read-only, and writes nothing while the last run is marked interrupted. | R4 |
| N8 github.io | **Fixed.** Every `*.github.io` host is refused. | code-read (`deploymentPolicy`) |
| N9 user activation | **Reduced in structure.** Only the explicit Reconnect buttons request permission, synchronously from the click. Every other action only queries permission, and pickers open before any lock. Real Chrome/Edge behavior is still untested. | code-read |

On the lease: two writers that read and write the lease at the same moment can both briefly believe they hold it. Each re-reads the lease before every commit, so the one that lost aborts. The worst case seen in code reading is an unindexed orphan archive file. This is not atomic mutual exclusion, and "one writer per destination" remains a rule users must follow.

## New findings

### S1 — Medium — One file name with `:` stops the scan of its whole folder (demonstrated, S1)
`scan()` calls `validPath` on each name inside the `try` that guards the whole directory listing. A single name with `:`, which Linux and macOS allow (for example `meeting 10:30.txt`), therefore throws out of the listing. The folder is recorded as failed, and any entries not yet listed are skipped. In S1, `z.txt` and `docs/d.txt` were never scanned after the `:` file, and the root folder was marked failed. The run is correctly reported as incomplete, but much of the project goes unprotected until that one file is renamed.
**Repair:** check names entry by entry: record an invalid name as a file-level failure (or as a skipped entry) and keep listing. Add a test with an invalid name in the middle of a folder.

### S2 — Medium — A name the backup drive rejects aborts every run, permanently (demonstrated with Node/Windows, S2; browser error type untested)
Some source names are legal on Linux or macOS but rejected by NTFS or exFAT backup drives: `?`, `*`, `"`, `<`, `>`, `|`, a trailing dot or space, and names such as `CON` or `aux.txt`. Creating the destination handle for such a file throws an error that is not treated as a source failure, so `copy()` aborts. The run is left marked interrupted, and the first backup never writes a manifest. Each confirmed retry fails the same way, so no other file is ever protected.
**Repair:**
- Before copying, check each path against a portable-name rule: no `<>:"|?*`, no control characters, no trailing dot or space, no Windows reserved names. Record any path that fails it as a file-level failure.
- Treat the remaining errors from creating a single destination file the same way, as file failures rather than run-level aborts.
- Keep run-level aborts for errors that affect the whole drive, such as `QuotaExceededError` or a lost drive or lease.

### S3 — Low — A repair flag for a deleted or newly excluded file never clears (demonstrated, S3)
`gone.txt` failed once (it was locked), and was then deleted from the source. Every later backup still reports `backupComplete:false` with `pendingRepairs:["gone.txt"]`, because pending flags are dropped only after a successful recopy. Running Verify clears it, but Backup alone never does.
**Repair:** when a backup builds its pending list, drop flagged paths that are no longer in the source scan, the new manifest, or a failed folder.

### S4 — Low — Folders whose names differ only by case leave both folders unprotected (demonstrated, S4)
A source with `Docs/a.txt` and `docs/b.txt` fails both files, and every file beneath both folders, permanently. On a case-insensitive drive the two folders simply merge, and their files never collide.
**Repair:** treat only file-vs-file collisions and file-vs-folder conflicts as failures. Folder-vs-folder case variants are safe to merge, and any real clash among their files is still caught by the full-path check.

## Remaining release gates (unchanged)
- **H1:** no exclusive custom HTTPS origin has been chosen, verified or protected against takeover.
- **Real-browser checks still pending:**
  - picker grants, re-grants and Reconnect;
  - hidden or frozen tabs during long runs;
  - symlinks and junctions;
  - drive unplug, full disk and browser close;
  - Unicode normalization;
  - very large file inventories.
- **M2:** stays a documentation-only mitigation. There is no purge feature, and backups are unencrypted.
- **Legal:** the effect of the MIT disclaimer and the risk notice needs qualified advice.

---

# Fourth review — third remediation

**Date:** 2026-10-25. Same reviewer and limits as above: AI-assisted, not an independent human audit. Synthetic temp folders only; nothing published or installed.
**Result:** the S1–S4 fixes work as described. This pass changed only `backup.mjs`, `test.mjs` and `README.md`. `app.mjs`, `index.html`, `style.css` and the CSP are byte-identical to the third review. **No new security or privacy findings.** One medium reliability issue (U1) and two low ones were found. Public deployment is still blocked on a dedicated origin (H1).

## Reviewed snapshot (fourth review)

| File | SHA-256 |
|---|---|
| .gitignore | `4b2d60904ee80aa6a85801e92a83834a4e4534cd32a988f320ce1569baa955e0` |
| LICENSE.txt | `166dc03be81c585bfbb85935bccc2a21edf18c19b2cd202ab5b328a2477b45f3` |
| app.mjs | `cf51e786ae1d54bef2d52842d1c5875bf5d774345530d0e57c34cb7cd141a08d` |
| backup.mjs | `95b0c97f979d21511202de5c3adb7dc3f0b7bedf0a06b4bca6b03e23e753fff9` |
| index.html | `13eaeee8ad477290e9e9b3133f96b6529799b66ae8609041af2cff89011f2c2d` |
| README.md | `d0331da6b10a8b58b35d33ca7a4011266dbe47273423b59c31629749aa789fc2` |
| style.css | `f898f32e8372afcd64172e9a554d685ae8c27cdcc63208585ae6bd5c42c94069` |
| test.mjs | `9824873acb6ceab6914c65f40512df9825d12ba393b7a788a12f6c87ddd6604f` |

`node --test test.mjs`: 43/43 tests passed (Node 24.14.0). Repro 1–7, R1–R5 and S1–S5 all behave as fixed; R6 still stops with its intended validation refusal. The engine changes were reviewed as a diff against the previous frozen package (`backup.mjs` `f5a9ff38…`). A fourth script, `project_save_security_repro4.mjs` (T1–T3), is kept with the private review materials.

## Status of S1–S4

| ID | Status | Evidence |
|---|---|---|
| S1 `:` name stops the folder scan | **Fixed.** Unsupported names become per-entry failures, marked `unsupportedName`, and the scan continues. These failure records are only displayed: they never enter repair flags or file reads and writes, and `validateFailures` checks their shape. | S1: `a.txt`, `z.txt`, `docs/d.txt` kept |
| S2 name rejected by the backup drive | **Fixed.** Portable-name rules apply before the destination is touched, and the expected naming or type errors become per-file failures. Quota and other errors still abort the run. | S2: partial results committed, `operation.complete:true` |
| S3 stale repair flag | **Fixed.** Repair flags are kept only for active or retained files, or for files under a folder that failed to read. | S3: incomplete, then complete twice |
| S4 folder-name aliases | **Fixed.** Folder-vs-folder aliases are now allowed. Real file-vs-file and file-vs-folder clashes are still refused, in both backup and restore. | S4: all three files admitted |

The stale list now matches names case-insensitively, so a case-only rename is no longer reported as stale (S5). On a case-sensitive backup drive, the old spelling then stays in `current/` without being listed as stale. That is acceptable, because restore follows the manifest, but users who rely on the stale list to find retained files should know it. The README already says retained bytes are never deleted automatically.

## New findings

### U1 — Medium — Replacing a file with a folder of the same name, or the reverse, blocks that path permanently (demonstrated, T1/T2)
The app never deletes from `current/`, so the obsolete entry stays there and conflicts with the new type:
- **T1:** `notes` was a file and is now the folder `notes/` containing `today.txt`. Creating `current/notes/today.txt` hits the old file `current/notes` and throws `TypeMismatchError`.
- **T2:** `docs/` was a folder and is now a file named `docs`. The same thing happens in reverse.

Both cases are reported correctly as `backupComplete:false` rather than silently, but the new work is **never** protected on any later run. Turning a single file into a folder of related files is a common way to reorganize a project. The obsolete entry is already preserved, verified, in a history archive by `archivePrevious` (it counts as a "removed" path), so moving it aside would lose nothing.
**Repair options** (this is a design decision for the owner):
1. After the verified history archive is written and indexed, move the obsolete conflicting entry out of the way, for example into `current/.project-save-obsolete/<timestamp>/…`, using `FileSystemHandle.move()` where it is supported. Record the move in the operation log.
2. Keep the obsolete entry and store the new item at an alternative destination path, recorded in its manifest entry (for example a `targetPath` field), which restore and verify then follow.

Option 1 keeps `current/` readable, but it changes the published rule "no destination files are deleted or moved". Option 2 keeps that rule but makes `current/` harder to browse. Add T1/T2 as regression tests.

### U2 — Low — The macOS folder-icon file `Icon\r` makes backups of that tree permanently incomplete (demonstrated, T3)
macOS creates a file named `Icon` followed by a carriage return in every folder that has a custom icon. The portable-name check rejects the control character, which is correct, but the file is OS metadata like `.DS_Store`. As it stands, every Mac folder with a custom icon leaves the backup reporting incomplete.
**Repair:** add `Icon\r` to the OS-metadata exclusions next to `.DS_Store` and `Thumbs.db`, and run the exclusion check *before* the portable-name check, so that excluded entries count as skipped rather than failed.

### U3 — Low — `destinationNameError` counts every `TypeError` and `SyntaxError` as a per-file naming failure (code-read)
Chrome does throw `TypeError` for names it rejects, which justifies including it. But a genuine programming error or another unexpected `TypeError` in the handle-creation path would then become a quiet per-file failure instead of stopping the run.
**Repair:** for `TypeError` and `SyntaxError`, count the error as a naming failure only if the path also fails `unsupportedPath` or the browser's message indicates an invalid name. Otherwise let it abort the run. Keep the explicit `TypeMismatchError` / `InvalidModificationError` / `ENOTDIR` / `EISDIR` cases.

## Remaining release gates (unchanged)
- **H1:** no exclusive custom HTTPS origin has been chosen, verified or protected against takeover.
- **Real-browser checks still pending:**
  - picker grants, re-grants and Reconnect;
  - hidden or frozen tabs during long runs;
  - symlinks and junctions;
  - drive unplug, full disk and browser close;
  - Unicode normalization;
  - very large file inventories;
  - the exact error names Chrome and Edge throw for rejected or conflicting names (the U3 classification depends on them).
- **M2:** stays a documentation-only mitigation. There is no purge feature, and backups are unencrypted.
- **Legal:** the effect of the MIT disclaimer and the risk notice needs qualified advice.

---

# Final review — fourth remediation

**Date:** 2026-10-26. Same reviewer and limits as above: AI-assisted, not an independent human audit. Synthetic temp folders only; nothing published or installed.
**Result:** U1–U3 are fixed. **No new security, privacy or reliability findings.** No finding from these five reviews remains open in the code. What remains are the release gates listed at the end, which code review cannot close.

## Reviewed snapshot (final)

| File | SHA-256 |
|---|---|
| .gitignore | `4b2d60904ee80aa6a85801e92a83834a4e4534cd32a988f320ce1569baa955e0` |
| LICENSE.txt | `166dc03be81c585bfbb85935bccc2a21edf18c19b2cd202ab5b328a2477b45f3` |
| app.mjs | `cf51e786ae1d54bef2d52842d1c5875bf5d774345530d0e57c34cb7cd141a08d` |
| backup.mjs | `58f8c7cd78663d08526b789920fbfcc3b6ffd41f06b31025abd6cea290d27b63` |
| index.html | `6096c4658edd4fe4bb7847cd5a65db8a98b68eafd73d0d46b8c2745c480575e4` |
| README.md | `626fad29cd9250cd952693aa7f55b538a89517cee145bc912f5ba2b563bfb1ae` |
| style.css | `f898f32e8372afcd64172e9a554d685ae8c27cdcc63208585ae6bd5c42c94069` |
| test.mjs | `4dca1599fb8fa2dfdc5ff7e727ac7556e5d551f394e1ae2329479f1b0e22a534` |

These hashes identify the reviewed release candidate. Any later change to these files is outside this review.

`node --test test.mjs`: 49/49 tests passed (Node 24.14.0). Repro 1–7, R1–R5, S1–S5 and T1–T3 all behave as fixed; R6 still stops with its intended validation refusal. The engine was reviewed as a diff against the previous frozen package (`backup.mjs` `95b0c97f…`). `app.mjs` is byte-identical to that package. The only change to `index.html` is one sentence of restore wording; the CSP is unchanged. A fifth script, `project_save_security_repro5.mjs` (V1–V3), is kept with the private review materials.

## Status of U1–U3

| ID | Status | Evidence |
|---|---|---|
| U1 file ↔ folder blocker | **Fixed, using alternate storage as the owner chose.** A blocked new file is written to `.project-save/objects/<uuid>`, and its manifest entry records that `targetPath`. Copy, Verify, history archives, restore and repair all follow the mapping. Existing backup items are never moved or deleted. | T1/T2 complete, then repeat with zero copies. **V1:** five alternating file/folder states: every run complete, Verify passes, and the current backup and all four checkpoints restore byte-exact. |
| U1 mapping safety | `targetPath` is accepted only in `project-save-browser-v2` manifests, only in the form `.project-save/objects/<lowercase UUID>`, and never twice. Older engines refuse v2 manifests instead of silently ignoring the mappings. | **V3:** paths pointing at metadata, traversal paths, uppercase UUIDs and `current/` paths are all refused before any file read or write. |
| U2 `Icon\r` | **Fixed.** That exact name is skipped as OS metadata before the name check runs. Other control-character names still fail. | T3 complete, with no failures |
| U3 error classification | **Fixed.** Only named `DOMException`s and explicit filesystem error codes count as per-file naming failures. A plain `TypeError` or `SyntaxError` aborts the run. | Sol's regression tests; code-read |

Two notes, informational only:
- **Abort over skip.** If a browser rejects a name with a plain `TypeError` for a reason the portable-name rules don't cover, the run now aborts rather than skipping that file. This is the safer failure mode, but confirm Chrome and Edge error names in real-browser testing.
- **Retained objects are not listed as stale.** Objects left behind by deleted mapped files (2 in V2) do not appear in the stale list. The README states that unreferenced objects are kept and never pruned, and the manual purge procedure removes all of `.project-save/`. So this is disclosed, but users should not rely on the stale list as a complete inventory of retained bytes.

## Summary across all five reviews

| Review | Findings | Status in the final snapshot |
|---|---|---|
| 1 (original) | H1, M1–M4, L1–L5 | All fixed in code, except M2 (documented manual purge; no purge feature) and H1 (deployment gate). |
| 2 | N1–N9 | All fixed. N9 is a structural fix that still needs a real-browser check. |
| 3 | S1–S4 | All fixed. |
| 4 | U1–U3 | All fixed. |
| 5 (final) | none | — |

**Verified throughout every review:**
- no network requests or exfiltration paths;
- no third-party code or resources;
- a CSP that blocks all connections;
- no HTML or script injection;
- read-only access to the source;
- strict path validation on every manifest, archive and mapping path;
- previous versions verified and indexed before anything is overwritten.

## Release gates (not closable by code review)
- **H1:** choose, verify and protect against takeover an HTTPS origin used **only** by Project Save. `*.github.io` is refused by design.
- **Real Chrome/Edge testing:**
  - folder picker grants, re-grants and Reconnect;
  - hidden or frozen tabs during long runs;
  - symlinks and junctions;
  - drive unplug, full disk and browser close during writes;
  - Unicode normalization on macOS;
  - the exact browser error names for rejected or conflicting names;
  - very large file inventories.
- **M2:** backups are unencrypted and there is no selective purge. Users must follow the documented manual retirement procedure.
- **Hosting integrity:** whoever controls the deployed files gets the folder access users granted. Protect the account (2FA, branch protection) and publish release hashes.
- **Legal:** the effect of the MIT disclaimer and the risk notice needs qualified advice.
- **Independent review:** this is an AI-assisted review, so a human security review is still advisable before a wide release. Keep the README and page wording "not independently human-audited" until one has been done.
