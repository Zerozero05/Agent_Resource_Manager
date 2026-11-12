import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { finalStateArguments, assertFinalWorkspace, pendingFinalBounds } from '../scripts/verify-native-workspace-final-state.mjs';

const targets = [{ label: 'main', paneId: 'one', skillId: 'skill-one', section: 'files', bounds: { x: 60, y: 60, width: 1084, height: 741, maximized: false } }, { label: 'workspace-child', paneId: 'two', skillId: 'skill-two', section: 'source', bounds: { x: 260, y: 160, width: 984, height: 681, maximized: false } }];
function saved() { return { revision: 7, windows: targets.map(target => ({ label: target.label, activePaneId: target.paneId, bounds: { ...target.bounds }, panes: [{ id: target.paneId, kind: 'detail', skillId: target.skillId, state: { section: target.section } }] })) }; }

test('explicit phases and inputs are required before any native activity', () => {
  assert.deepEqual(finalStateArguments(['--help']), { help: true });
  assert.equal(finalStateArguments(['--phase', 'prepare']).phase, 'prepare');
  assert.equal(finalStateArguments(['--phase', 'run', '--fixture', 'one', '--candidate', 'two', '--candidate-build-info', 'three']).phase, 'run');
  for (const args of [[], ['--phase'], ['--phase', 'other'], ['--phase', 'run'], ['--phase', 'prepare', '--fixture', 'existing'], ['--phase', 'prepare', '--phase', 'run'], ['--force'], ['--help', '--unknown']]) assert.throws(() => finalStateArguments(args));
});

test('each exact window must retain its own final detail, active pane and geometry', () => {
  assert.equal(assertFinalWorkspace(saved(), targets), true);
  assert.throws(() => assertFinalWorkspace(saved(), []));
  for (const change of [state => state.windows.pop(), state => state.windows[1].label = 'main', state => state.windows[1].panes[0].id = 'one', state => state.windows[0].activePaneId = 'home', state => state.windows[0].panes[0].skillId = 'other', state => state.windows[1].panes[0].state.section = 'docs', state => delete state.windows[0].bounds, state => state.windows[1].bounds.width += 3, state => state.windows[1].bounds.maximized = true]) {
    const state = saved(); change(state); assert.throws(() => assertFinalWorkspace(state, targets));
  }
});

test('pending geometry is recorded without imposing a timing race on normal persistence', () => {
  assert.equal(pendingFinalBounds(saved(), targets), false);
  const state = saved(); delete state.windows[1].bounds; assert.equal(pendingFinalBounds(state, targets), true);
  state.windows[1].bounds = { ...targets[1].bounds, height: 850 }; assert.equal(pendingFinalBounds(state, targets), true);
});

test('the embedded native helper cannot assign protected PowerShell variables', () => {
  const source = readFileSync(new URL('../scripts/verify-native-workspace-final-state.mjs', import.meta.url), 'utf8');
  const command = source.match(/const command = `([\s\S]*?)`;/)?.[1];
  assert.ok(command, 'The actual embedded helper must be checked.');
  const check = `
$ErrorActionPreference = 'Stop'
function Assert-NoProtectedAssignments([string]$Source) {
    $parseTokens = $null
    $parseErrors = $null
    $parsed = [Management.Automation.Language.Parser]::ParseInput($Source, [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors.Message -join '; ') }
    $writes = $parsed.FindAll({
        param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -or
        $node -is [Management.Automation.Language.ForEachStatementAst] -or
        $node -is [Management.Automation.Language.ParameterAst]
    }, $true)
    foreach ($write in $writes) {
        $variables = if ($write -is [Management.Automation.Language.AssignmentStatementAst]) {
            $write.Left.FindAll({ param($node) $node -is [Management.Automation.Language.VariableExpressionAst] }, $true)
        } elseif ($write -is [Management.Automation.Language.ForEachStatementAst]) {
            @($write.Variable)
        } else {
            @($write.Name)
        }
        foreach ($variable in $variables) {
            $variableName = $variable.VariablePath.UserPath
            $existingVariable = Get-Variable -Name $variableName -ErrorAction SilentlyContinue
            $protectedOptions = [Management.Automation.ScopedItemOptions]::ReadOnly -bor [Management.Automation.ScopedItemOptions]::Constant
            if ($variableName -in @('HOME', 'CODEX_HOME') -or ($null -ne $existingVariable -and ($existingVariable.Options -band $protectedOptions))) {
                throw "Protected PowerShell variable assignment: $variableName"
            }
        }
    }
}
Assert-NoProtectedAssignments ([Console]::In.ReadToEnd())
$homeAssignmentRejected = $false
try { Assert-NoProtectedAssignments '$home = "synthetic"' }
catch {
    if ($_.Exception.Message -notlike 'Protected PowerShell variable assignment: home') { throw }
    $homeAssignmentRejected = $true
}
if (-not $homeAssignmentRejected) { throw 'The original HOME assignment must be rejected.' }
'Protected variable regression passed without running the helper.'`;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', check], {
    input: command.replaceAll('${payload}', 'e30='),
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Protected variable regression passed/);
});
