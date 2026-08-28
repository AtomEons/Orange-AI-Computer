; Atomic Chat — NSIS installer hooks
; Extends the default Tauri uninstaller to:
;   1. Kill helper processes that hold file locks BEFORE removing files.
;   2. Clean application data directories that live outside the Tauri-managed
;      bundle ID path when the user opts in to "Delete app data".
;
; On Windows the app stores data in four locations:
;   1. %APPDATA%\chat.atomic.app\               — Tauri-internal store +
;                                                 settings.json (new installs).
;                                                 Cleaned by Tauri default.
;   2. %APPDATA%\Atomic Chat\                   — User data folder
;                                                 (models, threads, backends,
;                                                 logs, store.json,
;                                                 mcp_config.json).
;                                                 NOT cleaned by Tauri default.
;   3. %APPDATA%\Atomic-Chat\                   — Legacy settings.json
;                                                 (only on older installs;
;                                                 path uses CARGO_PKG_NAME).
;   4. %LOCALAPPDATA%\chat.atomic.app\EBWebView — WebView2 cache + localStorage.
;                                                 Cleaned by Tauri default,
;                                                 but on perUser/passive
;                                                 installs lockfiles can be
;                                                 left behind, so we redo it.
;
; A custom data_folder set by the user via "Change data folder location"
; is NOT covered by these hooks — the user is responsible for cleaning it.

!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri's CheckIfAppIsRunning macro (called later in the Section Uninstall
  ; from the bundle template) already handles the main binary. The application
  ; reaps its own helper processes on shutdown; this hook only handles an
  ; Atomic Orange WebView2 process proven by its command line.
  ; llama-server.exe, bun.exe, and uv.exe are intentionally not terminated by
  ; image name. The running application reaps its own child processes before
  ; uninstall; global taskkill commands would stop Orange services or unrelated
  ; developer workloads that this package does not own.

  ; msedgewebview2.exe is shared with other Edge-based apps on the system —
  ; we must only kill instances that belong to *our* WebView2 user data
  ; directory (%LOCALAPPDATA%\systems.atomeons.atomicorange). PowerShell filters
  ; by process command line. -EA SilentlyContinue so we never
  ; abort uninstall if PowerShell is missing or a process exits mid-query.
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name = ''msedgewebview2.exe''\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like ''*systems.atomeons.atomicorange*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0

  ; Give the kernel a moment to release file handles after TerminateProcess.
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    ; Clean the user data folder (models, backends, threads, logs, ...).
    RmDir /r "$APPDATA\Atomic Chat"
    ; Clean the legacy settings.json folder (older builds).
    RmDir /r "$APPDATA\Atomic-Chat"
    ; Tauri default already removes the current identifier path, but
    ; perUser/passive uninstalls sometimes leave EBWebView lockfiles behind.
    ; Redo it idempotently — no-op if the directory is already gone.
    RmDir /r "$LOCALAPPDATA\systems.atomeons.atomicorange"
    ; Remove the old upstream identifier only when the operator explicitly
    ; selected Delete app data.
    RmDir /r "$LOCALAPPDATA\chat.atomic.app"
    ; Drop the per-user AUMID registration used by Toast notifications in dev builds.
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\systems.atomeons.atomicorange"
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\chat.atomic.app"
  ${EndIf}
!macroend
