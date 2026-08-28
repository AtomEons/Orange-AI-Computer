#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const installer = readFileSync(resolve(import.meta.dir, '..', 'install-atomeons-root-integration.ps1'), 'utf8');
const superdirectoryInstaller = readFileSync(resolve(import.meta.dir, '..', 'install-orange5-superdirectory.ps1'), 'utf8');
const runtime = readFileSync(resolve(import.meta.dir, '..', 'start-orange5-runtime.ps1'), 'utf8');
const supervisor = readFileSync(resolve(import.meta.dir, '..', 'orange5-runtime-supervisor.mjs'), 'utf8');
const nativeControl = readFileSync(resolve(import.meta.dir, '..', 'orange5-runtime-control.mjs'), 'utf8');
const nativeLauncher = readFileSync(resolve(import.meta.dir, '..', 'runtime-services', 'OrangeFiveHiddenLauncher.cs'), 'utf8');
const hiddenGateway = readFileSync(resolve(import.meta.dir, '..', 'start-orangebrain-hidden.ps1'), 'utf8');
const retiredVulkanStart = readFileSync(resolve(import.meta.dir, '..', 'codexa-start-vulkan-navigator.ps1'), 'utf8');
const retiredVulkanEnsure = readFileSync(resolve(import.meta.dir, '..', 'ensure-codexa-vulkan-navigator.ps1'), 'utf8');

const retired = [
  'AEorangeBOX Daily Learn',
  'AEorangeBOX Monitor',
  'AtomEons-Codex-Watchdog',
  'Orange4 Stack Watch',
  'Orangebox Delta Active Council Hidden',
  'Orangebox Delta Backend Hidden',
  'Orangebox Delta ChatBackup Hidden',
  'Orangebox Delta Local Llama Hidden',
  'Orangebox Delta Reality Watcher Hidden',
  'Orangebox Delta STRONGARM Hidden',
  'Orange5 Priority Booster Hidden',
];

describe('OrangeFive single boot authority', () => {
  test('canonical installer retires every known legacy scheduled task', () => {
    for (const task of retired) expect(installer).toContain(`'${task}'`);
    expect(installer).toContain('schtasks.exe /Change /TN $taskName /Disable');
  });

  test('canonical runtime task enters through a native no-console launcher', () => {
    expect(installer).toContain('/target:winexe');
    expect(installer).toContain('New-ScheduledTaskAction -Execute $runtimeExe');
    expect(installer).toContain('orange5-runtime-supervisor.mjs');
    expect(installer).toContain('orange5-runtime-worker.exe');
    expect(installer).toContain('orange5-runtime-launcher.exe');
    expect(installer).toContain('New-ScheduledTaskSettingsSet -Hidden');
    expect(nativeLauncher).toContain('UseShellExecute = false');
    expect(nativeLauncher).toContain('CreateNoWindow = true');
    expect(nativeLauncher).toContain('WindowStyle = ProcessWindowStyle.Hidden');
    expect(supervisor).toContain('popup_surface: "none"');
    expect(supervisor).toContain('powershell_runtime: false');
    expect(supervisor).not.toContain('powershell.exe');
    expect(nativeControl).toContain('windowsHide: true');
    expect(nativeControl).not.toContain('powershell.exe');
    expect(installer).not.toContain("New-ScheduledTaskAction -Execute 'powershell.exe'");
  });

  test('repeating booster is retired and model residency is lease-owned', () => {
    expect(installer).toContain("Unregister-ScheduledTask -TaskName 'Orange5 Priority Booster Hidden'");
    expect(installer).not.toContain('-RepetitionInterval (New-TimeSpan -Minutes 5)');
    expect(runtime).toContain("ORANGE5_PRELOAD_NAVIGATOR -eq '1'");
    expect(runtime).not.toContain('keep_alive = -1');
    expect(runtime).toContain("navigator_residency_policy = 'leased_on_demand'");
    expect(nativeControl).toContain('process.env.ORANGE5_PRELOAD_NAVIGATOR = "0"');
    expect(nativeControl).toContain('process.env.ORANGE5_NAVIGATOR_TRANSPORT = "ollama"');
  });

  test('Superdirectory logon task uses the native launcher instead of direct Bun console startup', () => {
    expect(superdirectoryInstaller).toContain('/target:winexe');
    expect(superdirectoryInstaller).toContain('New-ScheduledTaskAction -Execute $Exe -Argument $ActionArguments');
    expect(superdirectoryInstaller).toContain('$ActionArguments = "`"$Bun`" `"$Entry`" `"$ProjectRoot`""');
    expect(superdirectoryInstaller).toContain('native GUI launcher plus CREATE_NO_WINDOW worker');
    expect(superdirectoryInstaller).not.toContain('--windows-hide-console');
  });

  test('retired Vulkan entry points cannot restore the old Navigator tunnel or model', () => {
    for (const source of [retiredVulkanStart, retiredVulkanEnsure]) {
      expect(source).toContain('orange-navigator:ornith-1.5-9b-q4km');
      expect(source).toContain('/api/tags');
      expect(source).toContain('lease-on-demand');
      expect(source).not.toContain('11436');
      expect(source).not.toContain('llama-server.exe');
      expect(source).not.toContain('keep_alive');
    }
    expect(retiredVulkanEnsure).toContain('Start-Process ssh.exe');
    expect(retiredVulkanEnsure).toContain('-WindowStyle Hidden');
  });

  test('gateway adoption proves the routed model and AE Phase rather than only the listening port', () => {
    expect(nativeControl).toContain('result.body?.upstream?.navigator?.preferred_route === "ae-phase"');
    expect(nativeControl).toContain('result.body?.fabric?.crossNodeTransport === "ae-phase"');
    expect(nativeControl).toContain('sameModel(result.body?.upstream?.navigator?.model, process.env.ORANGE5_NAVIGATOR_MODEL)');
    expect(runtime).toContain("$gatewayNavigator.preferred_route -eq 'ae-phase'");
    expect(runtime).toContain("$gatewayHealth.fabric.crossNodeTransport -eq 'ae-phase'");
    expect(runtime).toContain('$gatewayNavigator.model -eq $env:ORANGE5_NAVIGATOR_MODEL');
    expect(hiddenGateway).toContain("$navigator.preferred_route -eq 'ae-phase'");
    expect(hiddenGateway).toContain("$health.fabric.crossNodeTransport -eq 'ae-phase'");
    expect(hiddenGateway).toContain('$navigator.model -eq $env:ORANGE5_NAVIGATOR_MODEL');
  });
});
