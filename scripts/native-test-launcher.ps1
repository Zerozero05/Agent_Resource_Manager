param([switch]$Probe)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# This helper never impersonates a different user, changes a token's integrity,
# edits policy, or persists tokens/environment blocks. The native process handle
# returned by CreateProcessWithTokenW is the only termination target it accepts.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class NativePerformanceLauncher {
  const uint TOKEN_QUERY=8, TOKEN_DUPLICATE=2, TOKEN_ASSIGN_PRIMARY=1;
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public uint cb; public string reserved; public string desktop; public string title;
    public uint x,y,xsize,ysize,xchars,ychars,fill,flags; public ushort show,reservedBytes;
    public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint low,high; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int returned);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attributes,int impersonationLevel,int tokenType,out IntPtr primary);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,uint logonFlags,string application,StringBuilder command,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("userenv.dll",SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr environment,IntPtr token,bool inherit);
  [DllImport("userenv.dll",SetLastError=true)] static extern bool DestroyEnvironmentBlock(IntPtr environment);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FILETIME created,out FILETIME exited,out FILETIME kernel,out FILETIME user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static Exception Error(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static IntPtr TokenBuffer(IntPtr token,int kind) {
    int size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
    if(size<=0) throw Error("GetTokenInformation size");
    IntPtr data=Marshal.AllocHGlobal(size);
    if(!GetTokenInformation(token,kind,data,size,out size)) { Marshal.FreeHGlobal(data); throw Error("GetTokenInformation"); }
    return data;
  }
  static int TokenInteger(IntPtr token,int kind) { IntPtr data=TokenBuffer(token,kind); try{return Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);} }
  static string TokenSid(IntPtr token) { IntPtr data=TokenBuffer(token,1); try{return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;}finally{Marshal.FreeHGlobal(data);} }
  static int Integrity(IntPtr token) { IntPtr data=TokenBuffer(token,25); try{string sid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; return int.Parse(sid.Substring(sid.LastIndexOf('-')+1));}finally{Marshal.FreeHGlobal(data);} }
  static bool SameMediumUser(IntPtr token) { return TokenSid(token)==WindowsIdentity.GetCurrent().User.Value && Integrity(token)==8192 && TokenInteger(token,12)==Process.GetCurrentProcess().SessionId; }
  static IntPtr CurrentToken() { IntPtr token; if(!OpenProcessToken(Process.GetCurrentProcess().Handle,TOKEN_QUERY|TOKEN_DUPLICATE,out token))throw Error("Open current token");return token; }
  static IntPtr SelectToken(out string source) {
    source=null;
    foreach(Process explorer in Process.GetProcessesByName("explorer")) {
      using(explorer) {
        try { if(explorer.SessionId!=Process.GetCurrentProcess().SessionId)continue; } catch { continue; }
        IntPtr process=OpenProcess(0x1000,false,explorer.Id); if(process==IntPtr.Zero)continue;
        IntPtr token=IntPtr.Zero;
        try { if(!OpenProcessToken(process,TOKEN_QUERY|TOKEN_DUPLICATE,out token))continue; if(SameMediumUser(token)){source="same-session-explorer";IntPtr selected=token;token=IntPtr.Zero;return selected;} }
        catch { }
        finally { if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process); }
      }
    }
    IntPtr current=CurrentToken();
    try {
      if(SameMediumUser(current)){source="current-standard-user";IntPtr selected=current;current=IntPtr.Zero;return selected;}
      IntPtr data=IntPtr.Zero,linked=IntPtr.Zero;
      try { data=TokenBuffer(current,19);linked=Marshal.ReadIntPtr(data);if(SameMediumUser(linked)){source="same-user-linked-standard-token";IntPtr selected=linked;linked=IntPtr.Zero;return selected;} }
      catch { }
      finally {if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);if(linked!=IntPtr.Zero)CloseHandle(linked);}
    } finally {if(current!=IntPtr.Zero)CloseHandle(current);}
    throw new InvalidOperationException("No same-user, same-desktop-session medium-integrity explorer or linked token is available. No account, integrity or system policy was changed.");
  }
  public static string ProbeSource() { string source;IntPtr token=SelectToken(out source);try{return source;}finally{CloseHandle(token);} }
  public static bool IsElevated() {IntPtr token=CurrentToken();try{return TokenInteger(token,20)!=0;}finally{CloseHandle(token);} }
  static string Quote(string argument) {
    StringBuilder value=new StringBuilder("\"");int slashes=0;
    foreach(char c in argument){if(c=='\\'){slashes++;continue;}if(c=='\"'){value.Append('\\',slashes*2+1).Append(c);}else{value.Append('\\',slashes).Append(c);}slashes=0;}
    return value.Append('\\',slashes*2).Append('"').ToString();
  }
  static IntPtr Environment(IntPtr token,IDictionary<string,string> overrides) {
    IntPtr block;if(!CreateEnvironmentBlock(out block,token,false))throw Error("Create same-user environment");
    Dictionary<string,string> entries=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    try {int offset=0;for(;;){string item=Marshal.PtrToStringUni(IntPtr.Add(block,offset));if(String.IsNullOrEmpty(item))break;offset+=(item.Length+1)*2;int equals=item.IndexOf('=',item[0]=='='?1:0);if(equals>0)entries[item.Substring(0,equals)]=item.Substring(equals+1);}}
    finally {DestroyEnvironmentBlock(block);}
    foreach(KeyValuePair<string,string> item in overrides)entries[item.Key]=item.Value;
    List<string> keys=new List<string>(entries.Keys);keys.Sort(StringComparer.OrdinalIgnoreCase);StringBuilder text=new StringBuilder();
    foreach(string key in keys)text.Append(key).Append('=').Append(entries[key]).Append('\0');text.Append('\0');
    return Marshal.StringToHGlobalUni(text.ToString());
  }
  public sealed class OwnedProcess : IDisposable {
    IntPtr handle; public int Pid {get;private set;} public string CreatedFileTime {get;private set;} public string CreatedAtUtc {get;private set;}
    public string StartQpcTicks {get;private set;} public string QpcFrequency {get{return Stopwatch.Frequency.ToString();}} public string TokenSource {get;private set;}
    internal OwnedProcess(IntPtr handle,int pid,long start,string source) {
      this.handle=handle;Pid=pid;StartQpcTicks=start.ToString();TokenSource=source;FILETIME creation,exit,kernel,user;
      if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user))throw Error("Read owned creation identity");
      long ticks=((long)creation.high<<32)|creation.low;CreatedFileTime=ticks.ToString();CreatedAtUtc=DateTime.FromFileTimeUtc(ticks).ToString("o");
    }
    public bool Exited {get{return WaitForSingleObject(handle,0)==0;}}
    public uint ExitCode {get{uint code;if(!GetExitCodeProcess(handle,out code))throw Error("Read owned exit code");return code;}}
    public void StopOwned() {if(!Exited&&!TerminateProcess(handle,125))throw Error("Stop only this created test process");}
    public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
  }
  public static OwnedProcess Start(string application,string[] arguments,string directory,IDictionary<string,string> overrides) {
    string source;IntPtr token=SelectToken(out source),primary=IntPtr.Zero,environment=IntPtr.Zero;
    try {
      if(!DuplicateTokenEx(token,TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ASSIGN_PRIMARY,IntPtr.Zero,2,1,out primary))throw Error("Duplicate same-user standard primary token");
      if(!SameMediumUser(primary))throw new InvalidOperationException("Copied token did not retain exact same-user medium-integrity scope.");
      environment=Environment(primary,overrides);StringBuilder command=new StringBuilder(Quote(application));foreach(string argument in arguments)command.Append(' ').Append(Quote(argument));
      STARTUPINFO startup=new STARTUPINFO();startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO));startup.desktop="winsta0\\default";startup.flags=1;startup.show=1;PROCESS_INFORMATION process;
      long start=Stopwatch.GetTimestamp();
      if(!CreateProcessWithTokenW(primary,0,application,command,0x00000400|0x08000000,environment,directory,ref startup,out process))throw Error("CreateProcessWithTokenW");
      CloseHandle(process.thread);
      try{return new OwnedProcess(process.process,(int)process.pid,start,source);}catch{CloseHandle(process.process);throw;}
    }finally{if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(primary!=IntPtr.Zero)CloseHandle(primary);CloseHandle(token);}
  }
}
'@

function Write-Message($Value) { [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }
try {
    if ($Probe) {
        $elevated = [NativePerformanceLauncher]::IsElevated()
        try { $source = [NativePerformanceLauncher]::ProbeSource(); Write-Message @{ type='probe'; elevatedHost=$elevated; standardTokenAvailable=$true; tokenSource=$source; integrityLevel='medium'; sameUser=$true; sameSession=$true } }
        catch { Write-Message @{ type='probe'; elevatedHost=$elevated; standardTokenAvailable=$false; reason=$_.Exception.GetBaseException().Message } }
        exit 0
    }
    $spec = [Console]::In.ReadLine() | ConvertFrom-Json
    $validationRoot = 'D:\03_github_projects\Agent_Resource_Manager\validation\'
    function Assert-TestPath([string]$Path) {
        $full = [IO.Path]::GetFullPath($Path)
        if (-not $full.StartsWith($validationRoot,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Directory]::Exists($full)) { throw 'Test data and temporary directories must already exist under the approved validation root.' }
        return $full
    }
    $program = [IO.Path]::GetFullPath([string]$spec.executable)
    if (-not [IO.File]::Exists($program) -or [IO.Path]::GetFileName($program) -notin @('skill-manager.exe','agent-resource-manager.exe')) { throw 'The launcher accepts only the selected manager application executable.' }
    $arguments = @($spec.arguments | ForEach-Object { [string]$_ })
    if ($arguments.Count -ne 2 -or $arguments[0] -ne '--data-dir') { throw 'The test launcher accepts exactly one explicit isolated --data-dir.' }
    $arguments[1] = Assert-TestPath $arguments[1]
    $overrides = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($field in $spec.environmentOverrides.PSObject.Properties) {
        if ($field.Name -notin @('WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','TEMP','TMP')) { throw 'Unexpected child environment override.' }
        $overrides[$field.Name] = [string]$field.Value
    }
    if ($overrides.Count -ne 4 -or $overrides['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] -notmatch '^--remote-debugging-port=(\d{4,5}) --remote-debugging-address=127\.0\.0\.1$' -or [int]$Matches[1] -lt 1024 -or [int]$Matches[1] -gt 65535) { throw 'Use only one explicitly selected loopback CDP port.' }
    foreach ($name in @('WEBVIEW2_USER_DATA_FOLDER','TEMP','TMP')) { $overrides[$name] = Assert-TestPath $overrides[$name] }
    $owned = [NativePerformanceLauncher]::Start($program,[string[]]$arguments,[IO.Path]::GetDirectoryName($program),$overrides)
    try {
        Write-Message @{ type='started'; pid=$owned.Pid; createdFileTime=$owned.CreatedFileTime; createdAtUtc=$owned.CreatedAtUtc; processStartQpcTicks=$owned.StartQpcTicks; qpcFrequency=$owned.QpcFrequency; launcher='CreateProcessWithTokenW'; tokenSource=$owned.TokenSource; integrityLevel='medium'; sameUser=$true; sameSession=$true; environmentPersisted=$false }
        $command = [Console]::In.ReadLineAsync()
        while (-not $owned.Exited) {
            if ($command.IsCompleted) {
                $line = $command.GetAwaiter().GetResult()
                if ($line -eq 'stop-owned') { $owned.StopOwned() }
                elseif ($null -eq $line) { break }
                else { throw 'Unknown launcher command; no other process operation is supported.' }
                $command = [Console]::In.ReadLineAsync()
            }
            Start-Sleep -Milliseconds 50
        }
        if ($owned.Exited) { Write-Message @{type='exited';pid=$owned.Pid;createdFileTime=$owned.CreatedFileTime;exitCode=$owned.ExitCode} }
    } finally { $owned.Dispose() }
} catch { Write-Message @{ type='error'; error=$_.Exception.GetBaseException().Message }; exit 1 }
