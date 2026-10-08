# Phase 1E-R2 local file workflow

Tiger Web Sheets supports user-chosen native workbook files through the File System Access API in supported desktop Chrome and Edge environments. The native extension is `.tws.json`; it is a Tiger Web Sheets JSON document and is not XLSX.

## Two persistence domains

Every managed workbook retains the Phase 1E-R1 internal pair:

- SQLite is the transactional source of truth for identity, display name, revision, timestamps, optimistic concurrency, and the complete snapshot.
- `workbooks\<workbook-id>.tws.json` is the verified managed recovery mirror.

A user-selected external file is a third, browser-owned resource. The browser keeps its `FileSystemFileHandle`; Tiger never receives or fabricates an absolute path, and the backend cannot read arbitrary user locations. The UI displays only the handle name.

## Open

**開啟本機檔案** invokes `showOpenFilePicker()` directly from the click gesture and accepts only `.tws.json` as the advertised native type. Cancel leaves the current view and workbook unchanged.

Picker calls are made before unrelated asynchronous work. If the browser rejects a call with `SecurityError` or `NotAllowedError`, Tiger reports that error name and asks the user to retry directly from the page button; it does not hide an activation failure.

Tiger parses JSON and validates the format marker, version, workbook ID, revision, timestamp, SHA-256, and complete snapshot. The backend repeats schema/hash/path validation before it registers a previously unknown identity and creates its managed mirror.

- Unknown workbook ID: import the validated ID, revision, and snapshot without changing the selected file.
- Existing ID with the same revision and snapshot: bind and open normally.
- Existing ID with different content or revision: show a conflict dialog. **取消** changes nothing. **以副本開啟** creates a new internal UUID and keeps the original internal workbook intact; the selected external file is not rewritten until the user explicitly saves the copy.

## First Save and later Save

A new or internally opened workbook with no restored external handle is not presented as fully saved. Clicking **儲存** immediately invokes `showSaveFilePicker()` with the current display name plus `.tws.json`. Cancel keeps the workbook open and dirty and does not advance the internal revision.

After selection, Tiger commits SQLite and the managed mirror, retrieves the exact verified native document, writes through `FileSystemFileHandle.createWritable()`, closes it, reopens the file, and verifies it. Only then does the UI show **已儲存**.

Later Save reuses the same handle without reopening the picker. Tiger queries write permission and, from the Save gesture, requests it where supported. Denied or unavailable permission produces a clear retry/Save As path.

## Save As

**另存新檔** always invokes `showSaveFilePicker()` directly from its click. Cancel leaves the original current and creates neither a record nor an association. A successful Save As creates a new UUID, independent SQLite row, independent managed mirror, and selected external file. The filename becomes the new Tiger display name without the `.tws.json` suffix.

Saving the copy never changes the original record, managed mirror, or external file.

## Consistency and partial failures

The required order is internal commit first, then external write:

1. Commit SQLite and the managed mirror with revision protection.
2. Load the exact verified R1-native document from the backend.
3. Write and close the user-selected file.
4. Read back and validate the external document.

If the internal commit fails, the external file is not written. If internal commit succeeds but native-document synchronization or the external write fails, the internal recovery copy remains committed and the UI reports **同步失敗** or **本機檔案儲存失敗**, never **已儲存**. When the exact committed external document is available, Retry writes it without creating another revision; edits made after that partial commit force a new internal commit first.

## Handle and permission lifecycle

Handles are cached in memory and stored in a small IndexedDB object store using structured clone semantics. Handles are never serialized to localStorage. Failure to open IndexedDB does not make the internal workbook unusable.

On reload, Tiger restores the handle where possible, queries permission, and compares the external document with the internal native document. Permission is not assumed to survive reload, browser close, or browser restart. If it is not already granted, the header reports that reauthorization is required; pressing Save requests permission from that user gesture.

## Rename and Delete

Rename changes Tiger display metadata and internal revision only. It never renames the physical external file. The workbook becomes unsynchronized until Save updates the contents through the existing handle. To choose another filename or folder, use Save As.

Delete from the Tiger document manager removes only the SQLite row and managed mirror after the existing confirmation. Tiger forgets its browser handle association but does not delete the external file. External-file deletion is not part of this phase.

## Unsupported browsers and limitations

If the picker APIs are unavailable, Tiger explains that desktop Chrome or Edge is required and does not substitute a fake path field. Native picker interaction must be accepted manually because automated browser tooling may not be able to operate Windows picker dialogs.

Autosave, CSV, XLSX, and OS-path display are not implemented. The internal manager remains the recovery path when a handle or permission cannot be restored.
