param([Parameter(Mandatory)][ValidateLength(1, 4096)][string]$Spec)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Send-Reply($reply) {
    [Console]::WriteLine(($reply | ConvertTo-Json -Depth 4 -Compress))
}

function Assert-OwnedWindow {
    $app.Refresh()
    if ($app.HasExited -or $app.SessionId -ne $observer.SessionId -or
        $app.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $creation -or
        $app.MainWindowHandle -ne $window -or
        -not $app.MainModule.FileName.Equals($executable, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The exact hosted app process or window changed.'
    }
}

function Read-WorkspaceTabs {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    if ($root.Current.ProcessId -ne $app.Id) {
        throw 'The accessibility window does not belong to the hosted app.'
    }
    $tabScopeCondition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '工作区标签'),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Tab)
    ))
    $workspaces = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabScopeCondition)
    $value = @{
        pid = $app.Id
        creationFileTime = $creation.ToString()
        windowHandle = $window.ToInt64()
        workspaceScopeCount = $workspaces.Count
        tabCount = 0
        selectedTabCount = 0
        workbenchSelected = $false
        fixtureDocumentSelected = $false
    }
    if ($workspaces.Count -eq 1) {
        $tabItems = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
        $tabs = $workspaces[0].FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabItems)
        $value.tabCount = $tabs.Count
        for ($index = 0; $index -lt $tabs.Count; $index++) {
            $tab = $tabs[$index]
            $selection = $null
            if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection) -and $selection.Current.IsSelected) {
                $value.selectedTabCount++
                $tabName = $tab.Current.Name
                if ($tabName -ceq '工作台' -or $tabName.StartsWith('工作台 ', [StringComparison]::Ordinal)) { $value.workbenchSelected = $true }
                if ($tabName -ceq 'Perf Skill 0000') { $value.fixtureDocumentSelected = $true }
            }
        }
    }
    return $value
}

$app = $null
$observer = [Diagnostics.Process]::GetCurrentProcess()
$requestId = $null
try {
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
        $env:GITHUB_REPOSITORY -ine 'Zerozero05/Agent_Resource_Manager' -or -not [Environment]::UserInteractive -or $observer.SessionId -eq 0) {
        throw 'An interactive GitHub-hosted Windows job for this repository is required.'
    }
    $owner = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec)) | ConvertFrom-Json -AsHashtable
    if ($owner -isnot [Collections.IDictionary] -or $owner.Count -ne 4 -or
        $owner.pid -isnot [long] -or $owner.pid -le 0 -or $owner.pid -gt [int]::MaxValue -or
        $owner.windowHandle -isnot [long] -or $owner.windowHandle -le 0 -or
        $owner.creationFileTime -isnot [string] -or $owner.creationFileTime -cnotmatch '^[1-9][0-9]{16,17}$' -or
        $owner.executable -isnot [string]) {
        throw 'The hosted app identity is invalid.'
    }
    $temp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).ProviderPath
    $executable = Join-Path $temp 'arm-native-performance/agent-resource-manager.exe'
    if (-not [IO.Path]::IsPathFullyQualified($owner.executable) -or
        -not [IO.Path]::GetFullPath($owner.executable).Equals([IO.Path]::GetFullPath($executable), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The identity does not name the disposable hosted executable.'
    }
    $executable = [IO.Path]::GetFullPath($executable)
    $creation = [long]$owner.creationFileTime
    $window = [IntPtr]::new($owner.windowHandle)
    $app = [Diagnostics.Process]::GetProcessById([int]$owner.pid)
    Assert-OwnedWindow
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Send-Reply @{ event = 'ready'; ok = $true; identity = @{
        pid = $app.Id; creationFileTime = $creation.ToString(); windowHandle = $window.ToInt64()
        observerPid = $observer.Id; observerCreationFileTime = $observer.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        readOnly = $true; scope = 'workspace-tab-selection'
    } }

    while ($null -ne ($line = [Console]::ReadLine())) {
        $requestId = $null
        if ($line.Length -gt 256) { throw 'The observer request is too long.' }
        $request = $line | ConvertFrom-Json -AsHashtable
        if ($request -isnot [Collections.IDictionary] -or $request.id -isnot [long] -or $request.id -le 0) {
            throw 'The observer request id is invalid.'
        }
        $requestId = $request.id
        if ($request.Count -ne 2 -or $request.op -isnot [string] -or $request.op -cnotin 'read', 'finish') {
            throw 'The operation is outside the read-only observer protocol.'
        }
        Assert-OwnedWindow
        if ($request.op -ceq 'finish') {
            Send-Reply @{ id = $requestId; ok = $true; value = @{ finished = $true } }
            return
        }
        Send-Reply @{ id = $requestId; ok = $true; value = (Read-WorkspaceTabs) }
    }
} catch {
    Send-Reply @{ id = $requestId; ok = $false; error = "Read-only UIA observer failed ($($_.Exception.GetBaseException().GetType().Name))." }
    exit 1
} finally {
    if ($null -ne $app) { $app.Dispose() }
    $observer.Dispose()
}
