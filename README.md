# Project Save

**Store your project files easily.** Choose two folders. Copy only what is new or changed. Your files stay with you.

Project Save is a small browser application for keeping a readable copy of a project on an external drive or another folder. It remembers folder pairs, previews changes, checks file contents, and preserves replaced versions as `.tar.gz` archives.

**Status:** experimental source preview. The [AI-assisted security audit](SECURITY_AUDIT.md) records five review passes and their findings; this is not an independent human security audit or a guarantee of recovery. The engine has 49 automated regression tests. Broader Chrome/Edge, drive-failure and scale checks remain open. Public folder access is disabled until an exclusive HTTPS hosting origin is configured. The MIT License carries Copyright (c) 2026 Sudheendra Rao. Keep another backup of important work.

**Opening the downloaded `index.html` directly will not run this app.** For now, use the [local-server instructions](#run-locally-for-review) below in desktop Chrome or Edge. The repository is source code, not a live hosted backup service. Selected projects, backup contents and saved folder pairs do not belong in this repository.

## Using Project Save

Open the locally served page in desktop **Chrome or Edge**. You can bookmark its local address with **Ctrl+D** on Windows/Linux or **Command+D** on macOS; the local server must be running when you return. A future public hosted version can avoid the local-server step, but only after the dedicated-origin requirement and remaining release checks are satisfied.

1. Read the experimental-use risk notice and acknowledge it for this tab before any file actions. Then click **Choose project folder** and select the folder containing your work. Approve read access.
2. Click **Choose backup folder** and select a dedicated, empty folder on your external drive. You can create a folder in the browser's picker. Approve read/write access. Pick a separate drive if you want protection against the original drive failing.
3. For saved folders whose permissions expired, click **Reconnect project access** and **Reconnect backup access** separately. Choose read-only backup access for preview/restore, or read/write for backup and normal verification. These buttons each request one permission directly from your click; other actions never request permissions after waiting for locks or another picker. Then click **Remember this pair**. The source and destination folder handles are stored in this browser on this device.
4. Click **Preview changes**. Review included files, transfer size, the prominent skipped count, and unreadable items. Preview does not write backup files. If real work is excluded, add its relative path under the advanced include control and remember the pair again. Overrides can copy secrets: inspect them carefully.
5. Click **Back up new & changed files**. Leave the page open until it reports completion.
6. Click **Verify backup** for a full content check, including files skipped by the quick comparison. Select **Include history archives** to check archived checksums and members too; this takes longer.

On later visits, select your pair from **Saved folder pairs**. The browser may ask you to approve access again. Up to 20 pairs can be remembered. No GitHub account is needed to download the public source. The current local setup needs an already available static server; the Python example below is one option. A future hosted page would remove that local-server requirement.

The browser exposes folder names, not absolute Windows/macOS paths. To distinguish same-name folders, enter optional project and backup paths or labels on their cards, then click **Remember this pair**. These user-entered labels also appear in the saved-pair list and stay in this browser’s IndexedDB; they are not verified against the selected folders, used for file access, or written to backup manifests/results. Leaving them blank keeps the ordinary folder names.

Choosing or remembering folders does not start a copy. There is no scheduler or automatic startup task. The page must remain open while it works; it cannot promise unattended backups after the browser closes.

## What gets copied

The first backup copies all included files. Later runs use source size/modification time and destination metadata to select new, modified, or missing files. They stream file contents rather than loading the whole project into memory. Copied files are checked with SHA-256, and the source is checked again before the new manifest is committed.

Failed or unreadable repair attempts retain their pending repair flags until a successful verified recopy. A partial backup cannot silently clear those flags. The fast comparison can otherwise miss a same-size change with an unchanged modification time. **Verify backup** reads every active backup file and compares hashes with the saved manifest; it separately checks whether the source has changed. Its findings cause damaged or outdated files to be recopied on the next backup.

Required assets such as images, fonts and PDFs are included, along with source code, documentation, manifests, lockfiles and Git history. Large required files and existing archives still take time during the initial copy.

The default name-based exclusions are:

- Dependency/environment folders: `node_modules`, `.venv`, `venv`.
- Common generated folders: `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.expo`, `.cache`, `temp`, `tmp`, `dist`, `build`, `coverage`, `.next`, `web-build`.
- Common credential folders: `secrets`, `.local-secrets`, `.ssh`, `.aws`, `.gnupg`, `.docker`, `.kube`. Common credential files: `.env`, `.env.*` except `.env.example`, `.envrc`, `credentials.json`, `service-account.json`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc`. Extensions: `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`, `.jks`. Public-key `.pub` files are not excluded by extension, but their parent credential directory may be.
- Python bytecode and local database files: `.pyc`, `.pyo`, `.db`, `.sqlite`, `.sqlite3`, including database sidecars.
- OS metadata: `.DS_Store`, `Thumbs.db`, and macOS custom-folder-icon files named `Icon` followed by a carriage return (`Icon\r`). That exact icon filename is skipped before portable-name validation; ordinary files named `Icon` remain eligible. Project Save's own `.project-save` metadata folder is excluded too.

Preview lists actual skipped paths and their count. These rules apply at every directory depth. They exclude some common secrets, not all secrets: tokens embedded in ordinary source files will be copied. They can also exclude genuine work such as Keynote `.key` documents, authored `.db` files, or a folder named `build`. The advanced include control accepts one relative file/folder path per line and saves it with the pair. An override bypasses the exclusion of that exact path. A folder override admits ordinary descendants, but default rules still filter nested secrets and caches unless those exact nested paths are separately listed. An override for one nested file does not include its excluded siblings. The app lists override paths in its confirmation and asks for confirmation on first backups with exclusions and on backups using overrides. Credentials and live databases need a separate protected backup plan.

## Backup layout and previous versions

The folder you select is the container for the whole backup. Your project files are placed inside `current/` with the same relative folder structure, rather than directly at the backup folder's top level. The page shows this layout before the backup controls. `history/` appears only when a previous version or file-set checkpoint needs preserving.

```text
your-dedicated-backup-folder/
  current/                 Ordinary readable file copies
  history/                 Previous versions as verified .tar.gz archives
  .project-save/           Identity, active manifest, hashes, history index,
                           operation status, verification findings, latest results
```

Before replacing files, Project Save writes and verifies an archive of the previous bytes and the previous manifest. Changes to the active file set, including additions and removals, preserve a previous manifest for recovery. History records include archive and member hashes.

Files removed from the source are retained physically on the drive; the active manifest omits them. **No source files, destination files, or history archives are automatically deleted or moved.** History therefore grows over time. Review retention deliberately, and keep the metadata and history needed by any checkpoint you want to restore.

If a source file becomes a folder of the same name, or a folder becomes a file, its retained old copy can block the normal path in `current/`. Project Save leaves that copy in place and saves each blocked new file under `.project-save/objects/<unique-id>`. The active manifest records each file's original relative name and alternate `targetPath`; Verify, subsequent copies, archive preservation and Restore all follow it. These mappings stay in the backup's local manifest; they are not added to page results or saved operation results. The website does not upload them. Anyone who can read the unencrypted backup drive can still read its manifest and file names. Ordinary change/error reports continue to show relative source paths locally, as before. Restore recreates the original names in your chosen empty folder. Keep the entire backup set together: copying `current/` alone can omit active files stored in objects. Unreferenced objects left by deleted files or interrupted writes are retained too; the app does not prune them.

Manifests using alternate storage have format `project-save-browser-v2`; older Project Save builds refuse them. This build reads both v1 and v2 manifests/checkpoints. Keep this build or a compatible newer one with backups that use alternate storage. The backup identity marker remains v1 for existing saved pairs; it is the manifest version that governs file storage.

Copies are file-based, not a simultaneous filesystem snapshot. Close active writers first. A drive disconnect, permission error, full disk or browser closure may interrupt an operation. The old manifest remains until a completed or explicitly partial copy commits a new one. An incomplete-operation record is surfaced in Preview. New backup writes require explicit recovery confirmation; first stop every other writer and restore or inspect the last checkpoint. A live lease blocks takeover. Lease assertions renew an unchanged owner inline when needed, with additional checkpoints during long streaming work; a timer is only a fallback. The expiry is five minutes. An expired lease is not evidence that another browser is stopped. Restore and retry behavior is tested, but cannot guarantee recovery from every OS, browser, or hardware failure.

Unreadable source files/directories are recorded prominently rather than silently omitted. Other readable files can commit as a **partial backup**; previous manifest entries for failed source paths are retained where available. A new unreadable file has no protected entry. The manifest and latest result carry the failures, and a restore of that partial set is labelled accordingly. Unsupported portable names (including `:`, `?`, `*`, trailing dots/spaces and Windows device names such as `CON`) are reported individually; an unsupported directory is not traversed, but its siblings continue. Rename these source items to protect them; logical names are never silently rewritten. Unsupported raw names are display-only failure records, never destination or archive paths. File/folder blockers use alternate storage as described above. Other recognized destination naming conflicts can produce partial failures; unexpected TypeError/SyntaxError exceptions, other destination-write errors, quota exhaustion and lease loss abort the operation. Do not mistake an incomplete run for protection of the whole project.

Unresolved repair flags remain until a verified recopy succeeds, or the path leaves the active source set through deletion or exclusion. A path hidden by an unreadable directory remains pending. Retiring an inactive flag does not repair, erase or re-activate any old backup bytes; stale files and history remain on the drive.

The current TAR writer supports individual archived files up to roughly 8 GiB; larger overwritten files are refused before replacement. Metadata JSON files are limited to 32 MiB, so extremely large file inventories or histories may exceed this preview's limits.

## Restore

You do not need the original project or its remembered pair to recover a backup:

1. Choose the existing Project Save **backup folder**. Do not click Remember if the browser no longer knows its original pair.
2. In the restore section choose **Current backup**, or click **Load previous checkpoints** and choose a historical point.
3. Click **Choose empty folder & restore…** and select a new, empty folder separate from the backup.
4. Wait for completion. Every restored file must match its saved SHA-256 hash.

Restore follows the manifest so stale files are not silently brought back. File names that collide under case folding or Unicode NFC, and file-versus-directory conflicts, are refused during source scanning and restore planning. Directory aliases such as `Docs/a.txt` and `docs/b.txt` are allowed when every leaf remains distinct; a case-insensitive drive can merge their directories without losing files. Logical manifest spellings are retained. Stale-file reporting treats a case/Unicode alias of a live source path as live. These rules apply even on a case-sensitive destination so the backup stays portable; they are not an exhaustive validator for every filesystem's filename rules. It refuses a nonempty output folder. Historical recovery validates archive and member hashes and streams the needed file bytes; it never calls a general-purpose TAR extraction routine. Files from the same archive are extracted together in one pass rather than decompressing it once per file. Restoring one historical archive may still require separate validation and manifest-reading passes. A missing or damaged file is recorded as failed while other verified recoverable files continue restoring. The result reports a **partial restore** with `verified: false` and lists failures; it must not be treated as full recovery. A failed destination write may leave incomplete files in the output. A corrupt whole manifest, history index, or selected historical checkpoint still causes a clear refusal because the intended file set cannot be trusted. Use another empty output folder after resolving failures.

Use Restore rather than copying `current/` over a working project: that directory can contain retained stale files and omit active files stored under `.project-save/objects/`.

## Privacy and browser permissions

The application has no upload endpoint, telemetry, analytics, external scripts, remote fonts or server-side file processing. The browser moves contents between the selected directories. A content-security policy restricts scripts/styles to this site's files and blocks application network connections.

The website host still receives ordinary page/asset requests. For GitHub Pages this includes the visitor's IP address. Folder handles and pair names are kept in IndexedDB within the browser profile. Backup metadata includes relative paths and hashes on the destination drive. Backups are not encrypted.

Browser storage clearing or using a different browser profile can remove remembered pairs. It does not erase backup files. An existing destination's identity prevents accidentally assigning it to a different saved pair; if its remembered identity is lost, restore remains available, but start a new dedicated destination for future backups.

Browser directory handles do not expose a physical drive serial number. Reconnect the drive and reselect folders if the browser reports lost access. Use one active browser/profile for a destination at a time. Web Locks serialize this app's tabs on one origin. An on-drive random lease with a heartbeat and five-minute expiry refuses observed live writers. It is renewed inline at checks/streaming checkpoints and rechecked before file/manifest commits; the 15-second timer is a fallback, not the sole renewal mechanism. Browser file APIs have no atomic compare-and-swap lock: a simultaneous acquisition race, timer throttling or another native writer remains possible. This is conflict detection, not a guarantee of cross-browser mutual exclusion. Stop all other writers before confirming recovery; the app must not be used for concurrent writers sharing a destination.

Code served by a website can access files within permissions granted to it. The repository, hosting account and updates must be reviewed and protected; CSP does not make a compromised future deployment trustworthy. The only advertised data-handling behavior should be the behavior verified in the reviewed release.

## Interrupted verification and a stuck lease

After an interrupted write, **Verify backup** can inspect the last committed manifest using read-only destination access, provided no live writer is observed. It does not take over a lease or change findings, operation state, repair flags, or saved results in this mode. Its interrupted note and results are shown in the current page. Only a later Backup action can request explicit write recovery.

If a lease looks stuck or has an implausibly distant expiry:

1. Stop Project Save in **all tabs, browsers, profiles and machines** using the destination. Stop native writers too. Never clear a lease merely because a run looks slow.
2. Check the machines' clocks; lease timestamps are wall-clock values and require reasonably synchronized clocks. Correct large skew before trying again.
3. Wait at least five minutes after stopping all writers, and inspect the dedicated backup folder. The README/app should report a malformed/far-future lease immediately rather than asking you to wait indefinitely.
4. If there is definitely no active writer, manually remove **only `.project-save/lease.json` within that dedicated backup folder**. Do not remove the manifest, archives, or operation record. This is an explicit recovery step, not something the app does automatically.
5. Reconnect access, run read-only Verify or restore the last checkpoint, then explicitly confirm recovery when starting a new Backup. If metadata is damaged beyond the lease, stop and inspect it rather than deleting other metadata at random.

Without an atomic cross-browser lock this remains a best-effort one-writer workflow. Background suspension, process termination, native writers and actual hardware faults still require real-browser testing. A checkpoint cannot prove another machine has stopped.

## Removing accidentally backed-up private content

New exclusion rules do **not** remove copies already written to the drive. Deleting a source file or forgetting a browser pair also does not purge history. Backups and archives are unencrypted.

The conservative purge procedure is deliberately manual:

1. Stop every Project Save tab/browser and any other writer using this backup. Inspect the dedicated destination carefully; do not act on the source folder or an entire drive.
2. If a live credential was copied unintentionally, rotate/revoke it as appropriate. Deletion alone cannot undo prior exposure.
3. If useful, restore the nonsensitive active file set to a separate location for inspection. Do not retain extra copies of the sensitive material.
4. Remove the **entire dedicated backup set**, including `current/`, `history/`, `.project-save/`, and any other copied/synced versions. This intentionally discards all checkpoints. The app provides no automatic destructive purge action or selective history rewriting.
5. Correct exclusions or move credentials out of the project, forget the old saved pair if needed, choose a **new empty destination**, and create and verify a clean backup.

A targeted deletion from `current/` is insufficient if archives contain the bytes. Deleting only selected archives may invalidate checkpoints. This procedure retires that history deliberately; it does not guarantee secure erasure from SSDs, filesystem journals, recycle bins, cloud version history or other backups. Use the storage owner's appropriate sanitization process if that is required.

## Run locally for review

No dependencies need installing. If Python is already available, serve **only this repository folder**:

```text
python -B -m http.server 8766 --bind 127.0.0.1
```

Open `http://127.0.0.1:8766/` in desktop Chrome or Edge. HTTPS is required on a public host; localhost is accepted for development. Opening `index.html` directly as `file://` is not the supported setup. Unsupported browsers show a message and disable file actions.

Run the local tests with an existing Node.js 22+ installation:

```text
node --test test.mjs
```

Tests use synthetic temporary folders only. They cover independent hash vectors, Unicode/long-path history, unchanged runs, credential exclusions and include overrides, changed/new/deleted files, partial backups, corruption detection and repair, lease conflicts/loss and inline renewal without timers, explicit interruption recovery, read-only interrupted verification, case/Unicode collision refusal, failed repair retention, partial restores, source-independent/historical restore, grouped decompression, malformed metadata, optional history verification, deployment/framing policy and refusal of unsafe paths/nonempty restore targets. Node adapters exercise engine behavior; they do not establish real-browser permission persistence, real disk-full behavior or OS-specific guarantees.

## GitHub Pages publication

This is a buildless static site. Its runtime files are `index.html`, `style.css`, `app.mjs`, and `backup.mjs`. No backend, paid API, package installation, or build command is needed.

**Mandatory: use an origin dedicated exclusively to Project Save.** Do not deploy to a path such as `https://personal-account.github.io/project-save/` when that same origin serves any other app. All paths on an origin share IndexedDB and origin-scoped folder permissions; another app on the origin could read saved handles and exercise granted access. A unique path or database name does not isolate them.

Choose an exclusive HTTPS custom domain/subdomain used for nothing else. This build refuses **all `.github.io` hosts**, even explicitly configured root sites, because code cannot establish whether other apps share that origin. GitHub Pages may still serve the site behind the exclusive custom domain. Confirm its ownership and prevent abandoned-domain takeovers. Configure `DEDICATED_PUBLIC_ORIGIN` in `app.mjs` to that exact HTTPS origin only after reviewing the hosting boundary. The default empty setting **disables public file actions**; only localhost review works. The app also refuses to run in a frame. These gates cannot protect against a malicious future deployment by someone controlling that origin.

Publish only this standalone source repository. Enabling hosted folder access is a separate step after the dedicated-origin and remaining release checks. If using GitHub Pages, select the repository's `main` branch and root directory, configure the dedicated custom domain when applicable, and test the resulting HTTPS origin. Never host unrelated apps anywhere on that origin. Do not publish local settings, test backups or unrelated private review records. `SECURITY_AUDIT.md` retains all five historical review passes. Later usability changes are not covered by those frozen hashes. It is not a security certificate.

The README and tests can remain in the public source repository, but user-selected files and folder handles never belong there.

## License, warranty and risk notice

Copyright (c) 2026 Sudheendra Rao. Project Save includes the standard [MIT License](LICENSE.txt). It permits reuse under its notice conditions and includes its standard AS IS warranty disclaimer and limitation-of-liability wording. Keep the license text intact with copies or substantial portions of the software. This license applies to Project Save, not the user's selected projects, file contents or other unrelated software.

No warranty is offered that a backup will be complete, recoverable, confidential, free from defects or safe against all attacks. Data loss, corruption, unauthorized disclosure, drive failure and interrupted operations remain possible. Folder permissions allow this app's delivered code to access selected folders; deployment integrity matters. Backups and history are unencrypted and name-based secret exclusions are incomplete. Keep an independent backup and do not rely on this experimental tool as the only protection for important or sensitive work.

The page requires a risk acknowledgement for each tab session before file actions. It creates no personal acceptance log and does not contact a server to record agreement. It is an informational safeguard, not a claim of universal legal immunity. The applicability and enforceability of liability exclusions depend on the governing law and circumstances; a disclaimer cannot guarantee that every possible legal responsibility is eliminated. The original AI-assisted security audit is not legal advice or a security certification.
