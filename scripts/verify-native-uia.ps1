param(
    [string]$Executable,
    [string]$DataDirectory,
    [string]$OutputFile,
    [string]$ExpectedSha256,
    [string]$TransportFileSha256,
    [string]$PinnedTransportProofBase64,
    [string]$GuardNodeExecutable,
    [ValidateSet('probe','interactive','startup','bridge')][string]$Mode='probe',
    [switch]$CompileOnly,
    [switch]$PrivateUi,
    [switch]$AccessibilityInput,
    [switch]$ConcurrentObservation,
    [switch]$BasicMode,
    [switch]$WorkbenchOnlyReadiness,
    [switch]$KeyboardInput,
    [switch]$DriverMemoryDiagnostic,
    [switch]$ReleaseDiagnosticClient
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($ConcurrentObservation -and -not $AccessibilityInput){throw 'Concurrent observation requires explicit native accessibility input.'}
if($WorkbenchOnlyReadiness -and $Mode -ne 'bridge'){throw 'Workbench-only readiness is restricted to the explicit functional bridge mode.'}
if($KeyboardInput -and $Mode -ne 'bridge'){throw 'Keyboard input is restricted to the explicit functional bridge mode.'}
if($KeyboardInput -and $PrivateUi){throw 'Keyboard input is unavailable for a private UI session.'}
if($DriverMemoryDiagnostic -and ($Mode -ne 'bridge' -or -not $AccessibilityInput -or $KeyboardInput -or $PrivateUi)){throw 'Driver memory diagnostics require an explicitly enabled non-private accessibility-only bridge session without keyboard input.'}
if($ReleaseDiagnosticClient -and (-not $DriverMemoryDiagnostic -or $ConcurrentObservation -or $BasicMode)){throw 'Client release requires the explicit synchronous normal-mode memory diagnostic.'}
$readinessMode=if($WorkbenchOnlyReadiness){'workbench-only-functional-bridge'}else{'strict-skill-list'}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$uiaReferences = @((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName) + @((Join-Path $PSHOME 'UIAutomationClient.dll'),(Join-Path $PSHOME 'UIAutomationTypes.dll'),(Join-Path $PSHOME 'WindowsBase.dll'),(Join-Path $PSHOME 'System.Drawing.Common.dll'),(Join-Path $PSHOME 'System.Private.Windows.GdiPlus.dll'),(Join-Path $PSHOME 'System.Private.Windows.Core.dll'))

Add-Type -ReferencedAssemblies $uiaReferences -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

// BEGIN ISOLATED CONCURRENT OBSERVATION
public sealed class NativeInputPendingException : TimeoutException { public NativeInputPendingException(string message):base(message){} }
public sealed class NativeConcurrentObservation {
  public long StartedAtUtcMs { get; private set; }
  public long UiReadyAtUtcMs { get; private set; }
  public double InputStartedMs { get; private set; }
  public double UiReadyMs { get; private set; }
  public double InputCallReturnedMs { get; private set; }
  public double InputReturnedAfterReadyMs { get { return Math.Max(0,InputCallReturnedMs-UiReadyMs); } }
  public static NativeConcurrentObservation Run(Action input,Func<bool> expected,Action paint,Action validate,int timeoutMs=15000) {
    if(timeoutMs<=0)throw new ArgumentOutOfRangeException(nameof(timeoutMs));
    validate();
    if(expected())throw new InvalidOperationException("The action-specific expected UI result is already ready before input; no input was sent.");
    long startedAtUtcMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),readyAtUtcMs=0;Stopwatch time=Stopwatch.StartNew();Exception inputFailure=null,observationFailure=null;int inputStarted=0,inputCompleted=0;double returnedMs=-1,readyMs=-1,inputStartedMs=-1;
    Thread worker=new Thread(()=>{inputStartedMs=time.Elapsed.TotalMilliseconds;Volatile.Write(ref inputStarted,1);try{input();}catch(Exception error){inputFailure=error;}finally{returnedMs=time.Elapsed.TotalMilliseconds;Volatile.Write(ref inputCompleted,1);}});
    worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();
    try{
      while(time.ElapsedMilliseconds<timeoutMs){
        validate();
        if(Volatile.Read(ref inputCompleted)==1&&inputFailure!=null)throw new InvalidOperationException("The native accessibility input failed.",inputFailure);
        if(Volatile.Read(ref inputStarted)==0){Thread.Sleep(1);continue;}
        bool ready=expected();if(time.ElapsedMilliseconds>=timeoutMs)throw new TimeoutException("Native UI observation exceeded its absolute deadline.");
        if(ready){paint();validate();bool confirmed=expected();if(time.ElapsedMilliseconds>=timeoutMs)throw new TimeoutException("Native UI presentation exceeded its absolute deadline.");if(confirmed){readyMs=time.Elapsed.TotalMilliseconds;readyAtUtcMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();break;}}
        Thread.Sleep(1);
      }
      if(readyMs<0)throw new TimeoutException("The expected native UI result was not presented before the observation deadline.");
    }catch(Exception error){observationFailure=error;}
    // A painted result never permits the next operation while its input is pending.
    if(!worker.Join((int)Math.Max(0,timeoutMs-time.ElapsedMilliseconds)))throw new NativeInputPendingException("The native accessibility input did not return before the deadline; no next operation is allowed.");
    if(inputFailure!=null)throw new InvalidOperationException("The native accessibility input failed.",inputFailure);
    if(observationFailure!=null)throw observationFailure;
    validate();bool retained=expected();if(time.ElapsedMilliseconds>=timeoutMs)throw new TimeoutException("Final native UI confirmation exceeded its absolute deadline.");if(!retained)throw new InvalidOperationException("The expected native UI result changed before its input returned.");
    return new NativeConcurrentObservation{StartedAtUtcMs=startedAtUtcMs,UiReadyAtUtcMs=readyAtUtcMs,InputStartedMs=inputStartedMs,UiReadyMs=readyMs,InputCallReturnedMs=returnedMs};
  }
}
// END ISOLATED CONCURRENT OBSERVATION

public sealed class NativeUiMeasurement : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct POINT {public int x,y;public POINT(int x,int y){this.x=x;this.y=y;}}
  [StructLayout(LayoutKind.Sequential)] struct MSG {
    public IntPtr window;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public POINT point;
    public uint privateData;
  }
  [StructLayout(LayoutKind.Sequential)] struct RECT {public int l,t,r,b;}
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
    public uint size,flags;
    public IntPtr active,focus,capture,menuOwner,moveSize,caret;
    public RECT caretRect;
  }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE {public int dx,dy;public uint data,flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Sequential)] struct KEY {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {[FieldOffset(0)]public MOUSE mouse;[FieldOffset(0)]public KEY key;}
  [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public INPUTUNION union;}
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  delegate bool WindowVisitor(IntPtr handle,IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor,IntPtr state);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUT {public uint size,time;}
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUT input);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetGUIThreadInfo(uint thread,ref GUITHREADINFO info);
  [DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr window);
  [DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr window,IntPtr context);
  [DllImport("imm32.dll")] static extern bool ImmGetOpenStatus(IntPtr context);
  [DllImport("imm32.dll")] static extern bool ImmGetConversionStatus(IntPtr context,out uint conversion,out uint sentence);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll",SetLastError=true)] static extern bool AttachThreadInput(uint from,uint to,bool attach);
  [DllImport("user32.dll",EntryPoint="PeekMessageW",CharSet=CharSet.Unicode)] static extern bool PeekMessage(out MSG message,IntPtr window,uint first,uint last,uint remove);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr hdc,uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,System.Text.StringBuilder name,int count);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct PROCESSENTRY {public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string file;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot,ref PROCESSENTRY entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot,ref PROCESSENTRY entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr information,uint length,out uint required);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
  readonly Process process; readonly long created; readonly IntPtr window;
  readonly string dataDirectory, quitName;
  readonly bool keyboardInput, driverMemoryDiagnostic;
  AutomationElement root {get {Identity(false);return AutomationElement.FromHandle(window);}}
  long queryTicks,paintTicks; readonly Stopwatch launch; Dictionary<string,double[]> queryBreakdown;readonly object queryStatsLock=new object();
  uint inputTick;
  public bool FocusDiagnosticOnly { get; private set; }
  public object LastOwnedFocusDiagnostic { get; private set; }
  public int Pid {get{return process.Id;}} public long Handle {get{return window.ToInt64();}} public string CreationFileTime {get{return created.ToString();}}
  public double StartupMs {get;private set;} public string Driver {get{return "Windows UIAutomation + SendInput + double DwmFlush";}}
  public string IntegrityLevel {get{Identity(false);IntPtr token;if(!OpenProcessToken(process.Handle,8,out token))throw new InvalidOperationException("Native integrity level unavailable.");try{uint bytes;GetTokenInformation(token,25,IntPtr.Zero,0,out bytes);IntPtr buffer=Marshal.AllocHGlobal((int)bytes);try{if(!GetTokenInformation(token,25,buffer,bytes,out bytes))throw new InvalidOperationException("Native integrity level unavailable.");IntPtr sid=Marshal.ReadIntPtr(buffer);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));int level=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));return level>=16384?"system":level>=12288?"high":level>=8192?"medium":level>=4096?"low":"untrusted";}finally{Marshal.FreeHGlobal(buffer);}}finally{CloseHandle(token);}}}
  public NativeUiMeasurement(string executable,string data,string temporary,bool accessibilityInput,bool basicMode=false,bool functionalKeyboardInput=false,bool enableDriverMemoryDiagnostic=false) {
    if(enableDriverMemoryDiagnostic&&(!accessibilityInput||functionalKeyboardInput))throw new InvalidOperationException("Driver memory diagnostics require accessibility-only input without keyboard input.");
    AccessibilityInput=accessibilityInput;
    keyboardInput=functionalKeyboardInput;
    driverMemoryDiagnostic=enableDriverMemoryDiagnostic;
    dataDirectory=Path.GetFullPath(data);
    quitName=Path.GetFileName(executable).Equals("skill-manager.exe",StringComparison.OrdinalIgnoreCase)&&FileVersionInfo.GetVersionInfo(executable).ProductVersion=="0.2.11"?"退出全部窗口":"完全退出管理器";
    inputTick=LastInputTick();
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    ProcessStartInfo start=new ProcessStartInfo(executable); start.UseShellExecute=false;start.CreateNoWindow=false;start.WorkingDirectory=System.IO.Path.GetDirectoryName(executable);
    start.ArgumentList.Add("--data-dir");start.ArgumentList.Add(data);if(basicMode)start.ArgumentList.Add("--basic-mode");start.Environment["TEMP"]=temporary;start.Environment["TMP"]=temporary;
    launch=Stopwatch.StartNew();process=Process.Start(start);created=process.StartTime.ToUniversalTime().ToFileTimeUtc();
    try {
      while(launch.ElapsedMilliseconds<30000){if(process.HasExited)throw new InvalidOperationException("Owned native process exited before creating its window.");process.Refresh();IntPtr candidate=process.MainWindowHandle;RECT size;if(candidate!=IntPtr.Zero&&GetWindowRect(candidate,out size)&&size.r-size.l>=600&&size.b-size.t>=400&&!String.IsNullOrEmpty(process.MainWindowTitle))break;Thread.Sleep(10);}
      window=process.MainWindowHandle;if(window==IntPtr.Zero)throw new InvalidOperationException("Owned native process has no main window.");
      uint pid;GetWindowThreadProcessId(window,out pid);if(pid!=(uint)process.Id)throw new InvalidOperationException("Native window does not belong to the created process.");
      if(!AccessibilityInput)SetForegroundWindow(window);
    }catch(Exception error){
      bool closedNormally=false;string closeError=null;
      if(!process.HasExited&&window!=IntPtr.Zero){try{closedNormally=RecoverQuit();}catch(Exception closeFailure){closeError=closeFailure.Message;}}
      error.Data["ownedProcessId"]=process.Id;error.Data["ownedProcessCreationFileTime"]=created.ToString();error.Data["ownedWindowHandle"]=window.ToInt64();
      error.Data["ownedProcessStillRunning"]=!process.HasExited;error.Data["closedNormally"]=closedNormally;
      if(closeError!=null)error.Data["closeError"]=closeError;
      process.Dispose();throw;
    }
  }
  public bool AccessibilityInput { get; set; }
  public bool ConcurrentObservation { get; set; }
  int pendingInput;public bool InputPending { get { return Volatile.Read(ref pendingInput)!=0; } }
  void RecordQuery(string key,long elapsed){lock(queryStatsLock){queryTicks+=elapsed;if(queryBreakdown!=null){double[] sample;if(!queryBreakdown.TryGetValue(key,out sample)){sample=new double[2];queryBreakdown[key]=sample;}sample[0]++;sample[1]+=elapsed*1000.0/Stopwatch.Frequency;}}}
  void Identity(bool input) {
    if(InputPending)throw new InvalidOperationException("A native accessibility input is still pending; no further UI operation is allowed.");
    if(input&&FocusDiagnosticOnly)throw new InvalidOperationException("The owned-focus diagnostic has sealed this session against further input; only read-only observations and normal quit are allowed.");
    if(process.HasExited||process.StartTime.ToUniversalTime().ToFileTimeUtc()!=created)throw new InvalidOperationException("Owned process identity changed.");
    uint pid;GetWindowThreadProcessId(window,out pid);if(pid!=(uint)process.Id)throw new InvalidOperationException("Owned window identity changed.");
    if(input&&GetAncestor(GetForegroundWindow(),2)!=window)throw new InvalidOperationException("Foreground changed; stopped before sending input to another window.");
  }
  uint LastInputTick(){LASTINPUT input=new LASTINPUT{size=(uint)Marshal.SizeOf(typeof(LASTINPUT))};if(!GetLastInputInfo(ref input))throw new InvalidOperationException("Native input activity could not be observed.");return input.time;}
  void RestoreOwnedForegroundOnce(){Identity(false);if(GetAncestor(GetForegroundWindow(),2)==window)return;if(LastInputTick()!=inputTick)throw new InvalidOperationException("New desktop input activity was detected; the owned test window was not restored and no input was sent.");object state;if(root.TryGetCurrentPattern(WindowPattern.Pattern,out state)){WindowPattern nativeWindow=(WindowPattern)state;if(nativeWindow.Current.WindowVisualState==WindowVisualState.Minimized)nativeWindow.SetWindowVisualState(WindowVisualState.Normal);}root.SetFocus();SetForegroundWindow(window);Wait(()=>{if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed during owned-window restoration; no input was sent.");return GetAncestor(GetForegroundWindow(),2)==window;},"The owned test window did not become the foreground window after one normal UIAutomation focus/restoration attempt; no input was sent.");}
  AutomationElement Find(AutomationElement scope,string name,ControlType type,bool visible=true) {
    long before=Stopwatch.GetTimestamp();
    try{
      List<Condition> conditions=new List<Condition>();if(name!=null)conditions.Add(new PropertyCondition(AutomationElement.NameProperty,name));if(type!=null)conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty,type));if(visible)conditions.Add(new PropertyCondition(AutomationElement.IsOffscreenProperty,false));
      Condition condition=conditions.Count==1?conditions[0]:new AndCondition(conditions.ToArray());return scope.FindFirst(TreeScope.Descendants,condition);
    }catch(ElementNotAvailableException){return null;}finally{RecordQuery(name??"<unnamed>",Stopwatch.GetTimestamp()-before);}
  }
  AutomationElement Named(string name,ControlType type=null,bool visible=true){return Find(root,name,type,visible);}
  void Paint(){long before=Stopwatch.GetTimestamp();if(DwmFlush()!=0||DwmFlush()!=0)throw new InvalidOperationException("DWM did not confirm desktop composition.");paintTicks+=Stopwatch.GetTimestamp()-before;}
  public const int StrictReadinessTimeoutMs=30000;
  void Wait(Func<bool> expected,string phase="Expected native UI result did not become interactive and presented.",int timeoutMs=15000){Stopwatch wait=Stopwatch.StartNew();while(wait.ElapsedMilliseconds<timeoutMs){Identity(false);if(expected()){Paint();if(expected())return;}Thread.Sleep(1);}throw new InvalidOperationException(phase);}
  public void Ready(int expectedRows){Wait(()=>{AutomationElement edit=Named("搜索 Skill",ControlType.Edit);return edit!=null&&edit.Current.IsEnabled&&SkillCount()==expectedRows&&Named("工作区标签")!=null;},timeoutMs:StrictReadinessTimeoutMs);StartupMs=launch.Elapsed.TotalMilliseconds;}
  public void ReadyWorkbench(){
    Wait(()=>{
      AutomationElement tabs=Named("工作区标签",ControlType.Tab);if(tabs==null)return false;
      AutomationElement home=null;
      foreach(AutomationElement tab in tabs.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.TabItem))){
        string name=tab.Current.Name;if(name!="工作台"&&!name.StartsWith("工作台 ",StringComparison.Ordinal))continue;
        if(home!=null)throw new InvalidOperationException("Functional workbench readiness has more than one home tab.");home=tab;
      }
      object selection;return home!=null&&home.Current.IsEnabled&&!home.Current.IsOffscreen&&home.TryGetCurrentPattern(SelectionItemPattern.Pattern,out selection);
    },"The unique enabled functional workbench tab did not become available.");
    StartupMs=launch.Elapsed.TotalMilliseconds;
  }
  int SkillCount(){AutomationElement table=Named("可横向滚动的 Skill 列表",null,false);if(table==null)return 0;long before=Stopwatch.GetTimestamp();try{int count=0;{CacheRequest cache=new CacheRequest();cache.Add(AutomationElement.NameProperty);using(cache.Activate()){AutomationElementCollection rows=table.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button));foreach(AutomationElement row in rows)if(row.Cached.Name.StartsWith("Perf Skill ",StringComparison.Ordinal))count++;}}return count;}finally{RecordQuery("<skill-row-count>",Stopwatch.GetTimestamp()-before);}}
  AutomationElement Button(string name,AutomationElement scope=null){AutomationElement value=Find(scope??root,name,ControlType.Button);if(value==null||!value.Current.IsEnabled)throw new InvalidOperationException("Native enabled button not found: "+name);return value;}
  void Send(INPUT[] values){Identity(true);if(SendInput((uint)values.Length,values,Marshal.SizeOf(typeof(INPUT)))!=(uint)values.Length)throw new InvalidOperationException("SendInput failed; no fallback input was attempted.");inputTick=LastInputTick();}
  INPUT Key(ushort code,bool up=false){return new INPUT{type=1,union=new INPUTUNION{key=new KEY{vk=code,flags=up?2u:0u}}};}
  void Click(AutomationElement element){if(AccessibilityInput){InvokeAccessible(element);return;}ClickNative(element);}
  void ClickNative(AutomationElement element){
    Identity(true);
    Rect box=element.Current.BoundingRectangle;
    int x=(int)(box.X+box.Width/2),y=(int)(box.Y+box.Height/2);
    RECT own;GetWindowRect(window,out own);
    if(box.IsEmpty||x<own.l||x>=own.r||y<own.t||y>=own.b||GetAncestor(WindowFromPoint(new POINT(x,y)),2)!=window)
      throw new InvalidOperationException("The expected native control is not hit-testable inside the owned window.");
    AutomationElement hit;
    if(element.Current.ControlType==ControlType.ComboBox&&!PointHitsElement(element,new Point(x,y),out hit))
      throw new InvalidOperationException("The native click point does not hit the exact combo or its descendant; no input was sent.");
    int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
    Send(new[]{new INPUT{type=0,union=new INPUTUNION{mouse=new MOUSE{dx=(x-left)*65535/Math.Max(1,width-1),dy=(y-top)*65535/Math.Max(1,height-1),flags=0x0001u|0x8000u|0x4000u}}},new INPUT{type=0,union=new INPUTUNION{mouse=new MOUSE{flags=2}}},new INPUT{type=0,union=new INPUTUNION{mouse=new MOUSE{flags=4}}}});
  }
  void InvokeAccessible(AutomationElement element) {
    Identity(false);
    object pattern;
    if(element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) ((InvokePattern)pattern).Invoke();
    else if(element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)) ((SelectionItemPattern)pattern).Select();
    else if(element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern)) {
      TogglePattern toggle=(TogglePattern)pattern;
      if(toggle.Current.ToggleState==ToggleState.Indeterminate)throw new InvalidOperationException("The owned control toggle state is indeterminate.");
      toggle.Toggle();
    }
    else throw new InvalidOperationException("The owned control has no native accessible activation pattern.");
  }
  void SearchInput(string value) {
    if(!AccessibilityInput){Text(value);return;}
    Identity(false);
    AutomationElement edit=Named("搜索 Skill",ControlType.Edit);
    object pattern;
    if(edit==null||!edit.Current.IsEnabled||!edit.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)||((ValuePattern)pattern).Current.IsReadOnly)throw new InvalidOperationException("The owned search input is not editable.");
    ((ValuePattern)pattern).SetValue(value);
  }
  void Text(string value){List<INPUT> keys=new List<INPUT>{Key(17),Key(65),Key(65,true),Key(17,true)};if(value.Length==0){keys.Add(Key(8));keys.Add(Key(8,true));}foreach(char c in value){keys.Add(new INPUT{type=1,union=new INPUTUNION{key=new KEY{scan=c,flags=4}}});keys.Add(new INPUT{type=1,union=new INPUTUNION{key=new KEY{scan=c,flags=6}}});}Send(keys.ToArray());}
  bool SearchMatches(string value){AutomationElement edit=Named("搜索 Skill",ControlType.Edit);if(edit==null)return false;object pattern;if(!edit.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)||((ValuePattern)pattern).Current.Value!=value)return false;if(SkillCount()!=(value.Length==0?20:1))return false;return value.Length==0||Named("Perf Skill "+value.Substring(value.Length-4),ControlType.Button,false)!=null;}
  public object SearchObservation(){AutomationElement edit=Named("搜索 Skill",ControlType.Edit);object pattern;string value=edit!=null&&edit.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)?((ValuePattern)pattern).Current.Value:null;return new{value=value,count=SkillCount(),targetFound=value!=null&&value.Length>=4&&Named("Perf Skill "+value.Substring(value.Length-4),ControlType.Button,false)!=null};}
  void FocusSearch(){if(AccessibilityInput)return;RestoreOwnedForegroundOnce();AutomationElement edit=Named("搜索 Skill",ControlType.Edit);if(edit==null)throw new InvalidOperationException("Search input unavailable.");ClickNative(edit);Wait(()=>{AutomationElement focused=AutomationElement.FocusedElement;return edit.Current.HasKeyboardFocus&&focused!=null&&focused.Current.Name=="搜索 Skill"&&focused.Current.ControlType==ControlType.Edit;});}
  public string RequestedSearchValue { get; private set; }
  public object Search(int index){string value="perf-skill-"+index.ToString("0000");RequestedSearchValue=value;FocusSearch();return Measure("search",()=>SearchInput(value),()=>SearchMatches(value));}
  public void Clear(){Click(Button("清空搜索"));Wait(()=>SearchMatches(""));}
  public object Filter(bool github){AutomationElement scope=Named("来源筛选",null,false);if(scope==null)throw new InvalidOperationException("Source filter group unavailable.");AutomationElement button=Button(github?"GitHub":"全部",scope);return Measure("filter",()=>Click(button),()=>github?Named("当前筛选无结果",null,false)!=null&&SkillCount()==0:SkillCount()==20);}
  bool DocumentReady(string title){AutomationElement heading=Named(title,ControlType.Text),tabs=Named("Skill 详情"),tab=tabs==null?null:Find(tabs,"说明",ControlType.TabItem);object selection;return heading!=null&&tabs!=null&&tab!=null&&tab.Current.IsEnabled&&tab.TryGetCurrentPattern(SelectionItemPattern.Pattern,out selection)&&((SelectionItemPattern)selection).Current.IsSelected&&Named("仅用于隔离的本地性能验收，不调用外部程序，不连接远端。",ControlType.Text,false)!=null;}
  public object OpenDocument(int index){string title="Perf Skill "+index.ToString("0000");AutomationElement scope=Named("可横向滚动的 Skill 列表",null,false);if(scope==null)throw new InvalidOperationException("Skill table is unavailable.");AutomationElement button=Button(title,scope);return Measure("document",()=>Click(button),()=>DocumentReady(title));}
  public object Tab(bool home){AutomationElement scope=Named("工作区标签",null,false);if(scope==null)throw new InvalidOperationException("Workspace tabs unavailable.");AutomationElement target=null;foreach(AutomationElement item in scope.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.TabItem))){string name=item.Current.Name;if(home?(name=="工作台"||name.StartsWith("工作台 ",StringComparison.Ordinal)):name=="Perf Skill 0000"){if(target!=null)throw new InvalidOperationException("Workspace tab selector is ambiguous.");target=item;}}if(target==null)throw new InvalidOperationException("Requested workspace tab unavailable.");return Measure("tab",()=>Click(target),()=>home?Named("搜索 Skill",ControlType.Edit)!=null:DocumentReady("Perf Skill 0000"));}
  public void CloseDocument(string title){Click(Button("关闭 "+title));Wait(()=>Named("关闭 "+title,ControlType.Button,false)==null&&Named("搜索 Skill",ControlType.Edit)!=null);}
  object Measure(string category,Action input,Func<bool> expected){
    Identity(!AccessibilityInput);if(ConcurrentObservation&&!AccessibilityInput)throw new InvalidOperationException("Concurrent observation requires native accessibility input.");
    long q,p=paintTicks;lock(queryStatsLock){q=queryTicks;queryBreakdown=new Dictionary<string,double[]>();}
    bool foregroundBefore=GetForegroundWindow()==window;long startUtc=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();double inputDispatchMs,duration;NativeConcurrentObservation observed=null;
    try{
      if(ConcurrentObservation){observed=NativeConcurrentObservation.Run(input,expected,Paint,()=>Identity(false));startUtc=observed.StartedAtUtcMs;inputDispatchMs=observed.InputCallReturnedMs;duration=observed.UiReadyMs;}
      else {Stopwatch time=Stopwatch.StartNew();input();inputDispatchMs=time.Elapsed.TotalMilliseconds;Wait(expected);duration=time.Elapsed.TotalMilliseconds;}
      long queryElapsed;Dictionary<string,double[]> queries;lock(queryStatsLock){queryElapsed=queryTicks-q;queries=queryBreakdown;queryBreakdown=null;}
      long operationFinishedAtUtcMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();Dictionary<string,object> result=new Dictionary<string,object>{{"category",category},{"condition",AccessibilityInput?"native-accessibility-input-to-painted-result":"native-ui-input-to-painted-result"},{"observationMode",ConcurrentObservation?"concurrent-accessibility-diagnostic":"synchronous-input-then-observation"},{"durationMs",duration},{"inputDispatchMs",inputDispatchMs},{"resultWaitMs",Math.Max(0,duration-inputDispatchMs)},{"foregroundBefore",foregroundBefore},{"foregroundAfter",GetForegroundWindow()==window},{"startedAtUtcMs",startUtc},{"finishedAtUtcMs",operationFinishedAtUtcMs},{"uiaQueryMs",queryElapsed*1000.0/Stopwatch.Frequency},{"namedQueriesCountAndMs",queries},{"dwmPresentationWaitMs",(paintTicks-p)*1000.0/Stopwatch.Frequency},{"pid",Pid},{"creationFileTime",CreationFileTime},{"windowHandle",Handle}};
      if(observed!=null){result["uiReadyMs"]=observed.UiReadyMs;result["uiReadyAtUtcMs"]=observed.UiReadyAtUtcMs;result["inputStartedMs"]=observed.InputStartedMs;result["inputCallReturnedMs"]=observed.InputCallReturnedMs;result["inputReturnedAfterReadyMs"]=observed.InputReturnedAfterReadyMs;result["operationFinishedAtUtcMs"]=operationFinishedAtUtcMs;}
      return result;
    }catch(NativeInputPendingException){Interlocked.Exchange(ref pendingInput,1);throw;}finally{lock(queryStatsLock){queryBreakdown=null;}}
  }
  public object WindowIdentity(){Identity(false);process.Refresh();System.Text.StringBuilder name=new System.Text.StringBuilder(256);GetClassName(window,name,name.Capacity);AutomationElement edit=Named("搜索 Skill",ControlType.Edit,false),focused=AutomationElement.FocusedElement;object pattern;string value=edit!=null&&edit.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)?((ValuePattern)pattern).Current.Value:null;return new Dictionary<string,object>{{"capturedHandle",Handle},{"currentMainHandle",process.MainWindowHandle.ToInt64()},{"title",process.MainWindowTitle},{"className",name.ToString()},{"uiaName",root.Current.Name},{"uiaType",root.Current.ControlType.ProgrammaticName},{"uiaClassName",root.Current.ClassName},{"uiaProcessId",root.Current.ProcessId},{"uiaBounds",root.Current.BoundingRectangle.ToString()},{"foregroundHandle",GetAncestor(GetForegroundWindow(),2).ToInt64()},{"focusedName",focused==null?null:focused.Current.Name},{"searchValue",value}};}
  public object[] Names(){List<object> values=new List<object>();{CacheRequest cache=new CacheRequest();cache.Add(AutomationElement.NameProperty);cache.Add(AutomationElement.ControlTypeProperty);using(cache.Activate()){foreach(AutomationElement element in AutomationElement.FromHandle(window).FindAll(TreeScope.Descendants,Condition.TrueCondition)){string name=element.Cached.Name;if(!String.IsNullOrEmpty(name))values.Add(new Dictionary<string,object>{{"name",name},{"type",element.Cached.ControlType.ProgrammaticName}});}}}return values.ToArray();}
  public bool Quit(){Identity(false);AutomationElement help=Button("工作区快捷键");((InvokePattern)help.GetCurrentPattern(InvokePattern.Pattern)).Invoke();Wait(()=>Named(quitName,ControlType.Button)!=null);AutomationElement quit=Button(quitName);((InvokePattern)quit.GetCurrentPattern(InvokePattern.Pattern)).Invoke();return process.WaitForExit(15000);}
  public void StartCheck(){Wait(()=>{AutomationElement button=Named("检查本地与 GitHub 变化",ControlType.Button);return button!=null&&button.Current.IsEnabled;});if(!AccessibilityInput)RestoreOwnedForegroundOnce();Click(Button("检查本地与 GitHub 变化"));}
  public void ClickNamed(string name,string scope){RestoreOwnedForegroundOnce();AutomationElement within=String.IsNullOrEmpty(scope)?null:Named(scope,null,false);if(!String.IsNullOrEmpty(scope)&&within==null)throw new InvalidOperationException("Native named scope unavailable.");Click(Button(name,within));Paint();}
  public void TypeNamed(string name,string value){AutomationElement edit=Named(name,ControlType.Edit);if(edit==null)throw new InvalidOperationException("Native named edit unavailable.");edit.SetFocus();Wait(()=>edit.Current.HasKeyboardFocus);Text(value);Paint();}
  AutomationElement KeyboardTarget(string name) {
    if(!keyboardInput)throw new InvalidOperationException("Keyboard operations require an explicitly enabled functional session.");
    if(String.IsNullOrEmpty(name)||name.Length>160)throw new InvalidOperationException("Keyboard operations require one exact named input.");
    Identity(false);AutomationElement target=null;
    foreach(AutomationElement element in root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,name))) {
      ControlType type=element.Current.ControlType;if(type!=ControlType.Edit&&type!=ControlType.ComboBox)continue;
      if(target!=null)throw new InvalidOperationException("The exact native keyboard input is ambiguous: "+name);target=element;
    }
    if(target==null||!target.Current.IsEnabled||target.Current.IsPassword)throw new InvalidOperationException("The exact native keyboard input is unavailable or protected: "+name);
    return target;
  }
  string KeyboardValue(AutomationElement target) {
    object value;if(!target.TryGetCurrentPattern(ValuePattern.Pattern,out value))throw new InvalidOperationException("The exact keyboard input has no readable native value.");
    return ((ValuePattern)value).Current.Value;
  }
  void KeyboardGuard(string phase) {
    Identity(true);
    uint currentTick=LastInputTick();
    if(currentTick!=inputTick) {
      uint observedAtTick=unchecked((uint)Environment.TickCount);
      throw new InvalidOperationException(String.Format(System.Globalization.CultureInfo.InvariantCulture,
        "New desktop input activity interrupted the functional keyboard sequence; no further input was sent. phase={0}; expectedTick={1}; currentTick={2}; tickAdvanceMs={3}; expectedAgeMs={4}; currentAgeMs={5}; elapsedSinceLaunchMs={6:F1}.",
        phase,inputTick,currentTick,unchecked(currentTick-inputTick),unchecked(observedAtTick-inputTick),unchecked(observedAtTick-currentTick),launch.Elapsed.TotalMilliseconds));
    }
  }
  void KeyboardFocused(AutomationElement target,string phase) {
    KeyboardGuard(phase);
    if(target.Current.IsOffscreen||!KeyboardFocusOwned(target))throw new InvalidOperationException("The exact owned input does not have native keyboard focus.");
  }
  bool KeyboardFocusOwned(AutomationElement target) {
    AutomationElement focused=AutomationElement.FocusedElement;
    if(focused==null)return false;
    if(target.Current.HasKeyboardFocus&&Automation.Compare(target,focused))return true;
    // An ARIA combobox can expose its active option as the UIA focus owner.
    if(target.Current.ControlType!=ControlType.ComboBox||target.Current.Name!="搜索资源、动作、能力或设置"||focused.Current.ControlType!=ControlType.ListItem||!focused.Current.HasKeyboardFocus||focused.Current.IsOffscreen||!Selected(focused))return false;
    AutomationElementCollection lists=root.FindAll(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.NameProperty,"快捷入口结果"),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.List)));
    if(lists.Count!=1||lists[0].Current.IsOffscreen)return false;
    AutomationElement list=lists[0];string listId=list.Current.AutomationId;
    if(String.IsNullOrEmpty(listId)||!listId.EndsWith(":results",StringComparison.Ordinal)||!focused.Current.AutomationId.StartsWith(listId.Substring(0,listId.Length-8)+":option:",StringComparison.Ordinal))return false;
    for(AutomationElement parent=TreeWalker.ControlViewWalker.GetParent(focused);parent!=null;parent=TreeWalker.ControlViewWalker.GetParent(parent)) {
      if(Automation.Compare(parent,list))return true;
      if(Automation.Compare(parent,root))return false;
    }
    return false;
  }
  void KeyboardSettled(string phase) {
    Paint();KeyboardGuard(phase);
  }
  public object LastKeyboardForegroundPreparation { get; private set; }
  Dictionary<string,object> OwnedFocusObservation(string phase) {
    Identity(false);
    uint tick=LastInputTick();
    IntPtr foreground=GetForegroundWindow();
    return new Dictionary<string,object>{
      {"phase",phase},{"qpcTimestamp",Stopwatch.GetTimestamp()},{"elapsedSinceLaunchMs",launch.Elapsed.TotalMilliseconds},
      {"inputTick",tick},{"inputTickChanged",tick!=inputTick},{"foregroundHandle",foreground.ToInt64()},
      {"ownedForeground",GetAncestor(foreground,2)==window},{"ownedPid",Pid},{"ownedWindowHandle",Handle}
    };
  }
  public object DiagnoseOwnedFocus() {
    if(!keyboardInput||!AccessibilityInput)throw new InvalidOperationException("The owned-focus diagnostic requires an explicit accessibility and functional keyboard session.");
    Identity(false);
    if(FocusDiagnosticOnly)throw new InvalidOperationException("The owned-focus diagnostic can run only once; this session must close normally.");
    if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed before the owned-focus diagnostic; no focus was attempted.");
    AutomationElement ownedRoot=root;
    if(ownedRoot.Current.ProcessId!=process.Id||new IntPtr(ownedRoot.Current.NativeWindowHandle)!=window)throw new InvalidOperationException("Owned UIAutomation root identity changed before the focus diagnostic.");
    FocusDiagnosticOnly=true;
    var samples=new List<object>();
    var diagnostic=new Dictionary<string,object>{
      {"status","not-attempted"},{"ownedPid",Pid},{"ownedWindowHandle",Handle},{"inputBaseline",inputTick},
      {"qpcFrequency",Stopwatch.Frequency},{"focusAttempted",false},{"focusReturned",false},
      {"focusCallStartedQpc",null},{"focusCallReturnedQpc",null},{"samples",samples},
      {"driverKeyboardOrMouseInputSent",false},{"inputOrigin","unknown"},{"performanceAcceptanceClaimed",false},
      {"sessionInputSealed",true},{"observationLimitMs",3000},{"observationSampleLimit",32}
    };
    LastOwnedFocusDiagnostic=diagnostic;
    try {
      samples.Add(OwnedFocusObservation("before-focus"));
      if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed immediately before the owned-focus diagnostic; no focus was attempted.");
      diagnostic["focusAttempted"]=true;
      diagnostic["focusCallStartedQpc"]=Stopwatch.GetTimestamp();
      try {
        ownedRoot.SetFocus();
        diagnostic["focusReturned"]=true;
      } catch(Exception error) {
        string message=error.Message;
        diagnostic["focusErrorType"]=error.GetType().FullName;
        diagnostic["focusError"]=message.Length<=512?message:message.Substring(0,512);
      } finally {
        diagnostic["focusCallReturnedQpc"]=Stopwatch.GetTimestamp();
      }
      Identity(false);
      if(ownedRoot.Current.ProcessId!=process.Id||new IntPtr(ownedRoot.Current.NativeWindowHandle)!=window)throw new InvalidOperationException("Owned UIAutomation root identity changed after the focus diagnostic.");
      samples.Add(OwnedFocusObservation("focus-call-returned"));
      Stopwatch observation=Stopwatch.StartNew();
      for(int index=0;index<29&&observation.ElapsedMilliseconds<3000&&LastInputTick()==inputTick&&(bool)diagnostic["focusReturned"];index++) {
        Thread.Sleep((int)Math.Min(100,Math.Max(1,3000-observation.ElapsedMilliseconds)));
        samples.Add(OwnedFocusObservation("observe"));
      }
      diagnostic["status"]=LastInputTick()!=inputTick?"input-tick-changed-origin-unknown":(bool)diagnostic["focusReturned"]?"focus-observed-no-tick-change":"focus-call-failed";
      return diagnostic;
    } finally {
      samples.Add(OwnedFocusObservation("end"));
      diagnostic["endedAtQpc"]=Stopwatch.GetTimestamp();
      diagnostic["inputBaselineAfter"]=inputTick;
    }
  }
  public object PrepareKeyboardForeground() {
    if(!keyboardInput||!AccessibilityInput)throw new InvalidOperationException("Foreground preparation requires an explicit functional keyboard session.");
    Identity(false);
    if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed before keyboard foreground preparation; no activation was attempted.");
    bool attached=false;
    uint currentThread=GetCurrentThreadId(),foregroundPid;
    IntPtr foregroundBefore=GetForegroundWindow();
    uint foregroundThread=GetWindowThreadProcessId(foregroundBefore,out foregroundPid);
    Dictionary<string,object> diagnostic=new Dictionary<string,object>{
      {"currentThread",currentThread},{"foregroundThread",foregroundThread},{"foregroundPid",foregroundPid},
      {"ownedWindowHandle",Handle},{"foregroundBefore",foregroundBefore.ToInt64()},{"inputTickBefore",inputTick},
      {"activationMethod","guarded-native-window-activation-without-provider-focus"},
      {"uiaFocusAttempted",false},{"uiaFocusReturned",false},{"foregroundAfterUiaFocus",null},
      {"queueInitializationCalled",false},{"peekMessageHadMessage",null},
      {"attachAttempted",false},{"attachSucceeded",null},{"attachError",null},
      {"setForegroundCalled",false},{"setForegroundSucceeded",null},
      {"detachAttempted",false},{"detachSucceeded",null},{"detachError",null}
    };
    LastKeyboardForegroundPreparation=diagnostic;
    try {
      if(GetAncestor(GetForegroundWindow(),2)!=window) {
        object pattern;
        if(root.TryGetCurrentPattern(WindowPattern.Pattern,out pattern)) {
          WindowPattern ownedWindow=(WindowPattern)pattern;
          if(ownedWindow.Current.WindowVisualState==WindowVisualState.Minimized)ownedWindow.SetWindowVisualState(WindowVisualState.Normal);
        }
        Identity(false);
        if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed before owned-window activation; no activation was attempted.");
        if(GetAncestor(GetForegroundWindow(),2)!=window) {
          Identity(false);
          if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed before owned-window activation; no activation was attempted.");
          if(root.Current.ProcessId!=process.Id||new IntPtr(root.Current.NativeWindowHandle)!=window)throw new InvalidOperationException("Owned UIAutomation root identity changed before activation.");
        // Provider SetFocus behavior is not a window-activation contract. Keep
        // the original input baseline while making one native activation attempt.
        try {
          if(foregroundThread!=0&&foregroundThread!=currentThread){
            MSG message;
            diagnostic["queueInitializationCalled"]=true;
            // PM_NOREMOVE creates this caller's queue without removing a message.
            diagnostic["peekMessageHadMessage"]=PeekMessage(out message,IntPtr.Zero,0,0,0);
            diagnostic["attachAttempted"]=true;
            attached=AttachThreadInput(currentThread,foregroundThread,true);
            int attachError=attached?0:Marshal.GetLastWin32Error();
            diagnostic["attachSucceeded"]=attached;
            if(!attached)diagnostic["attachError"]=attachError;
          }
          Identity(false);
          if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed before owned-window activation; no activation was attempted.");
          diagnostic["foregroundBeforeActivation"]=GetForegroundWindow().ToInt64();
          diagnostic["setForegroundCalled"]=true;
          diagnostic["setForegroundSucceeded"]=SetForegroundWindow(window);
          diagnostic["foregroundAfterActivation"]=GetForegroundWindow().ToInt64();
          Identity(false);
          if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed after owned-window activation; no keyboard input was sent.");
          if(root.Current.ProcessId!=process.Id||new IntPtr(root.Current.NativeWindowHandle)!=window)throw new InvalidOperationException("Owned UIAutomation root identity changed after activation.");
        } finally {
          if(attached){
            diagnostic["detachAttempted"]=true;
            bool detached=AttachThreadInput(currentThread,foregroundThread,false);
            int detachError=detached?0:Marshal.GetLastWin32Error();
            diagnostic["detachSucceeded"]=detached;
            if(!detached){
              diagnostic["detachError"]=detachError;
              throw new InvalidOperationException("Keyboard foreground preparation could not detach its input queue.");
            }
          }
          diagnostic["foregroundAfterDetach"]=GetForegroundWindow().ToInt64();
        }
        }
      }
      Wait(()=>{
        Identity(false);
        if(LastInputTick()!=inputTick)throw new InvalidOperationException("Desktop input changed during keyboard foreground preparation; no keyboard input was sent.");
        return GetAncestor(GetForegroundWindow(),2)==window;
      },"The owned keyboard test window did not become foreground after one native activation attempt.");
      return new{pid=Pid,windowHandle=Handle,foregroundHandle=GetAncestor(GetForegroundWindow(),2).ToInt64(),inputTickBefore=inputTick,inputTickAfter=LastInputTick(),temporarilyAttachedInputQueue=attached,sentKeyboardOrMouseInput=false,functionalOnly=true};
    } finally {
      diagnostic["foregroundAfterPreparation"]=GetForegroundWindow().ToInt64();
      diagnostic["inputTickAfterPreparation"]=LastInputTick();
    }
  }
  public object KeyboardFieldState(string name) {
    AutomationElement target=KeyboardTarget(name);
    List<object> focusedElements=new List<object>();
    if(target.Current.ControlType==ControlType.ComboBox) {
      foreach(AutomationElement element in root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.HasKeyboardFocusProperty,true))) {
        focusedElements.Add(new{name=element.Current.Name,type=element.Current.ControlType.ProgrammaticName,automationId=element.Current.AutomationId,runtimeId=element.GetRuntimeId(),offscreen=element.Current.IsOffscreen,hasKeyboardFocus=element.Current.HasKeyboardFocus,selected=Selected(element)});
      }
    }
    return new{name=name,type=target.Current.ControlType.ProgrammaticName,value=KeyboardValue(target),enabled=target.Current.IsEnabled,offscreen=target.Current.IsOffscreen,hasKeyboardFocus=target.Current.HasKeyboardFocus,keyboardFocusOwned=KeyboardFocusOwned(target),bounds=target.Current.BoundingRectangle.ToString(),focusedElements=focusedElements,functionalOnly=true};
  }
  public object KeyboardEdit(string name,string value) {
    if(value==null||value.Length>256)throw new InvalidOperationException("Keyboard edit requires at most 256 ordinary single-line characters.");
    foreach(char character in value)if(Char.IsControl(character))throw new InvalidOperationException("Keyboard edit requires at most 256 ordinary single-line characters.");
    AutomationElement target=KeyboardTarget(name);if(target.Current.ControlType!=ControlType.Edit)throw new InvalidOperationException("Physical keyboard editing requires an ordinary edit control.");
    object pattern;if(!target.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)||((ValuePattern)pattern).Current.IsReadOnly)throw new InvalidOperationException("The exact native keyboard edit is read-only.");
    PresentControl(target);KeyboardGuard("before-edit-pointer-focus");ClickNative(target);
    Wait(()=>{AutomationElement focused=AutomationElement.FocusedElement;return target.Current.HasKeyboardFocus&&focused!=null&&Automation.Compare(target,focused);},"The exact edit did not receive actual native keyboard focus after its owned click.");
    KeyboardFocused(target,"before-edit-text");Text(value);KeyboardSettled("after-edit-text-paint");
    Wait(()=>KeyboardValue(target)==value,"The actual native edit value did not match the requested keyboard text.");
    return new{name=name,value=KeyboardValue(target),method="owned-pointer-focus-and-SendInput-Unicode",functionalOnly=true,imeCompositionVerified=false};
  }
  public object LastKeyboardIme { get; private set; }
  public object KeyboardIme(string name) {
    return KeyboardIme(name,false);
  }
  sealed class ImeModeState {
    public long FocusWindow,Layout;
    public uint Thread,Process,Conversion,Sentence;
    public bool ContextAvailable,ConversionRead,ContextReleased,Open;
    public string Error;
    public bool Known {get{return Error==null&&ContextAvailable&&ConversionRead&&ContextReleased&&unchecked((ushort)Layout)==0x0804;}}
    public bool ModeApiUnavailable {
      get {
        return FocusWindow!=0&&Thread!=0&&unchecked((ushort)Layout)==0x0804
          &&(!ContextAvailable||(!ConversionRead&&ContextReleased));
      }
    }
    public bool Native {get{return Known&&Open&&(Conversion&1)!=0;}}
    public bool Matches(ImeModeState other) {return Known&&other.Known&&FocusWindow==other.FocusWindow&&Layout==other.Layout&&Open==other.Open&&Conversion==other.Conversion&&Sentence==other.Sentence;}
    public object Diagnostic() {return new{focusWindowHandle=FocusWindow,focusThread=Thread,focusPid=Process,hkl=String.Format(System.Globalization.CultureInfo.InvariantCulture,"0x{0:X16}",unchecked((ulong)Layout)),contextAvailable=ContextAvailable,conversionRead=ConversionRead,contextReleased=ContextReleased,open=ContextAvailable?(bool?)Open:null,conversion=ConversionRead?(uint?)Conversion:null,sentence=ConversionRead?(uint?)Sentence:null,known=Known,native=Known?(bool?)Native:null,modeApiUnavailable=ModeApiUnavailable,error=Error};}
  }
  ImeModeState ReadImeMode(AutomationElement target,string phase) {
    KeyboardFocused(target,phase);
    ImeModeState state=new ImeModeState();
    GUITHREADINFO info=new GUITHREADINFO{size=(uint)Marshal.SizeOf(typeof(GUITHREADINFO))};
    if(!GetGUIThreadInfo(0,ref info)){state.Error="Foreground GUI thread information unavailable: "+Marshal.GetLastWin32Error();return state;}
    if(info.focus==IntPtr.Zero||GetAncestor(info.focus,2)!=window){state.Error="The native focus window is outside the owned test window.";return state;}
    state.FocusWindow=info.focus.ToInt64();
    uint owner;state.Thread=GetWindowThreadProcessId(info.focus,out owner);state.Process=owner;
    if(state.Thread==0){state.Error="The native focus thread is unavailable.";return state;}
    state.Layout=GetKeyboardLayout(state.Thread).ToInt64();
    IntPtr context=ImmGetContext(info.focus);state.ContextAvailable=context!=IntPtr.Zero;
    if(!state.ContextAvailable){state.Error="The focused input has no readable IMM context; TSF compatibility state may be unavailable.";return state;}
    try {
      state.Open=ImmGetOpenStatus(context);
      state.ConversionRead=ImmGetConversionStatus(context,out state.Conversion,out state.Sentence);
      if(!state.ConversionRead)state.Error="The focused input does not expose a readable IMM conversion mode.";
    } finally {
      state.ContextReleased=ImmReleaseContext(info.focus,context);
      if(!state.ContextReleased)state.Error="The queried IMM context could not be released.";
    }
    return state;
  }
  ImeModeState WaitImeMode(AutomationElement target,Func<ImeModeState,bool> expected,string phase) {
    Stopwatch wait=Stopwatch.StartNew();ImeModeState state;
    do {
      state=ReadImeMode(target,phase);
      if(expected(state))return state;
      Thread.Sleep(20);
    } while(wait.ElapsedMilliseconds<2000);
    return state;
  }
  sealed class TaskbarImeModeState {
    public string Mode,Name,Error,OwnerCreationFileTime;
    public long TaskbarWindow;
    public int OwnerPid,IndicatorPid;
    public int[] RuntimeId;
    public object FocusBefore,FocusAfter;
    public bool Known {get{return Error==null&&(Mode=="english"||Mode=="chinese");}}
    public bool SameIndicator(TaskbarImeModeState other) {
      if(!Known||!other.Known||TaskbarWindow!=other.TaskbarWindow||OwnerPid!=other.OwnerPid||OwnerCreationFileTime!=other.OwnerCreationFileTime||IndicatorPid!=other.IndicatorPid||RuntimeId==null||other.RuntimeId==null||RuntimeId.Length!=other.RuntimeId.Length)return false;
      for(int index=0;index<RuntimeId.Length;index++)if(RuntimeId[index]!=other.RuntimeId[index])return false;
      return true;
    }
    public object Diagnostic() {return new{source="taskbar-input-mode-indicator",known=Known,mode=Mode,name=Name,error=Error,taskbarWindowHandle=TaskbarWindow,ownerPid=OwnerPid,ownerCreationFileTime=OwnerCreationFileTime,indicatorPid=IndicatorPid,runtimeId=RuntimeId,brandObserved=(string)null,focusBefore=FocusBefore,focusAfter=FocusAfter};}
  }
  TaskbarImeModeState ReadTaskbarImeMode() {
    TaskbarImeModeState state=new TaskbarImeModeState();
    try {
      AutomationElementCollection bars=AutomationElement.RootElement.FindAll(TreeScope.Children,new AndCondition(new PropertyCondition(AutomationElement.ClassNameProperty,"Shell_TrayWnd"),new PropertyCondition(AutomationElement.IsOffscreenProperty,false)));
      if(bars.Count!=1){state.Error="One visible primary taskbar was not uniquely observed.";return state;}
      AutomationElement bar=bars[0];state.TaskbarWindow=bar.Current.NativeWindowHandle;state.OwnerPid=bar.Current.ProcessId;
      uint owner;
      if(state.TaskbarWindow==0||GetWindowThreadProcessId(new IntPtr(state.TaskbarWindow),out owner)==0||owner!=(uint)state.OwnerPid){state.Error="The taskbar native owner could not be confirmed.";return state;}
      using(Process shell=Process.GetProcessById(state.OwnerPid)) {
        if(!String.Equals(shell.ProcessName,"explorer",StringComparison.OrdinalIgnoreCase)){state.Error="The observed taskbar is not owned by the existing Explorer shell.";return state;}
        state.OwnerCreationFileTime=shell.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
      }
      AutomationElementCollection buttons=bar.FindAll(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button),new PropertyCondition(AutomationElement.ClassNameProperty,"SystemTray.NormalButton"),new PropertyCondition(AutomationElement.IsOffscreenProperty,false)));
      if(buttons.Count>256){state.Error="The scoped taskbar button observation exceeded its bound.";return state;}
      AutomationElement indicator=null;int count=0;
      foreach(AutomationElement button in buttons) {
        string name=button.Current.Name??String.Empty;
        string first=name.Replace("\r\n","\n").Split('\n')[0];
        if(first.StartsWith("任务栏输入指示 ",StringComparison.Ordinal)){indicator=button;count++;}
      }
      if(count!=1){state.Error="One visible taskbar input-mode indicator was not uniquely observed.";return state;}
      state.Name=indicator.Current.Name;state.IndicatorPid=indicator.Current.ProcessId;state.RuntimeId=indicator.GetRuntimeId();
      if(String.IsNullOrEmpty(state.Name)||state.Name.Length>2048||state.IndicatorPid!=state.OwnerPid||state.RuntimeId==null||state.RuntimeId.Length==0){state.Error="The taskbar input indicator identity is unavailable.";return state;}
      string label=state.Name.Replace("\r\n","\n").Split('\n')[0];
      if(label=="任务栏输入指示 英语模式")state.Mode="english";
      else if(label=="任务栏输入指示 中文模式")state.Mode="chinese";
      else state.Error="The taskbar label is not an exact recognized current-mode status.";
    } catch(Exception error) {state.Error="Taskbar input-mode observation unavailable: "+error.GetType().Name;}
    return state;
  }
  void ToggleImeMode(AutomationElement target,string phase,string modeToggleKey,Action sent=null) {
    if(modeToggleKey!="shift"&&modeToggleKey!="ctrl")throw new InvalidOperationException("IME mode toggle supports only the explicit shift or ctrl key.");
    KeyboardFocused(target,phase);
    if(modeToggleKey=="ctrl")Send(new[]{Key(0x11),Key(0x11,true)});
    else Send(new[]{Key(0x10),Key(0x10,true)});
    if(sent!=null)sent();
    KeyboardSettled(phase+"-paint");
  }
  public object KeyboardIme(string name,bool prepareChineseIme) {
    return KeyboardIme(name,prepareChineseIme,false);
  }
  public object KeyboardIme(string name,bool prepareChineseIme,bool observeChineseIme) {
    return KeyboardIme(name,prepareChineseIme,observeChineseIme,"shift");
  }
  public object KeyboardIme(string name,bool prepareChineseIme,bool observeChineseIme,string modeToggleKey) {
    if(modeToggleKey!="shift"&&modeToggleKey!="ctrl")throw new InvalidOperationException("IME mode toggle supports only the explicit shift or ctrl key.");
    if(prepareChineseIme&&observeChineseIme)throw new InvalidOperationException("Chinese-mode observation cannot also request a mode switch.");
    if(name!="搜索 Skill")throw new InvalidOperationException("Physical IME verification is restricted to the isolated Skill search field.");
    AutomationElement target=KeyboardTarget(name);
    if(target.Current.ControlType!=ControlType.Edit)throw new InvalidOperationException("Physical IME verification requires the ordinary search edit.");
    object pattern;
    if(!target.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)||((ValuePattern)pattern).Current.IsReadOnly)throw new InvalidOperationException("The IME search edit is read-only or has no readable value.");
    KeyboardGuard("before-ime-layout-observation");
    uint owner;uint thread=GetWindowThreadProcessId(window,out owner);
    if(thread==0||owner!=(uint)Pid)throw new InvalidOperationException("The IME layout thread is not owned by the exact native window.");
    long layout=GetKeyboardLayout(thread).ToInt64();
    string before=KeyboardValue(target);
    Dictionary<string,object> diagnostic=new Dictionary<string,object>{
      {"name",name},{"pid",Pid},{"windowHandle",Handle},{"layoutThread",thread},
      {"hkl",String.Format(System.Globalization.CultureInfo.InvariantCulture,"0x{0:X16}",unchecked((ulong)layout))},
      {"languageId",unchecked((ushort)layout)},{"beforeValue",before},{"beforeCommitValue",null},{"afterValue",null},
      {"method","guarded-fixed-SendInput-VK-ceshi-Space"},{"unicodeInputUsed",false},{"clipboardUsed",false},
      {"textKeysSent",false},{"spaceSent",false},{"imeCompositionVerified",false},{"status","observing"},
      {"textKeysAttempted",false},{"spaceAttempted",false},{"naturalModeProbe",false},
      {"taskbarModePreparation",false},{"taskbarModeRestorationVerified",null},{"taskbarRestoreShiftSent",false},{"taskbarInputStopped",false},{"modeEvidenceSource","imm"},
      {"fieldCleanupAttempted",false},{"fieldCleared",null},{"afterCleanupValue",null},
      {"layoutPreserved",false},{"focusPreserved",false},
      {"prepareChineseImeRequested",prepareChineseIme},{"modeShiftAttempted",false},{"modeShiftSent",false},
      {"modeToggleKey",modeToggleKey},{"modeToggleAttempted",false},{"modeToggleSent",false},{"modeRestorationToggleSent",false},{"taskbarRestoreToggleSent",false},
      {"observeChineseImeRequested",observeChineseIme},{"taskbarChineseModeObservation",false},{"taskbarChineseModePreserved",null},
      {"modeRestorationRequired",false},{"modeRestorationAttempted",false},{"modeRestorationVerified",prepareChineseIme?(object)false:null},
      {"modeRestorationStatus",prepareChineseIme?"pending-mode-observation":"not-requested"}
    };
    LastKeyboardIme=diagnostic;
    if(unchecked((ushort)layout)!=0x0804){diagnostic["status"]="not-verified-current-layout-not-simplified-chinese";return diagnostic;}
    if(before!="")throw new InvalidOperationException("The isolated IME search field must begin empty; no existing text was cleared.");
    PresentControl(target);KeyboardGuard("before-ime-pointer-focus");ClickNative(target);
    Wait(()=>KeyboardFocusOwned(target),"The IME search field did not receive actual native keyboard focus.");
    ImeModeState original=ReadImeMode(target,"before-ime-mode-observation");
    diagnostic["modeBefore"]=original.Diagnostic();
    bool restorationRequired=false,naturalModeProbe=false,inputAttempted=false,taskbarModePreparation=false,taskbarChineseModeObservation=false,taskbarInputBlocked=false;
    TaskbarImeModeState taskbarOriginal=null;
    void GuardImeContext(string phase) {
      ImeModeState current=ReadImeMode(target,phase);
      diagnostic["lastInputContextPhase"]=phase;
      diagnostic["lastInputContext"]=current.Diagnostic();
      if(GetKeyboardLayout(thread).ToInt64()!=layout||current.FocusWindow!=original.FocusWindow||current.Thread!=original.Thread||current.Layout!=layout||(!current.Known&&!current.ModeApiUnavailable)) {
        if(taskbarModePreparation)taskbarInputBlocked=true;
        if(taskbarChineseModeObservation)taskbarInputBlocked=true;
        throw new InvalidOperationException("The exact IME focus, layout or safe mode observation changed; no further input was sent.");
      }
    }
    TaskbarImeModeState ReadGuardedTaskbarMode(string phase) {
      try {
        GuardImeContext(phase+"-before");object beforeFocus=diagnostic["lastInputContext"];
        TaskbarImeModeState observed=ReadTaskbarImeMode();
        GuardImeContext(phase+"-after");
        observed.FocusBefore=beforeFocus;observed.FocusAfter=diagnostic["lastInputContext"];
        diagnostic["lastTaskbarMode"]=observed.Diagnostic();
        if(taskbarModePreparation&&!observed.Known)taskbarInputBlocked=true;
        if(taskbarChineseModeObservation&&!observed.Known)taskbarInputBlocked=true;
        return observed;
      } catch {
        if(taskbarModePreparation)taskbarInputBlocked=true;
        if(taskbarChineseModeObservation)taskbarInputBlocked=true;
        throw;
      }
    }
    TaskbarImeModeState WaitTaskbarMode(string expected,bool originalText,string phase) {
      Stopwatch wait=Stopwatch.StartNew();TaskbarImeModeState previous=null,current;
      do {
        current=ReadGuardedTaskbarMode(phase);
        if(taskbarInputBlocked||!current.SameIndicator(taskbarOriginal)){taskbarInputBlocked=true;throw new InvalidOperationException("The taskbar input-mode status or identity changed; no further mode key was sent.");}
        bool matches=current.SameIndicator(taskbarOriginal)&&current.Mode==expected&&(!originalText||current.Name==taskbarOriginal.Name);
        if(matches&&previous!=null&&current.SameIndicator(previous)&&current.Name==previous.Name){Paint();return ReadGuardedTaskbarMode(phase+"-retained");}
        previous=matches?current:null;Thread.Sleep(20);
      } while(wait.ElapsedMilliseconds<2000);
      return current;
    }
    void RequireTaskbarChinese(string phase) {
      TaskbarImeModeState current=ReadGuardedTaskbarMode(phase);
      if(!current.SameIndicator(taskbarOriginal)||current.Mode!="chinese"||(taskbarChineseModeObservation&&current.Name!=taskbarOriginal.Name)){taskbarInputBlocked=true;throw new InvalidOperationException("The focused input no longer has the same explicitly observed Chinese taskbar mode; no further text was sent.");}
    }
    try {
      if(original.FocusWindow==0||original.Thread==0||original.Layout!=layout)throw new InvalidOperationException("The actual IME focus or layout could not be confirmed before input.");
      if(observeChineseIme) {
        if(original.Known&&!original.Native){diagnostic["status"]="not-verified-existing-ime-not-native";return diagnostic;}
        if(!original.Known&&!original.ModeApiUnavailable){diagnostic["status"]="not-verified-current-ime-mode-unavailable";return diagnostic;}
        TaskbarImeModeState initialTaskbar=ReadGuardedTaskbarMode("observe-existing-taskbar-chinese-mode");
        diagnostic["taskbarModeInitialObservation"]=initialTaskbar.Diagnostic();
        Paint();Thread.Sleep(100);
        taskbarOriginal=ReadGuardedTaskbarMode("confirm-existing-taskbar-chinese-mode");
        diagnostic["taskbarModeBefore"]=taskbarOriginal.Diagnostic();
        if(!taskbarOriginal.SameIndicator(initialTaskbar)||taskbarOriginal.Name!=initialTaskbar.Name||taskbarOriginal.Mode!="chinese") {
          diagnostic["status"]="not-verified-existing-taskbar-not-chinese";return diagnostic;
        }
        taskbarChineseModeObservation=true;diagnostic["taskbarChineseModeObservation"]=true;
        diagnostic["modeEvidenceSource"]="taskbar-chinese-observation-only";
        diagnostic["modeRestorationStatus"]="pending-taskbar-chinese-preservation-observation";
      }
      if(prepareChineseIme) {
        if(!original.Known) {
          if(!original.ModeApiUnavailable){diagnostic["status"]="not-verified-current-ime-mode-unavailable";return diagnostic;}
          TaskbarImeModeState initialTaskbar=ReadGuardedTaskbarMode("observe-taskbar-original-mode");
          diagnostic["taskbarModeInitialObservation"]=initialTaskbar.Diagnostic();
          Paint();Thread.Sleep(100);
          taskbarOriginal=ReadGuardedTaskbarMode("confirm-taskbar-original-mode");
          diagnostic["taskbarModeBefore"]=taskbarOriginal.Diagnostic();
          if(taskbarOriginal.SameIndicator(initialTaskbar)&&taskbarOriginal.Name==initialTaskbar.Name&&taskbarOriginal.Mode=="english") {
            taskbarModePreparation=true;diagnostic["taskbarModePreparation"]=true;
            diagnostic["modeEvidenceSource"]="taskbar-input-mode-indicator";
            diagnostic["modeRestorationVerified"]=null;diagnostic["taskbarModeRestorationVerified"]=false;
            diagnostic["modeRestorationStatus"]="pending-taskbar-mode-only";
            diagnostic["modeToggleAttempted"]=true;diagnostic["modeShiftAttempted"]=modeToggleKey=="shift";diagnostic["modeRestorationRequired"]=true;
            ToggleImeMode(target,"before-taskbar-ime-mode-toggle",modeToggleKey,()=>{diagnostic["modeToggleSent"]=true;diagnostic["modeShiftSent"]=modeToggleKey=="shift";});
            TaskbarImeModeState prepared=WaitTaskbarMode("chinese",false,"await-taskbar-chinese-mode");
            diagnostic["taskbarModeAfterPreparation"]=prepared.Diagnostic();
            if(!prepared.SameIndicator(taskbarOriginal)||prepared.Mode!="chinese"){
              if(!prepared.SameIndicator(taskbarOriginal))taskbarInputBlocked=true;
              diagnostic["status"]="not-verified-taskbar-mode-not-prepared";return diagnostic;
            }
          } else {
            naturalModeProbe=true;diagnostic["naturalModeProbe"]=true;
            diagnostic["modeEvidenceSource"]="unavailable-natural-probe";
            diagnostic["modeRestorationVerified"]=null;
            diagnostic["modeRestorationStatus"]="not-required-no-mode-switch-api-unavailable";
          }
        } else {
          diagnostic["modeRestorationStatus"]="not-needed";
          if(!original.Native) {
            diagnostic["modeToggleAttempted"]=true;diagnostic["modeShiftAttempted"]=modeToggleKey=="shift";
            diagnostic["modeRestorationVerified"]=false;
            // The guard and selected fixed modifier operate only in this owned input.
            restorationRequired=true;diagnostic["modeRestorationRequired"]=true;
            ToggleImeMode(target,"before-ime-mode-toggle",modeToggleKey,()=>{diagnostic["modeToggleSent"]=true;diagnostic["modeShiftSent"]=modeToggleKey=="shift";});
            ImeModeState prepared=WaitImeMode(target,state=>state.Known&&state.FocusWindow==original.FocusWindow&&state.Layout==original.Layout&&state.Native,"await-ime-native-mode");
            diagnostic["modeAfterPreparation"]=prepared.Diagnostic();
            if(!prepared.Known||prepared.FocusWindow!=original.FocusWindow||prepared.Layout!=original.Layout||!prepared.Native){diagnostic["status"]="not-verified-mode-toggle-did-not-enable-chinese";return diagnostic;}
          }
        }
      }
      KeyboardFocused(target,"before-ime-physical-letters");
      GuardImeContext("before-ime-physical-letters-context");
      if(taskbarModePreparation)RequireTaskbarChinese("before-taskbar-ime-physical-letters");
      if(taskbarChineseModeObservation)RequireTaskbarChinese("before-observed-chinese-ime-physical-letters");
      inputAttempted=true;diagnostic["textKeysAttempted"]=true;
      Send(new[]{Key(0x43),Key(0x43,true),Key(0x45),Key(0x45,true),Key(0x53),Key(0x53,true),Key(0x48),Key(0x48,true),Key(0x49),Key(0x49,true)});
      diagnostic["textKeysSent"]=true;
      KeyboardSettled("after-ime-physical-letters-paint");
      diagnostic["beforeCommitValue"]=KeyboardValue(target);
      KeyboardFocused(target,"before-ime-space-commit");
      GuardImeContext("before-ime-space-commit-context");
      if(taskbarModePreparation)RequireTaskbarChinese("before-taskbar-ime-space-commit");
      if(taskbarChineseModeObservation)RequireTaskbarChinese("before-observed-chinese-ime-space-commit");
      diagnostic["spaceAttempted"]=true;
      Send(new[]{Key(0x20),Key(0x20,true)});
      diagnostic["spaceSent"]=true;
      KeyboardSettled("after-ime-space-commit-paint");
      bool ObserveCommittedValue() {
        KeyboardFocused(target,"await-ime-committed-value");
        GuardImeContext("await-ime-committed-value-context");
        diagnostic["afterValue"]=KeyboardValue(target);
        return (string)diagnostic["afterValue"]=="测试";
      }
      if(naturalModeProbe) {
        Stopwatch conversion=Stopwatch.StartNew();
        bool committed=ObserveCommittedValue();
        while(!committed&&conversion.ElapsedMilliseconds<2000){Thread.Sleep(20);committed=ObserveCommittedValue();}
        if(!committed){diagnostic["status"]="not-verified-existing-mode-did-not-convert";return diagnostic;}
        Paint();
        if(!ObserveCommittedValue())throw new InvalidOperationException("The exact Chinese IME result did not remain committed after painting.");
      } else Wait(ObserveCommittedValue,"Physical ceshi plus Space did not commit the exact Chinese value 测试.");
      GuardImeContext("after-ime-commit-context");
      if(taskbarChineseModeObservation)RequireTaskbarChinese("after-observed-chinese-ime-commit");
      diagnostic["imeCompositionVerified"]=true;diagnostic["status"]="physical-ime-conversion-verified";
      return diagnostic;
    } catch(Exception error) {
      if(taskbarModePreparation)taskbarInputBlocked=true;
      if(taskbarChineseModeObservation)taskbarInputBlocked=true;
      diagnostic["status"]="failed-or-blocked";
      diagnostic["inputError"]=error.Message;
      throw;
    } finally {
      if(inputAttempted) {
        try {
          if(taskbarInputBlocked)throw new InvalidOperationException("Taskbar mode observation was interrupted; field cleanup was not sent.");
          GuardImeContext("before-ime-field-cleanup");
          if(taskbarChineseModeObservation)RequireTaskbarChinese("before-observed-chinese-ime-field-cleanup");
          diagnostic["fieldCleanupAttempted"]=true;
          KeyboardShortcut(name,"Escape");
          GuardImeContext("before-ime-field-clear");
          KeyboardEdit(name,String.Empty);
          GuardImeContext("after-ime-field-cleanup");
          diagnostic["afterCleanupValue"]=KeyboardValue(target);
          diagnostic["fieldCleared"]=(string)diagnostic["afterCleanupValue"]=="";
          if(!(bool)diagnostic["fieldCleared"])throw new InvalidOperationException("The isolated IME search field was not empty after guarded cleanup.");
          diagnostic["layoutPreserved"]=true;diagnostic["focusPreserved"]=true;
        } catch(Exception error) {
          if(taskbarModePreparation)taskbarInputBlocked=true;
          if(taskbarChineseModeObservation)taskbarInputBlocked=true;
          diagnostic["fieldCleanupError"]=error.Message;
          diagnostic["fieldCleared"]=false;
          diagnostic["status"]="failed-or-blocked";
        }
      }
      if(prepareChineseIme&&original.Known) {
        diagnostic["modeRestorationStatus"]="unverified";
        try {
          ImeModeState current=ReadImeMode(target,"before-ime-mode-restoration");
          diagnostic["modeBeforeRestoration"]=current.Diagnostic();
          if(!current.Matches(original)) {
            if(!restorationRequired||!current.Known||current.FocusWindow!=original.FocusWindow||current.Layout!=original.Layout||current.Native==original.Native)throw new InvalidOperationException("The original IME mode cannot be reliably restored with the selected modifier key.");
            diagnostic["modeRestorationAttempted"]=true;
            ToggleImeMode(target,"restore-ime-mode-toggle",modeToggleKey,()=>diagnostic["modeRestorationToggleSent"]=true);
            current=WaitImeMode(target,state=>state.Matches(original),"await-ime-restored-mode");
          }
          diagnostic["modeAfterRestoration"]=current.Diagnostic();
          diagnostic["modeRestorationVerified"]=current.Matches(original);
          diagnostic["modeRestorationStatus"]=current.Matches(original)?(restorationRequired?"restored-and-verified":"unchanged-and-verified"):"unverified";
          if(!current.Matches(original))diagnostic["status"]="failed-or-blocked";
        } catch(Exception error) {
          diagnostic["modeRestorationError"]=error.Message;
          diagnostic["modeRestorationVerified"]=false;
          diagnostic["status"]="failed-or-blocked";
        }
      }
      if(taskbarChineseModeObservation) {
        try {
          if(taskbarInputBlocked)throw new InvalidOperationException("The observed Chinese mode or input context became unknown; no mode-switch key was sent.");
          TaskbarImeModeState current=ReadGuardedTaskbarMode("after-observed-chinese-ime-field-cleanup");
          diagnostic["taskbarModeAfterObservation"]=current.Diagnostic();
          bool preserved=current.SameIndicator(taskbarOriginal)&&current.Mode=="chinese"&&current.Name==taskbarOriginal.Name;
          diagnostic["taskbarChineseModePreserved"]=preserved;
          if(!preserved)throw new InvalidOperationException("The original taskbar Chinese mode was not preserved; no restoration key was sent.");
          ImeModeState finalMode=ReadImeMode(target,"after-observed-chinese-ime-mode-observation");
          diagnostic["modeAfterObservation"]=finalMode.Diagnostic();
          if(GetKeyboardLayout(thread).ToInt64()!=layout||finalMode.FocusWindow!=original.FocusWindow||finalMode.Thread!=original.Thread||finalMode.Layout!=layout||(!finalMode.Known&&!finalMode.ModeApiUnavailable))throw new InvalidOperationException("The observed Chinese input focus or layout changed; no restoration key was sent.");
          if(finalMode.Known&&!finalMode.Native)throw new InvalidOperationException("The readable IME mode contradicts the observed Chinese taskbar status; no restoration key was sent.");
          if(original.Known) {
            diagnostic["modeRestorationVerified"]=finalMode.Matches(original);
            if(!finalMode.Matches(original))throw new InvalidOperationException("The original readable IME flags changed; no restoration key was sent.");
          }
          diagnostic["modeRestorationStatus"]=original.Known?"original-taskbar-chinese-and-imm-unchanged":"original-taskbar-chinese-preserved-imm-flags-unknown";
        } catch(Exception error) {
          taskbarInputBlocked=true;
          diagnostic["taskbarChineseModePreserved"]=false;
          diagnostic["modeObservationError"]=error.Message;
          diagnostic["modeRestorationStatus"]="unverified-taskbar-chinese-preservation";
          diagnostic["status"]="failed-or-blocked";
        }
      }
      if(taskbarModePreparation) {
        try {
          if(taskbarInputBlocked)throw new InvalidOperationException("Taskbar mode or input context became unknown; no further restoration key was sent.");
          TaskbarImeModeState current=ReadGuardedTaskbarMode("before-taskbar-ime-mode-restoration");
          diagnostic["taskbarModeBeforeRestoration"]=current.Diagnostic();
          if(!current.SameIndicator(taskbarOriginal))throw new InvalidOperationException("The original taskbar input-mode indicator cannot be reliably read for restoration.");
          if(current.Mode=="chinese") {
            if((string)diagnostic["status"]=="not-verified-taskbar-mode-not-prepared")throw new InvalidOperationException("Chinese mode was not confirmed during preparation; no second mode key was sent.");
            diagnostic["modeRestorationAttempted"]=true;
            ToggleImeMode(target,"restore-taskbar-ime-mode-toggle",modeToggleKey,()=>{diagnostic["modeRestorationToggleSent"]=true;diagnostic["taskbarRestoreToggleSent"]=true;diagnostic["taskbarRestoreShiftSent"]=modeToggleKey=="shift";});
            current=WaitTaskbarMode("english",true,"await-taskbar-restored-mode");
          }
          diagnostic["taskbarModeAfterRestoration"]=current.Diagnostic();
          bool restored=current.SameIndicator(taskbarOriginal)&&current.Mode=="english"&&current.Name==taskbarOriginal.Name;
          diagnostic["taskbarModeRestorationVerified"]=restored;
          diagnostic["modeRestorationStatus"]=restored?"original-taskbar-english-verified-imm-flags-unknown":"unverified-taskbar-restoration";
          if(!restored)diagnostic["status"]="failed-or-blocked";
        } catch(Exception error) {
          taskbarInputBlocked=true;
          diagnostic["modeRestorationError"]=error.Message;
          diagnostic["taskbarModeRestorationVerified"]=false;
          diagnostic["modeRestorationStatus"]="unverified-taskbar-restoration";
          diagnostic["status"]="failed-or-blocked";
        }
      }
      diagnostic["taskbarInputStopped"]=taskbarInputBlocked;
    }
  }
  public object KeyboardShortcut(string name,string gesture) {
    INPUT[] keys;
    switch(gesture) {
      case "CtrlK":keys=new[]{Key(17),Key(75),Key(75,true),Key(17,true)};break;
      case "CtrlZ":keys=new[]{Key(17),Key(90),Key(90,true),Key(17,true)};break;
      case "CtrlY":keys=new[]{Key(17),Key(89),Key(89,true),Key(17,true)};break;
      case "CtrlShiftZ":keys=new[]{Key(17),Key(16),Key(90),Key(90,true),Key(16,true),Key(17,true)};break;
      case "Escape":keys=new[]{Key(27),Key(27,true)};break;
      case "Enter":keys=new[]{Key(13),Key(13,true)};break;
      case "Space":keys=new[]{Key(32),Key(32,true)};break;
      default:throw new InvalidOperationException("Unsupported native keyboard gesture.");
    }
    AutomationElement target=KeyboardTarget(name);KeyboardFocused(target,"before-shortcut-"+gesture);Send(keys);KeyboardSettled("after-shortcut-"+gesture+"-paint");
    return new{gesture=gesture,originInput=name,method="guarded-existing-SendInput",functionalOnly=true,imeCompositionVerified=false};
  }
  bool Selected(AutomationElement element){object selection;return element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out selection)&&((SelectionItemPattern)selection).Current.IsSelected;}
  public object InspectNamed(string name,string scopeName=null){Identity(false);try{AutomationElement scope=String.IsNullOrEmpty(scopeName)?root:Named(scopeName,null,false);if(scope==null)throw new InvalidOperationException("Exact observation scope unavailable.");List<object> results=new List<object>();foreach(AutomationElement element in scope.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,name)))results.Add(new{name=element.Current.Name,type=element.Current.ControlType.ProgrammaticName,enabled=element.Current.IsEnabled,offscreen=element.Current.IsOffscreen,bounds=element.Current.BoundingRectangle.ToString(),hasKeyboardFocus=element.Current.HasKeyboardFocus,selected=Selected(element)});return results;}catch(ElementNotAvailableException){return new object[0];}}
  public object FormFields(){Identity(false);List<object> results=new List<object>();try{CacheRequest cache=new CacheRequest();cache.Add(AutomationElement.NameProperty);cache.Add(AutomationElement.ControlTypeProperty);cache.Add(AutomationElement.IsEnabledProperty);cache.Add(AutomationElement.IsOffscreenProperty);using(cache.Activate()){foreach(AutomationElement element in root.FindAll(TreeScope.Descendants,new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ComboBox),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.CheckBox),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Spinner))))results.Add(new{name=element.Cached.Name,type=element.Cached.ControlType.ProgrammaticName,enabled=element.Cached.IsEnabled,offscreen=element.Cached.IsOffscreen});}}catch(ElementNotAvailableException){return new object[0];}catch(COMException error) when(error.HResult==unchecked((int)0x80040201)){return new object[0];}return results;}
  AutomationElement Unique(string name,ControlType type,string scopeName=null){
    AutomationElement result=null;
    Wait(()=>{
      try{
        AutomationElement scope=root;
        if(!String.IsNullOrEmpty(scopeName)){
          AutomationElementCollection scopes=root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,scopeName));
          if(scopes.Count>1)throw new InvalidOperationException("Functional scope is ambiguous: "+scopeName+" (matches "+scopes.Count+").");
          if(scopes.Count==0)return false;
          scope=scopes[0];
        }
        AutomationElementCollection matches=scope.FindAll(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.NameProperty,name),new PropertyCondition(AutomationElement.ControlTypeProperty,type)));
        if(matches.Count>1)throw new InvalidOperationException("Functional selector is ambiguous: "+name+" (matches "+matches.Count+").");
        if(matches.Count==0)return false;
        result=matches[0];
        return result.Current.IsEnabled;
      }catch(ElementNotAvailableException){
        // A render can replace the node during lookup, before any action is issued.
        result=null;
        return false;
      }
    },"Exact owned functional control did not become available and enabled: "+name);
    return result;
  }
  void PresentControl(AutomationElement element){Identity(false);if(element.Current.IsOffscreen){object scroll;if(!element.TryGetCurrentPattern(ScrollItemPattern.Pattern,out scroll))throw new InvalidOperationException("Exact owned control is outside the viewport and has no semantic scroll entry.");((ScrollItemPattern)scroll).ScrollIntoView();Wait(()=>!element.Current.IsOffscreen&&element.Current.IsEnabled,"Exact owned native control did not become visible after semantic scrolling.");}}
  public void RevealNamed(string name){Identity(false);AutomationElementCollection matches=root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,name));if(matches.Count!=1)throw new InvalidOperationException("Scroll target must resolve one owned native element: "+name);PresentControl(matches[0]);Paint();Identity(false);}
  public void InvokeUnique(string name,string scope){AutomationElement element=Unique(name,ControlType.Button,scope);PresentControl(element);object pattern;if(element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))((InvokePattern)pattern).Invoke();else if(element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)){ExpandCollapsePattern expand=(ExpandCollapsePattern)pattern;if(expand.Current.ExpandCollapseState==ExpandCollapseState.Collapsed)expand.Expand();else if(expand.Current.ExpandCollapseState==ExpandCollapseState.Expanded)expand.Collapse();else throw new InvalidOperationException("Exact owned disclosure is not in a stable expandable state.");}else if(element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern)){TogglePattern toggle=(TogglePattern)pattern;if(toggle.Current.ToggleState==ToggleState.Indeterminate)throw new InvalidOperationException("Exact owned native button has an indeterminate toggle state.");toggle.Toggle();}else throw new InvalidOperationException("Exact owned native button has no supported invocation, disclosure or toggle pattern: "+name);Paint();Identity(false);}
  public string SetField(string name,string value,bool numeric=false,string scope=null){
    if(value.Length>4096)throw new InvalidOperationException("Synthetic native field value is too long.");
    double number=0;
    if(numeric&&(!double.TryParse(value,System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out number)||!double.IsFinite(number)))throw new InvalidOperationException("The exact numeric field requires a finite number.");
    AutomationElement element=Unique(name,numeric?ControlType.Spinner:ControlType.Edit,scope);PresentControl(element);object available;
    if(numeric&&element.TryGetCurrentPattern(RangeValuePattern.Pattern,out available)){
      RangeValuePattern range=(RangeValuePattern)available;
      if(range.Current.IsReadOnly)throw new InvalidOperationException("Exact numeric field is read-only.");
      if(!(number>=range.Current.Minimum&&number<=range.Current.Maximum))throw new InvalidOperationException("The exact numeric field value is outside its supported range.");
      range.SetValue(number);Wait(()=>range.Current.Value==number);
      return range.Current.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    if(element.TryGetCurrentPattern(ValuePattern.Pattern,out available)){
      ValuePattern pattern=(ValuePattern)available;
      if(pattern.Current.IsReadOnly)throw new InvalidOperationException("Exact native field is read-only.");
      pattern.SetValue(value);Wait(()=>pattern.Current.Value==value);return pattern.Current.Value;
    }
    throw new InvalidOperationException("Exact native field has no supported value pattern.");
  }
  public void SelectTab(string name){AutomationElement element=Unique(name,ControlType.TabItem,"工作区标签");PresentControl(element);SelectionItemPattern selection=(SelectionItemPattern)element.GetCurrentPattern(SelectionItemPattern.Pattern);selection.Select();Wait(()=>selection.Current.IsSelected,"Exact owned native tab did not become selected.");Paint();Identity(false);}
  bool ComboMatches(AutomationElement combo,string option){object pattern;if(combo.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)&&((ValuePattern)pattern).Current.Value==option)return true;if(combo.TryGetCurrentPattern(SelectionPattern.Pattern,out pattern)&&Array.Exists(((SelectionPattern)pattern).Current.GetSelection(),item=>item.Current.Name==option))return true;return false;}
  HashSet<int> OwnedProcessFamily(){Identity(false);IntPtr snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))throw new InvalidOperationException("Owned native popup process observation failed.");Dictionary<int,int> parents=new Dictionary<int,int>();try{PROCESSENTRY entry=new PROCESSENTRY{size=(uint)Marshal.SizeOf(typeof(PROCESSENTRY))};if(Process32First(snapshot,ref entry))do{parents[(int)entry.pid]=(int)entry.parent;}while(Process32Next(snapshot,ref entry));}finally{CloseHandle(snapshot);}HashSet<int> owned=new HashSet<int>{process.Id};bool changed;do{changed=false;foreach(KeyValuePair<int,int> row in parents)if(owned.Contains(row.Value)&&!owned.Contains(row.Key)){try{using(Process child=Process.GetProcessById(row.Key))if(child.StartTime.ToUniversalTime().ToFileTimeUtc()>=created)changed=owned.Add(row.Key)||changed;}catch(ArgumentException){}catch(InvalidOperationException){}}}while(changed);return owned;}
  List<AutomationElement> OwnedPopups(){Identity(false);HashSet<int> owned=OwnedProcessFamily();List<AutomationElement> values=new List<AutomationElement>();EnumWindows((handle,state)=>{uint pid;GetWindowThreadProcessId(handle,out pid);if(handle!=window&&IsWindowVisible(handle)&&(GetAncestor(handle,3)==window||owned.Contains((int)pid))){try{values.Add(AutomationElement.FromHandle(handle));}catch(ElementNotAvailableException){}}return true;},IntPtr.Zero);return values;}
  public object ComboState(string name){AutomationElement combo=Unique(name,ControlType.ComboBox);List<object> children=new List<object>(),popups=new List<object>();foreach(AutomationElement child in combo.FindAll(TreeScope.Descendants,Condition.TrueCondition))children.Add(new{name=child.Current.Name,type=child.Current.ControlType.ProgrammaticName,enabled=child.Current.IsEnabled,offscreen=child.Current.IsOffscreen,patterns=Array.ConvertAll(child.GetSupportedPatterns(),item=>item.ProgrammaticName)});foreach(AutomationElement popup in OwnedPopups())foreach(AutomationElement child in popup.FindAll(TreeScope.Descendants,Condition.TrueCondition))popups.Add(new{name=child.Current.Name,type=child.Current.ControlType.ProgrammaticName,enabled=child.Current.IsEnabled,offscreen=child.Current.IsOffscreen,patterns=Array.ConvertAll(child.GetSupportedPatterns(),item=>item.ProgrammaticName)});object pattern;return new{name=name,patterns=Array.ConvertAll(combo.GetSupportedPatterns(),item=>item.ProgrammaticName),value=combo.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)?((ValuePattern)pattern).Current.Value:null,readOnly=combo.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)?(bool?)((ValuePattern)pattern).Current.IsReadOnly:null,selected=combo.TryGetCurrentPattern(SelectionPattern.Pattern,out pattern)?Array.ConvertAll(((SelectionPattern)pattern).Current.GetSelection(),item=>item.Current.Name):new string[0],children=children,ownedPopupChildren=popups};}
  public object[] LastComboOptionCandidates { get; private set; }=new object[0];
  public object[] LastComboObservedOptions { get; private set; }=new object[0];
  public object LastComboChosenOption { get; private set; }
  public object[] LastComboPointerStates { get; private set; }=new object[0];
  bool PointHitsElement(AutomationElement element,Point point,out AutomationElement hit){
    hit=AutomationElement.FromPoint(point);
    AutomationElement ancestor=hit,ownedRoot=root;
    for(int depth=0;ancestor!=null&&depth<32;depth++){
      if(Automation.Compare(ancestor,element))return true;
      if(Automation.Compare(ancestor,ownedRoot))break;
      ancestor=TreeWalker.RawViewWalker.GetParent(ancestor);
    }
    return false;
  }
  object ComboPointerState(string phase,AutomationElement combo,out bool hitsCombo){
    Identity(false);
    Rect bounds=combo.Current.BoundingRectangle;
    if(bounds.IsEmpty||!double.IsFinite(bounds.X)||!double.IsFinite(bounds.Y)||!double.IsFinite(bounds.Width)||!double.IsFinite(bounds.Height)||bounds.Width<=0||bounds.Height<=0)
      throw new InvalidOperationException("The exact combo has no finite, nonempty pointer target.");
    Point center=new Point((int)(bounds.X+bounds.Width/2),(int)(bounds.Y+bounds.Height/2));
    AutomationElement hit;
    hitsCombo=PointHitsElement(combo,center,out hit);
    object pattern;
    string expansion=combo.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)
      ? ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState.ToString() : "unavailable";
    AutomationElement focused=AutomationElement.FocusedElement;
    List<object> popups=new List<object>();
    foreach(AutomationElement popup in OwnedPopups()){
      popups.Add(new{handle=popup.Current.NativeWindowHandle,pid=popup.Current.ProcessId,name=popup.Current.Name,
        type=popup.Current.ControlType.ProgrammaticName,bounds=popup.Current.BoundingRectangle.ToString(),
        listItems=popup.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem)).Count});
    }
    return new{phase=phase,name=combo.Current.Name,bounds=bounds.ToString(),expansion=expansion,
      hasKeyboardFocus=combo.Current.HasKeyboardFocus,focusedRuntimeId=focused==null?null:focused.GetRuntimeId(),
      focusedOnCombo=focused!=null&&Automation.Compare(focused,combo),centerX=center.X,centerY=center.Y,
      hitName=hit.Current.Name,hitType=hit.Current.ControlType.ProgrammaticName,hitRuntimeId=hit.GetRuntimeId(),hitsCombo=hitsCombo,popupRoots=popups};
  }
  AutomationElementCollection ComboOptionGroup(AutomationElement target,string option){
    AutomationElement group=TreeWalker.ControlViewWalker.GetParent(target);
    if(group==null||(group.Current.ControlType!=ControlType.List&&group.Current.ControlType!=ControlType.ComboBox))
      throw new InvalidOperationException("The exact combo option has no supported List or ComboBox parent group. Observed parent: "+(group==null?"missing":group.Current.ControlType.ProgrammaticName));
    AutomationElementCollection items=group.FindAll(TreeScope.Children,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem));
    if(items.Count==0||items.Count>100)
      throw new InvalidOperationException("The exact native combo option group exceeds the bounded selector or is empty.");
    int matches=0;
    bool containsTarget=false;
    foreach(AutomationElement item in items){
      if(item.Current.Name==option)matches++;
      if(Automation.Compare(item,target))containsTarget=true;
    }
    if(matches!=1||!containsTarget)
      throw new InvalidOperationException("The exact native option is ambiguous or no longer belongs to its observed group.");
    return items;
  }
  AutomationElement ExactComboOption(AutomationElement combo,string option){
    Identity(false);List<AutomationElement> scopes=new List<AutomationElement>{combo,root};scopes.AddRange(OwnedPopups());List<AutomationElement> matches=new List<AutomationElement>();List<object> candidates=new List<object>();object chosen=null;
    Condition condition=new AndCondition(new PropertyCondition(AutomationElement.NameProperty,option),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem));
    for(int index=0;index<scopes.Count;index++){
      AutomationElement scope=scopes[index];
      string scopeName=index==0?"combo-subtree":index==1?"owned-root":"owned-popup";
      foreach(AutomationElement item in scope.FindAll(TreeScope.Descendants,condition)){
        object observed;
        try{
          Rect bounds=item.Current.BoundingRectangle;bool enabled=item.Current.IsEnabled,offscreen=item.Current.IsOffscreen;
          bool actionable=enabled&&!offscreen&&!bounds.IsEmpty&&double.IsFinite(bounds.X)&&double.IsFinite(bounds.Y)&&double.IsFinite(bounds.Width)&&double.IsFinite(bounds.Height)&&bounds.Width>0&&bounds.Height>0;
          observed=new{observedAtUtcMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),scope=scopeName,scopeHandle=scope.Current.NativeWindowHandle,scopeRuntimeId=scope.GetRuntimeId(),ownedWindowHandle=window.ToInt64(),candidateHandle=item.Current.NativeWindowHandle,runtimeId=item.GetRuntimeId(),name=item.Current.Name,enabled=enabled,offscreen=offscreen,bounds=bounds.ToString(),actionable=actionable,patterns=Array.ConvertAll(item.GetSupportedPatterns(),pattern=>pattern.ProgrammaticName)};
          candidates.Add(observed);
          if(actionable){
            bool duplicate=false;foreach(AutomationElement match in matches)if(Automation.Compare(match,item)){duplicate=true;break;}
            if(!duplicate){matches.Add(item);chosen=observed;}
          }
        }catch(ElementNotAvailableException){candidates.Add(new{scope=scopeName,ownedWindowHandle=window.ToInt64(),name=option,stale=true,actionable=false});}
        LastComboOptionCandidates=candidates.ToArray();LastComboObservedOptions=LastComboOptionCandidates;LastComboChosenOption=matches.Count==1?chosen:null;
        if(matches.Count>1)throw new InvalidOperationException("More than one enabled, visible exact combo option is available across the owned combo, window and popups.");
        if(candidates.Count>100)throw new InvalidOperationException("Exact native combo candidates exceed the bounded selector.");
      }
    }
    LastComboOptionCandidates=candidates.ToArray();LastComboChosenOption=matches.Count==1?chosen:null;
    return matches.Count==1?matches[0]:null;
  }
  public object LastPopupComboSelection { get; private set; }
  public object KeyboardSelectPopupCombo(string name,string option,string[] catalogueOptions) {
    LastPopupComboSelection=null;
    if(!keyboardInput||!AccessibilityInput)throw new InvalidOperationException("Popup combo keyboard selection requires an explicit functional keyboard session.");
    if(name!="发行版本"&&name!="发行文件")throw new InvalidOperationException("Popup combo keyboard selection is restricted to the two GitHub release fields.");
    if(String.IsNullOrEmpty(option)||option.Length>512)throw new InvalidOperationException("Popup combo selection requires one exact bounded option name.");
    foreach(char character in option)if(Char.IsControl(character))throw new InvalidOperationException("Popup combo option names must be ordinary single-line text.");
    if(catalogueOptions==null||catalogueOptions.Length<1||catalogueOptions.Length>100)throw new InvalidOperationException("Popup combo selection requires the completed catalogue of 1 to 100 labels.");
    HashSet<string> unique=new HashSet<string>(StringComparer.Ordinal);int targetIndex=-1;
    for(int index=0;index<catalogueOptions.Length;index++) {
      string label=catalogueOptions[index];
      if(String.IsNullOrEmpty(label)||label.Length>512)throw new InvalidOperationException("Popup combo catalogue labels must be bounded ordinary text.");
      foreach(char character in label)if(Char.IsControl(character))throw new InvalidOperationException("Popup combo catalogue labels must be ordinary single-line text.");
      if(!unique.Add(label))throw new InvalidOperationException("Popup combo catalogue labels must be unique.");
      if(label==option)targetIndex=index;
    }
    string placeholder=name=="发行版本"?"请选择版本":"请选择发行文件";
    if(catalogueOptions[0]!=placeholder||targetIndex<0)throw new InvalidOperationException("The completed popup catalogue must start with the exact placeholder and contain the exact target once.");
    KeyboardGuard("before-popup-combo-observation");
    AutomationElement combo=KeyboardTarget(name);
    if(combo.Current.ControlType!=ControlType.ComboBox)throw new InvalidOperationException("Popup combo selection requires the exact native combo.");
    Dictionary<string,object> diagnostic=new Dictionary<string,object>{
      {"name",name},{"option",option},{"pid",Pid},{"windowHandle",Handle},
      {"method","guarded-pointer-open-popup-HomeDownEnter"},{"functionalOnly",true},
      {"catalogueOptions",catalogueOptions},{"targetIndex",targetIndex},{"plannedDownCount",targetIndex},
      {"pointerSent",false},{"homeSent",false},{"downCount",0},{"enterSent",false},{"selected",null},{"stage","present-control"}
    };
    LastPopupComboSelection=diagnostic;
    List<object> keySteps=new List<object>();diagnostic["keySteps"]=keySteps;
    try {
      object scroll;
      if(combo.TryGetCurrentPattern(ScrollItemPattern.Pattern,out scroll)) {
        KeyboardGuard("before-popup-combo-scroll");((ScrollItemPattern)scroll).ScrollIntoView();
        Wait(()=>{KeyboardGuard("await-popup-combo-presentation");return !combo.Current.IsOffscreen&&combo.Current.IsEnabled;},"The exact popup combo did not become visible and enabled after one semantic scroll.");
      } else PresentControl(combo);
      object expansionPattern;
      if(!combo.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out expansionPattern))throw new InvalidOperationException("The exact popup combo has no readable expansion state.");
      ExpandCollapsePattern expansion=(ExpandCollapsePattern)expansionPattern;
      if(expansion.Current.ExpandCollapseState!=ExpandCollapseState.Collapsed)throw new InvalidOperationException("Popup selection requires an initially closed native select; no existing popup was dismissed.");
      void GuardPopupFocus(string phase,bool expanded) {
        Dictionary<string,object> focusState=new Dictionary<string,object>{{"phase",phase},{"expectedExpanded",expanded},{"rawViewOwned",null},{"win32Owned",null}};
        diagnostic["lastFocus"]=focusState;
        KeyboardGuard(phase);
        if(combo.Current.IsOffscreen||!combo.Current.IsEnabled||expansion.Current.ExpandCollapseState!=(expanded?ExpandCollapseState.Expanded:ExpandCollapseState.Collapsed))
          throw new InvalidOperationException("The exact popup combo visibility, enabled state or expansion changed; no further input was sent.");
        AutomationElement focused=AutomationElement.FocusedElement;
        if(focused==null||!focused.Current.HasKeyboardFocus||focused.Current.IsOffscreen)throw new InvalidOperationException("The popup has no visible native accessibility focus owner; no further input was sent.");
        focusState["focusedName"]=focused.Current.Name;focusState["focusedRuntimeId"]=focused.GetRuntimeId();
        focusState["focusedType"]=focused.Current.ControlType.ProgrammaticName;focusState["focusedEnabled"]=focused.Current.IsEnabled;
        bool exactFocus=false;AutomationElement ownedRoot=root;int depth=0;
        for(AutomationElement ancestor=focused;ancestor!=null&&depth<32;ancestor=TreeWalker.RawViewWalker.GetParent(ancestor),depth++) {
          if(Automation.Compare(ancestor,combo)){exactFocus=true;break;}
          if(Automation.Compare(ancestor,ownedRoot))break;
        }
        focusState["rawViewOwned"]=exactFocus;
        if(!exactFocus)throw new InvalidOperationException("Popup keyboard focus is not the exact combo or one of its RawView descendants; no further input was sent.");
        GUITHREADINFO info=new GUITHREADINFO{size=(uint)Marshal.SizeOf(typeof(GUITHREADINFO))};
        if(!GetGUIThreadInfo(0,ref info)||info.focus==IntPtr.Zero)throw new InvalidOperationException("The actual Win32 popup keyboard focus could not be read; no further input was sent.");
        IntPtr focusRoot=GetAncestor(info.focus,2),focusOwner=GetAncestor(info.focus,3);
        focusState["focusWindowHandle"]=info.focus.ToInt64();focusState["focusRoot"]=focusRoot.ToInt64();focusState["focusRootOwner"]=focusOwner.ToInt64();
        focusState["win32Owned"]=focusRoot==window||focusOwner==window;
        if(focusRoot!=window&&focusOwner!=window)throw new InvalidOperationException("The actual Win32 popup focus is outside the owned window and its owned popups; no further input was sent.");
      }
      void SendPopupKey(string key,ushort code) {
        GuardPopupFocus("before-popup-"+key,true);
        Dictionary<string,object> step=new Dictionary<string,object>{{"key",key},{"virtualKey",code},{"focus",diagnostic["lastFocus"]},{"sent",false}};
        keySteps.Add(step);
        KeyboardGuard("dispatch-popup-"+key);
        Send(new[]{Key(code),Key(code,true)});step["sent"]=true;
        KeyboardSettled("after-popup-"+key+"-paint");
      }
      diagnostic["stage"]="open-exact-popup";KeyboardGuard("before-popup-combo-pointer");
      bool hitsCombo;diagnostic["beforePointer"]=ComboPointerState("before-popup-pointer",combo,out hitsCombo);
      if(!hitsCombo)throw new InvalidOperationException("The native pointer center does not hit the exact popup combo or its descendant; no click was sent.");
      ClickNative(combo);diagnostic["pointerSent"]=true;KeyboardSettled("after-popup-combo-pointer-paint");
      Wait(()=>{KeyboardGuard("await-popup-combo-expansion");return expansion.Current.ExpandCollapseState==ExpandCollapseState.Expanded;},"The single owned native click did not expand the exact combo.");
      diagnostic["expandedState"]=ComboState(name);
      diagnostic["stage"]="navigate-expanded-popup";
      SendPopupKey("Home",36);diagnostic["homeSent"]=true;
      for(int index=0;index<targetIndex;index++){SendPopupKey("Down",40);diagnostic["downCount"]=index+1;}
      diagnostic["stage"]="commit-expanded-popup";
      SendPopupKey("Enter",13);diagnostic["enterSent"]=true;
      diagnostic["stage"]="verify-exact-retained-selection";
      Wait(()=>{KeyboardGuard("verify-popup-combo-committed-value");return expansion.Current.ExpandCollapseState==ExpandCollapseState.Collapsed&&ComboMatches(combo,option);},"The native popup did not close and retain the exact requested value after Enter; no download was started.");
      GuardPopupFocus("verify-popup-combo-retained-focus",false);
      diagnostic["observedSelection"]=ComboState(name);diagnostic["selected"]=option;diagnostic["stage"]="selected";
      return diagnostic;
    } catch(Exception error) {
      diagnostic["error"]=error.Message;diagnostic["status"]="failed-or-blocked";
      throw;
    }
  }
  public object LastClosedComboSelection { get; private set; }
  public object KeyboardSelectClosedCombo(string name,string option,string[] catalogueOptions=null) {
    if(!keyboardInput||!AccessibilityInput)throw new InvalidOperationException("Closed combo keyboard selection requires an explicit functional keyboard session.");
    if(name!="发行版本"&&name!="发行文件")throw new InvalidOperationException("Closed combo keyboard selection is restricted to the two GitHub release fields.");
    if(String.IsNullOrEmpty(option)||option.Length>512)throw new InvalidOperationException("Closed combo selection requires one exact bounded option name.");
    foreach(char character in option)if(Char.IsControl(character))throw new InvalidOperationException("Closed combo option names must be ordinary single-line text.");
    if(catalogueOptions!=null){
      if(catalogueOptions.Length<1||catalogueOptions.Length>100)throw new InvalidOperationException("Closed combo catalogue must contain 1 to 100 labels.");
      HashSet<string> unique=new HashSet<string>(StringComparer.Ordinal);int targetMatches=0;
      foreach(string label in catalogueOptions){
        if(String.IsNullOrEmpty(label)||label.Length>512)throw new InvalidOperationException("Closed combo catalogue labels must be bounded ordinary text.");
        foreach(char character in label)if(Char.IsControl(character))throw new InvalidOperationException("Closed combo catalogue labels must be ordinary single-line text.");
        if(!unique.Add(label))throw new InvalidOperationException("Closed combo catalogue labels must be unique.");
        if(label==option)targetMatches++;
      }
      if(targetMatches!=1)throw new InvalidOperationException("Closed combo catalogue must contain the exact target once.");
    }
    KeyboardGuard("before-closed-combo-observation");
    AutomationElement combo=KeyboardTarget(name);
    if(combo.Current.ControlType!=ControlType.ComboBox)throw new InvalidOperationException("Closed combo keyboard selection requires the exact native combo.");
    Dictionary<string,object> diagnostic=new Dictionary<string,object>{
      {"name",name},{"option",option},{"pid",Pid},{"windowHandle",Handle},
      {"method","guarded-closed-native-select-HomeDown"},{"functionalOnly",true},
      {"options",new object[0]},{"homeSent",false},{"downCount",0},{"selected",null},{"stage","present-control"}
    };
    LastClosedComboSelection=diagnostic;
    object scroll;
    if(combo.TryGetCurrentPattern(ScrollItemPattern.Pattern,out scroll)){
      KeyboardGuard("before-closed-combo-scroll");((ScrollItemPattern)scroll).ScrollIntoView();
      Wait(()=>{KeyboardGuard("await-closed-combo-presentation");return !combo.Current.IsOffscreen&&combo.Current.IsEnabled;},"The exact closed combo did not become visible and enabled after one semantic scroll.");
    }else PresentControl(combo);
    object expansionPattern;
    if(!combo.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out expansionPattern))throw new InvalidOperationException("The exact native combo has no readable expansion state.");
    ExpandCollapsePattern expansion=(ExpandCollapsePattern)expansionPattern;
    if(expansion.Current.ExpandCollapseState!=ExpandCollapseState.Collapsed)throw new InvalidOperationException("Closed combo selection requires an already closed native select; no popup was dismissed.");
    diagnostic["stage"]="observe-exact-bounded-options";
    AutomationElementCollection items=null;
    Func<bool> observe=()=>{
      KeyboardGuard("observe-closed-combo-options");
      items=combo.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem));
      if(items.Count>100)throw new InvalidOperationException("Closed native combo options exceed the existing bounded selector.");
      int matches=0;List<object> observations=new List<object>();
      foreach(AutomationElement item in items){
        if(item.Current.Name==option)matches++;
        observations.Add(new{name=item.Current.Name,enabled=item.Current.IsEnabled,offscreen=item.Current.IsOffscreen,runtimeId=item.GetRuntimeId()});
      }
      diagnostic["options"]=observations.ToArray();
      if(matches>1)throw new InvalidOperationException("The exact closed native combo option is ambiguous.");
      return items.Count>0&&matches==1;
    };
    int navigationCount;
    if(catalogueOptions==null){
      Wait(observe,"The exact named option was not uniquely observed within the closed native combo.");
      navigationCount=items.Count;diagnostic["navigationBoundSource"]="native-descendants";
    }else{
      // Closed Chromium selects may expose no children. The completed real
      // release query bounds ordinary key navigation; only native selection
      // below can establish that the requested option was actually selected.
      observe();navigationCount=catalogueOptions.Length;
      diagnostic["navigationBoundSource"]="completed-release-catalogue";
      diagnostic["catalogueOptions"]=catalogueOptions;
      diagnostic["rawNativeOptionCount"]=items.Count;
    }
    diagnostic["optionCount"]=navigationCount;diagnostic["stage"]="focus-closed-combo";
    KeyboardGuard("before-closed-combo-focus");combo.SetFocus();
    Wait(()=>{KeyboardGuard("await-closed-combo-focus");return KeyboardFocusOwned(combo);},"The exact closed native combo did not receive actual keyboard focus.");
    Action<string> focused=phase=>{
      KeyboardFocused(combo,phase);
      if(!combo.Current.IsEnabled||expansion.Current.ExpandCollapseState!=ExpandCollapseState.Collapsed)throw new InvalidOperationException("The exact focused combo is disabled or no longer closed; keyboard selection stopped.");
    };
    string ReadSelection() {
      object pattern;
      if(combo.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))return ((ValuePattern)pattern).Current.Value;
      if(combo.TryGetCurrentPattern(SelectionPattern.Pattern,out pattern)) {
        AutomationElement[] selected=((SelectionPattern)pattern).Current.GetSelection();
        if(selected.Length==1)return selected[0].Current.Name;
      }
      throw new InvalidOperationException("The exact closed combo has no readable single retained selection; no further key was sent.");
    }
    List<object> selectionSteps=new List<object>();
    diagnostic["selectionSteps"]=selectionSteps;
    diagnostic["selectionWaitLimitMs"]=2000;
    string ObserveRetainedSelection(string key,int downCount,string previous,string expected) {
      Dictionary<string,object> step=new Dictionary<string,object>{
        {"key",key},{"downCount",downCount},{"previousValue",previous},{"expectedValue",expected},
        {"observedValue",null},{"retainedValue",null},{"reads",0},{"status","observing"}
      };
      selectionSteps.Add(step);diagnostic["stage"]="await-"+key+"-retained-selection";
      Stopwatch wait=Stopwatch.StartNew();string candidate=null;int reads=0;
      try {
        do {
          focused("observe-closed-combo-"+key);
          string observed=ReadSelection();step["observedValue"]=observed;step["reads"]=++reads;
          if(wait.ElapsedMilliseconds>=2000)break;
          if(catalogueOptions!=null&&Array.IndexOf(catalogueOptions,observed)<0)throw new InvalidOperationException("The native closed combo selected a label outside the completed catalogue; no next key was sent.");
          bool ready=expected!=null?observed==expected:observed!=previous;
          if(ready&&candidate==observed) {
            Paint();focused("verify-closed-combo-"+key+"-retained");
            string retained=ReadSelection();step["retainedValue"]=retained;step["reads"]=++reads;
            if(retained==observed&&wait.ElapsedMilliseconds<2000){step["status"]="retained";return retained;}
            candidate=null;
          } else candidate=ready?observed:null;
          Thread.Sleep(20);
        } while(wait.ElapsedMilliseconds<2000);
        throw new InvalidOperationException("The closed combo "+key+" selection was not observed and retained before the bounded wait; no next key was sent.");
      } catch(Exception error) {
        step["status"]="failed";step["error"]=error.Message;
        throw;
      } finally {step["elapsedMs"]=wait.Elapsed.TotalMilliseconds;}
    }
    string beforeHome=ReadSelection();
    diagnostic["stage"]="home";focused("before-closed-combo-home");
    Send(new[]{Key(36),Key(36,true)});diagnostic["homeSent"]=true;KeyboardSettled("after-closed-combo-home");
    // Both exact controls start with an enabled placeholder in ResourceGithub.
    string homeLabel=name=="发行版本"?"请选择版本":"请选择发行文件";
    string retainedSelection=ObserveRetainedSelection("Home",0,beforeHome,homeLabel);
    diagnostic["stage"]="bounded-down-navigation";
    for(int index=0;index<navigationCount&&!ComboMatches(combo,option);index++){
      focused("before-closed-combo-down");
      string beforeDown=ReadSelection();
      if(beforeDown!=retainedSelection)throw new InvalidOperationException("The retained closed combo selection changed before the next key; navigation stopped.");
      Send(new[]{Key(40),Key(40,true)});
      diagnostic["downCount"]=index+1;KeyboardSettled("after-closed-combo-down");
      retainedSelection=ObserveRetainedSelection("Down",index+1,beforeDown,null);
    }
    diagnostic["stage"]="verify-exact-retained-selection";
    Wait(()=>{focused("verify-closed-combo-final-selection");return ComboMatches(combo,option);},"Ordinary Home/Down navigation did not select the exact named option; disabled options were not invoked.");
    diagnostic["observedSelection"]=ComboState(name);diagnostic["selected"]=option;diagnostic["stage"]="selected";
    return diagnostic;
  }
  public string LastComboSelectionMethod { get; private set; }
  public string LastComboStage { get; private set; }
  public bool LastComboFocusBeforeExpand { get; private set; }
  public string SelectCombo(string name,string option,bool foreground=false,bool focusBeforeExpand=false){
    if(focusBeforeExpand&&(!AccessibilityInput||foreground))throw new InvalidOperationException("Focus before expansion requires an accessibility-only functional selection.");
    LastComboFocusBeforeExpand=false;
    LastComboOptionCandidates=new object[0];LastComboObservedOptions=new object[0];LastComboChosenOption=null;
    LastComboPointerStates=new object[0];
    LastComboSelectionMethod="not-selected";
    LastComboStage="find-control";
    AutomationElement combo=Unique(name,ControlType.ComboBox);
    LastComboStage="present-control";
    object scrollPattern;
    if((foreground||focusBeforeExpand)&&combo.TryGetCurrentPattern(ScrollItemPattern.Pattern,out scrollPattern)){
      ((ScrollItemPattern)scrollPattern).ScrollIntoView();
      Wait(()=>!combo.Current.IsOffscreen&&combo.Current.IsEnabled,"The exact native combo did not become visible after its single semantic scroll.");
    }else PresentControl(combo);
    LastComboStage="read-current-selection";
    if(ComboMatches(combo,option)){Paint();LastComboSelectionMethod="already-selected-no-input";return option;}
    if(AccessibilityInput&&!foreground){
      if(focusBeforeExpand){
        LastComboStage="focus-accessible-combo-before-expansion";Identity(false);
        uint focusInputTick=LastInputTick();combo.SetFocus();
        Wait(()=>{
          Identity(false);uint observedInputTick=LastInputTick();
          if(observedInputTick!=focusInputTick)throw new InvalidOperationException("Desktop input changed during the explicit combo focus phase; no expansion or selection was sent. expectedTick="+focusInputTick+"; currentTick="+observedInputTick);
          AutomationElement focused=AutomationElement.FocusedElement;
          return combo.Current.HasKeyboardFocus&&focused!=null&&Automation.Compare(focused,combo);
        },"The exact owned combo did not receive native focus before accessible expansion.");
        LastComboFocusBeforeExpand=true;
      }
      LastComboStage="get-accessible-expansion-pattern";
      object expandPattern;if(!combo.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out expandPattern))throw new InvalidOperationException("Exact native combo has no accessible expansion pattern; no keyboard fallback was attempted.");
      ExpandCollapsePattern expand=(ExpandCollapsePattern)expandPattern;
      LastComboStage="expand-accessible-control";
      if(expand.Current.ExpandCollapseState==ExpandCollapseState.Collapsed)expand.Expand();
      else if(expand.Current.ExpandCollapseState!=ExpandCollapseState.Expanded)throw new InvalidOperationException("Exact native combo is not in an accessible expandable state.");
      LastComboStage="wait-accessible-option";
      AutomationElement target=null;Wait(()=>{target=ExactComboOption(combo,option);return target!=null;},"Exact option did not become available in the owned accessible combo or its popup.");
      LastComboStage="revalidate-accessible-option";
      target=ExactComboOption(combo,option);
      if(target==null)throw new InvalidOperationException("The exact enabled, visible combo option changed before selection; no selection was sent.");
      LastComboStage="select-accessible-option";
      Identity(false);object selection;
      if(target.TryGetCurrentPattern(SelectionItemPattern.Pattern,out selection)){((SelectionItemPattern)selection).Select();LastComboSelectionMethod="native-accessibility-SelectionItem.Select";}
      else if(target.TryGetCurrentPattern(InvokePattern.Pattern,out selection)){((InvokePattern)selection).Invoke();LastComboSelectionMethod="native-accessibility-Invoke.Invoke";}
      else throw new InvalidOperationException("Exact native combo option has no accessible selection or invocation pattern; no keyboard fallback was attempted.");
      LastComboStage="verify-accessible-selection";
      Wait(()=>ComboMatches(combo,option),"Accessible native combo selection was not reflected in the actual selected value.");
      LastComboStage="collapse-accessible-control";
      if(expand.Current.ExpandCollapseState==ExpandCollapseState.Expanded)expand.Collapse();
      LastComboStage="verify-retained-accessible-selection";
      Wait(()=>ComboMatches(combo,option),"Accessible native combo did not retain the exact selected value after closing.");return option;
    }
    // Chromium exposes the closed HTML select options but reports them disabled.
    // Navigate the focused native select, then verify the real selected value.
    LastComboStage="restore-owned-foreground";RestoreOwnedForegroundOnce();
    LastComboStage="verify-owned-foreground";Identity(true);
    if(foreground){
      object expansionPattern;
      if(!combo.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out expansionPattern))
        throw new InvalidOperationException("The exact foreground combo has no expansion state to verify its native pointer input.");
      ExpandCollapsePattern expansion=(ExpandCollapsePattern)expansionPattern;
      bool hitsCombo;
      List<object> pointerStates=new List<object>();
      pointerStates.Add(ComboPointerState("before-pointer",combo,out hitsCombo));
      LastComboPointerStates=pointerStates.ToArray();
      if(expansion.Current.ExpandCollapseState==ExpandCollapseState.Collapsed){
        if(!hitsCombo)throw new InvalidOperationException("The native pointer center does not hit the exact combo or its descendant; no click was sent.");
        LastComboStage="click-owned-combo-before-expansion";ClickNative(combo);
        LastComboStage="paint-after-combo-click";Paint();
      }else if(expansion.Current.ExpandCollapseState!=ExpandCollapseState.Expanded){
        throw new InvalidOperationException("The exact native combo is not in a stable expandable state; no click was sent.");
      }
      pointerStates.Add(ComboPointerState("after-pointer-or-already-expanded",combo,out hitsCombo));
      LastComboPointerStates=pointerStates.ToArray();
      LastComboStage="wait-native-combo-expansion";
      Wait(()=>expansion.Current.ExpandCollapseState==ExpandCollapseState.Expanded,"The single native combo click did not open the exact owned combo.");
    }else{
      LastComboStage="focus-combo-before-expansion";combo.SetFocus();
      LastComboStage="get-expansion-pattern";
      object expansion;combo.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out expansion);
      if(expansion!=null){LastComboStage="expand-control";((ExpandCollapsePattern)expansion).Expand();}
    }
    AutomationElementCollection items=null;
    LastComboStage="wait-combo-options";
    Wait(()=>{
      if(foreground){
        AutomationElement target=ExactComboOption(combo,option);
        if(target==null)return false;
        items=ComboOptionGroup(target,option);
        return true;
      }
      items=combo.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem));
      int matches=0;
      foreach(AutomationElement item in items)if(item.Current.Name==option)matches++;
      if(matches>1||items.Count>100)throw new InvalidOperationException("Exact native combo option is ambiguous or exceeds the bounded selector.");
      return matches==1;
    },"Exact native combo option did not finish loading.");
    LastComboStage="close-owned-popup";
    Identity(true);Send(new[]{Key(27),Key(27,true)});Paint();
    LastComboStage="restore-owned-foreground-before-selection";RestoreOwnedForegroundOnce();
    LastComboStage="verify-owned-foreground-before-selection";Identity(true);
    LastComboStage="focus-combo-before-selection";combo.SetFocus();
    LastComboStage="wait-combo-focus-before-selection";
    Wait(()=>combo.Current.HasKeyboardFocus&&Automation.Compare(AutomationElement.FocusedElement,combo),"Exact owned combo did not receive keyboard focus.");
    LastComboStage="close-popup-and-select-first-option";
    Send(new[]{Key(36),Key(36,true)});Paint();
    LastComboStage="navigate-combo-options";
    for(int index=0;index<items.Count&&!ComboMatches(combo,option);index++){
      Identity(true);
      if(!Automation.Compare(AutomationElement.FocusedElement,combo))throw new InvalidOperationException("Exact native combo lost keyboard focus; selection stopped.");
      Send(new[]{Key(40),Key(40,true)});Paint();
    }
    LastComboStage="verify-final-selection";
    Wait(()=>ComboMatches(combo,option),"Native combo selection was not reflected in the actual selected value.");
    LastComboSelectionMethod=foreground?"guarded-foreground-pointer-open-keyboard-HomeDown":"guarded-foreground-keyboard-HomeDown";
    LastComboStage="selected";
    return option;
  }
  public bool SetToggle(string name,bool value){AutomationElement element=Unique(name,ControlType.CheckBox);PresentControl(element);TogglePattern pattern=(TogglePattern)element.GetCurrentPattern(TogglePattern.Pattern);if(pattern.Current.ToggleState==ToggleState.Indeterminate)throw new InvalidOperationException("Synthetic check box has indeterminate state; no blind toggle was applied.");if((pattern.Current.ToggleState==ToggleState.On)!=value)pattern.Toggle();Wait(()=>(pattern.Current.ToggleState==ToggleState.On)==value);return pattern.Current.ToggleState==ToggleState.On;}
  public void Resize(int width,int height){Identity(false);if(width<960||width>2560||height<650||height>1440)throw new InvalidOperationException("Native test window size is outside the supported validation range.");if(!SetWindowPos(window,IntPtr.Zero,60,60,width,height,0x0004|0x0010))throw new InvalidOperationException("The owned native window could not be resized.");Paint();}
  public void Capture(string path){Identity(false);path=Path.GetFullPath(path);if(!path.StartsWith(@"D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\",StringComparison.OrdinalIgnoreCase)||Path.GetExtension(path)!=".png"||File.Exists(path))throw new InvalidOperationException("Native screenshots must be new PNGs inside the approved validation directory.");RECT box;if(!GetWindowRect(window,out box))throw new InvalidOperationException("Owned native window bounds unavailable.");Paint();using(System.Drawing.Bitmap bitmap=new System.Drawing.Bitmap(box.r-box.l,box.b-box.t))using(System.Drawing.Graphics graphics=System.Drawing.Graphics.FromImage(bitmap)){IntPtr hdc=graphics.GetHdc();try{if(!PrintWindow(window,hdc,2))throw new InvalidOperationException("The owned window could not be rendered for capture.");}finally{graphics.ReleaseHdc(hdc);}bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);}}
  public bool RecoverQuit(){if(process.HasExited)return true;Identity(false);AutomationElement quit=Named(quitName,ControlType.Button);if(quit==null){AutomationElement help=Button("工作区快捷键");((InvokePattern)help.GetCurrentPattern(InvokePattern.Pattern)).Invoke();Wait(()=>Named(quitName,ControlType.Button)!=null);quit=Button(quitName);}((InvokePattern)quit.GetCurrentPattern(InvokePattern.Pattern)).Invoke();return process.WaitForExit(15000);}
  JsonElement PipeRequest(object request){Identity(false);string sid=WindowsIdentity.GetCurrent().User.Value;string key=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("io.skillmanager.desktop\0"+sid))).ToLowerInvariant();using(NamedPipeClientStream pipe=new NamedPipeClientStream(".","AgentResourceManager-"+key,PipeDirection.InOut,PipeOptions.Asynchronous)){pipe.Connect(2000);uint owner;if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out owner)||owner!=(uint)process.Id)throw new InvalidOperationException("The existing local backend is not owned by this test's native process.");using(CancellationTokenSource stop=new CancellationTokenSource(5000)){byte[] bytes=JsonSerializer.SerializeToUtf8Bytes(request);pipe.WriteAsync(BitConverter.GetBytes(bytes.Length),stop.Token).AsTask().GetAwaiter().GetResult();pipe.WriteAsync(bytes,stop.Token).AsTask().GetAwaiter().GetResult();byte[] length=new byte[4];pipe.ReadExactlyAsync(length,stop.Token).AsTask().GetAwaiter().GetResult();int count=BitConverter.ToInt32(length,0);if(count<2||count>8*1024*1024)throw new InvalidOperationException("Invalid bounded local backend frame.");byte[] response=new byte[count];pipe.ReadExactlyAsync(response,stop.Token).AsTask().GetAwaiter().GetResult();pipe.WriteAsync(new byte[]{1},stop.Token).AsTask().GetAwaiter().GetResult();using(JsonDocument document=JsonDocument.Parse(response)){JsonElement body=document.RootElement;if(!body.GetProperty("ok").GetBoolean())throw new InvalidOperationException(body.GetProperty("error").GetString());return body.GetProperty("value").Clone();}}}}
  public string ReadObservation(string name){if(name!="content_cache_stats"&&name!="task_list")throw new InvalidOperationException("Only fixed read-only observation tools are accepted by this harness.");JsonElement status=PipeRequest(new{protocol=1,kind="status"});if(!status.GetProperty("ready").GetBoolean()||!String.Equals(Path.GetFullPath(status.GetProperty("dataDir").GetString()),dataDirectory,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("The local backend did not confirm this exact isolated test database.");return PipeRequest(new{protocol=1,kind="tool",name=name,arguments=new{}}).GetRawText();}
  public string ReadTask(string id){if(String.IsNullOrEmpty(id)||id.Length>256||id.IndexOf('\0')>=0)throw new InvalidOperationException("Invalid observed native task identity.");JsonElement status=PipeRequest(new{protocol=1,kind="status"});if(!status.GetProperty("ready").GetBoolean()||!String.Equals(Path.GetFullPath(status.GetProperty("dataDir").GetString()),dataDirectory,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("The local backend did not confirm this exact isolated test database.");return PipeRequest(new{protocol=1,kind="tool",name="task_get",arguments=new{taskId=id}}).GetRawText();}
  public object MemorySample(){Identity(false);IntPtr snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))throw new InvalidOperationException("Could not observe the native process family.");Dictionary<int,int> parents=new Dictionary<int,int>();try{PROCESSENTRY entry=new PROCESSENTRY{size=(uint)Marshal.SizeOf(typeof(PROCESSENTRY))};if(Process32First(snapshot,ref entry))do{parents[(int)entry.pid]=(int)entry.parent;}while(Process32Next(snapshot,ref entry));}finally{CloseHandle(snapshot);}HashSet<int> owned=new HashSet<int>{process.Id};bool changed;do{changed=false;foreach(KeyValuePair<int,int> row in parents)if(owned.Contains(row.Value)&&owned.Add(row.Key))changed=true;}while(changed);long privateBytes=0,workingSet=0;List<object> values=new List<object>();foreach(int pid in owned){try{using(Process child=Process.GetProcessById(pid)){long time=child.StartTime.ToUniversalTime().ToFileTimeUtc();if(time<created)continue;long p=child.PrivateMemorySize64,w=child.WorkingSet64;privateBytes+=p;workingSet+=w;values.Add(new{pid=pid,creationFileTime=time.ToString(),privateBytes=p,workingSetBytes=w,cpuMs=child.TotalProcessorTime.TotalMilliseconds});}}catch(ArgumentException){}catch(InvalidOperationException){}}return new{observedAtUtc=DateTime.UtcNow.ToString("o"),privateBytes=privateBytes,workingSetBytes=workingSet,processes=values};}
  public bool Exited{get{return process.HasExited;}}
  void RequireDriverMemoryDiagnostic() {
    if(!driverMemoryDiagnostic||!AccessibilityInput||keyboardInput)throw new InvalidOperationException("Driver memory diagnostics were not explicitly enabled for this accessibility-only session.");
  }
  public object DriverMemory() {
    RequireDriverMemoryDiagnostic();
    // These fields describe this PowerShell measurement process. GC information
    // describes the most recent collection, and reading it does not request one.
    GCMemoryInfo information=GC.GetGCMemoryInfo();
    using(Process driver=Process.GetCurrentProcess()) {
      driver.Refresh();
      return new {
        diagnosticOnly=true,appGcRequested=false,observedAtUtc=DateTime.UtcNow.ToString("o"),
        pid=driver.Id,creationFileTime=driver.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(),
        privateBytes=driver.PrivateMemorySize64,workingSetBytes=driver.WorkingSet64,
        managedTotalMemoryBytes=GC.GetTotalMemory(false),
        collectionCounts=new {gen0=GC.CollectionCount(0),gen1=GC.CollectionCount(1),gen2=GC.CollectionCount(2)},
        gcMemoryInfo=new {
          heapSizeBytes=information.HeapSizeBytes,fragmentedBytes=information.FragmentedBytes,
          totalCommittedBytes=information.TotalCommittedBytes,promotedBytes=information.PromotedBytes,
          pinnedObjectsCount=information.PinnedObjectsCount,finalizationPendingCount=information.FinalizationPendingCount,
          memoryLoadBytes=information.MemoryLoadBytes,highMemoryLoadThresholdBytes=information.HighMemoryLoadThresholdBytes,
          totalAvailableMemoryBytes=information.TotalAvailableMemoryBytes,index=information.Index,
          generation=information.Generation,compacted=information.Compacted,concurrent=information.Concurrent
        }
      };
    }
  }
  public object CollectDriverMemory() {
    RequireDriverMemoryDiagnostic();
    object before=DriverMemory();
    GC.Collect(2,GCCollectionMode.Forced,true,true);
    // COM finalizers can block on providers. Omit an explicit finalizer wait,
    // so after may precede finalizer completion.
    object after=DriverMemory();
    return new {diagnosticOnly=true,appGcRequested=false,before=before,after=after};
  }
  public object ValidateClientRelease(int controllerPid,int observerPid,string observerCreated) {
    RequireDriverMemoryDiagnostic();Identity(false);
    if(FocusDiagnosticOnly||ConcurrentObservation||observerPid<=0||controllerPid<=0||observerPid==process.Id||String.IsNullOrEmpty(observerCreated))throw new InvalidOperationException("Diagnostic client release is unavailable in this session.");
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1))throw new InvalidOperationException("Client handoff ownership unavailable.");
    Dictionary<int,int> parents=new Dictionary<int,int>();
    try{PROCESSENTRY entry=new PROCESSENTRY{size=(uint)Marshal.SizeOf(typeof(PROCESSENTRY))};if(Process32First(snapshot,ref entry))do{parents[(int)entry.pid]=(int)entry.parent;}while(Process32Next(snapshot,ref entry));}finally{CloseHandle(snapshot);}
    using(Process driver=Process.GetCurrentProcess())using(Process observer=Process.GetProcessById(observerPid))using(Process controller=Process.GetProcessById(controllerPid)) {
      if(observerPid==driver.Id||!parents.ContainsKey(driver.Id)||parents[driver.Id]!=controllerPid||!parents.ContainsKey(observerPid)||parents[observerPid]!=controllerPid||observer.HasExited||controller.HasExited||controller.StartTime>driver.StartTime||controller.StartTime>observer.StartTime||observer.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()!=observerCreated||!observer.ProcessName.Equals("pwsh",StringComparison.OrdinalIgnoreCase)||!controller.ProcessName.Equals("node",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Client handoff is not owned by this live diagnostic controller.");
    }
    return new{released=true,pid=Pid,creationFileTime=CreationFileTime,windowHandle=Handle,controllerPid=controllerPid,observerPid=observerPid,observerCreationFileTime=observerCreated};
  }
  public void Dispose(){process.Dispose();}
}
'@

if ($CompileOnly) { [pscustomobject]@{driver='UIAutomation/SendInput/DwmFlush';compiled=$true} | ConvertTo-Json -Compress; return }
$approved='D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\'
$DataDirectory=[IO.Path]::GetFullPath($DataDirectory)
$OutputFile=[IO.Path]::GetFullPath($OutputFile)
if (-not $DataDirectory.StartsWith($approved,[StringComparison]::OrdinalIgnoreCase) -or -not $OutputFile.StartsWith($approved,[StringComparison]::OrdinalIgnoreCase)) { throw 'Only the approved isolated validation paths may be used.' }
$datasetRoot=Split-Path -Parent $DataDirectory
$marker=Get-Content -LiteralPath (Join-Path $datasetRoot 'fixture-owner.json') -Raw | ConvertFrom-Json
if ($marker.syntheticOnly -ne $true -or $marker.format -notin @('agent-resource-manager-native-performance-v1','agent-resource-manager-native-migration-v1','agent-resource-manager-native-lifecycle-v1')) { throw 'The synthetic dataset marker is missing.' }
$descriptor=Get-Content -LiteralPath (Join-Path $datasetRoot 'dataset.json') -Raw|ConvertFrom-Json
$actualHash=(Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Candidate executable hash changed; do not run a different binary under this evidence.' }
if ($PinnedTransportProofBase64 -or $GuardNodeExecutable -or $TransportFileSha256) {
    if ($Mode -ne 'bridge' -or -not $PinnedTransportProofBase64 -or -not $GuardNodeExecutable -or $PinnedTransportProofBase64.Length -gt 16384 -or $ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Explicit bound transport metadata and a guard executable are required.' }
    $transportHash=if($TransportFileSha256){$TransportFileSha256.ToLowerInvariant()}else{$ExpectedSha256.ToLowerInvariant()}
    if($transportHash -notmatch '^[a-f0-9]{64}$'){throw 'The formal transport file requires a separate verified SHA256.'}
    $guardScript=Join-Path $PSScriptRoot 'native-uia-client.mjs'
    foreach($guardPath in @($GuardNodeExecutable,$guardScript)) {
        $guardItem=Get-Item -LiteralPath $guardPath -Force -ErrorAction Stop
        if($guardItem -isnot [IO.FileInfo] -or -not [string]::Equals([IO.Path]::GetFullPath($guardPath),$guardItem.FullName,[StringComparison]::OrdinalIgnoreCase)){throw 'The fixed native guard must use physical ordinary files.'}
        $ancestor=$guardItem
        while($null -ne $ancestor){
            if(($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Redirected native guard files are not accepted.'}
            $ancestor=if($ancestor -is [IO.DirectoryInfo]){$ancestor.Parent}else{$ancestor.Directory}
        }
    }
    if([IO.Path]::GetFileName($GuardNodeExecutable) -ine 'node.exe'){throw 'The native guard requires the calling Node executable.'}
    $guardCaller=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$PID) -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop
    if($null -eq $guardCaller -or $null -eq $guardCaller.CreationDate -or $guardCaller.ParentProcessId -le 0){throw 'The native guard could not verify its calling Node parent.'}
    $guardParent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$guardCaller.ParentProcessId) -Property ProcessId,Name,ExecutablePath,CreationDate -ErrorAction Stop
    if($null -eq $guardParent -or $guardParent.Name -ine 'node.exe' -or $null -eq $guardParent.CreationDate -or $guardParent.CreationDate -gt $guardCaller.CreationDate -or -not [string]::Equals([string]$guardParent.ExecutablePath,[IO.Path]::GetFullPath($GuardNodeExecutable),[StringComparison]::OrdinalIgnoreCase)){throw 'The native guard executable does not match its live calling Node parent.'}
    $guardArguments=@($guardScript,'--manager-preflight','--sha256',$transportHash,'--pinned-transports-base64',$PinnedTransportProofBase64)
    $guardResult=@(& $GuardNodeExecutable @guardArguments 2>&1)
    if($LASTEXITCODE -ne 0 -or $guardResult.Count -ne 1 -or [string]$guardResult[0] -cne 'native-manager-preflight-ok-v1'){throw 'The bound transport preflight did not confirm exclusive native launch. No product was started.'}
} elseif (@(Get-Process -Name 'agent-resource-manager','skill-manager' -ErrorAction SilentlyContinue).Count) { throw 'An existing manager is running. No other process was closed or reused.' }
$temporary=Join-Path $datasetRoot 'native-temp'; [IO.Directory]::CreateDirectory($temporary) | Out-Null
$report=[ordered]@{formatVersion=1;driver='Windows UIAutomation + SendInput + double DwmFlush';mode=$Mode;status='not-measured';executable=[IO.Path]::GetFullPath($Executable);executableSha256=$actualHash;dataDirectory=$DataDirectory;harnessSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();datasetDescriptorSha256=(Get-FileHash -LiteralPath (Join-Path $datasetRoot 'dataset.json') -Algorithm SHA256).Hash.ToLowerInvariant();startedAt=[DateTime]::UtcNow.ToString('o');samples=@();startupMs=$null;closedNormally=$false;limits=@{p95Ms=200;requiredPerCategory=100};observationCostsIncluded=$true}
$report.privateUi=[bool]$PrivateUi
$report.basicModeRequested=[bool]$BasicMode
$report.workbenchOnlyReadinessRequested=[bool]$WorkbenchOnlyReadiness
$report.readinessMode=$readinessMode
if(-not $WorkbenchOnlyReadiness){$report.strictReadinessTimeoutMs=[NativeUiMeasurement]::StrictReadinessTimeoutMs}
$versionInfo=[Diagnostics.FileVersionInfo]::GetVersionInfo([IO.Path]::GetFullPath($Executable));$report.productVersion=$versionInfo.ProductVersion;$report.fileVersion=$versionInfo.FileVersion
$session=$null;$ready=$false;$clientReleased=$false
try {
    $session=[NativeUiMeasurement]::new([IO.Path]::GetFullPath($Executable),$DataDirectory,$temporary,[bool]$AccessibilityInput,[bool]$BasicMode,[bool]$KeyboardInput,[bool]$DriverMemoryDiagnostic)
    $session.ConcurrentObservation=[bool]$ConcurrentObservation
    $report.observationMode=if($ConcurrentObservation){'concurrent-accessibility-diagnostic'}else{'synchronous-input-then-observation'}
    $report.inputMethod=if($AccessibilityInput){"native-accessibility-patterns"}else{"SendInput"}
    $report.functionalKeyboardInputRequested=[bool]$KeyboardInput
    $report.pid=$session.Pid;$report.creationFileTime=$session.CreationFileTime;$report.windowHandle=$session.Handle
    $report.integrityLevel=$session.IntegrityLevel;$report.launcher='same-user Process.Start; no token or policy changes'
    if($WorkbenchOnlyReadiness){$session.ReadyWorkbench()}else{$session.Ready([Math]::Min(20,[int]$descriptor.skillCount))};$ready=$true;$report.startupMs=$session.StartupMs
    if ($Mode -eq 'bridge') {
        [pscustomobject]@{event='ready';pid=$session.Pid;creationFileTime=$session.CreationFileTime;windowHandle=$session.Handle;startupMs=$session.StartupMs;driver=$session.Driver;dataDirectory=$DataDirectory;executableSha256=$actualHash;harnessSha256=$report.harnessSha256;integrityLevel=$report.integrityLevel;launcher=$report.launcher;basicModeRequested=[bool]$BasicMode;workbenchOnlyReadinessRequested=[bool]$WorkbenchOnlyReadiness;readinessMode=$readinessMode;functionalKeyboardInputRequested=[bool]$KeyboardInput} | ConvertTo-Json -Compress | Write-Output
        while($null -ne ($line=[Console]::ReadLine())){
            $request=$line|ConvertFrom-Json
            $report.lastOperation=[string]$request.op
            if(-not $PrivateUi){$report.lastSelector=[string]$request.name}
            try{
                if($session.FocusDiagnosticOnly -and $request.op -notin @('memory','cache','tasks','task','windowIdentity','quit')){throw 'The owned-focus diagnostic sealed this session; only read-only observations and normal quit are allowed.'}
                if($request.op -eq 'diagnoseOwnedFocus' -and ($PrivateUi -or -not $KeyboardInput -or -not $AccessibilityInput)){throw 'The owned-focus diagnostic requires an explicitly enabled non-private accessibility and functional keyboard session.'}
                if($request.op -eq 'keyboardSelectClosedCombo' -and ($PrivateUi -or -not $KeyboardInput -or -not $AccessibilityInput)){throw 'Closed combo keyboard selection requires an explicitly enabled non-private functional keyboard session.'}
                if($request.op -eq 'keyboardSelectPopupCombo' -and ($PrivateUi -or -not $KeyboardInput -or -not $AccessibilityInput)){throw 'Popup combo keyboard selection requires an explicitly enabled non-private functional keyboard session.'}
                if($PrivateUi -and $request.op -in @('snapshot','names','screenshot','comboState','windowIdentity')){throw 'Whole-interface observations are disabled for the private UI session.'}
                if($request.op -in @('keyboardShortcut','keyboardEdit','keyboardField','keyboardIme','prepareKeyboardForeground') -and ($PrivateUi -or -not $KeyboardInput)){throw 'Keyboard operations require an explicitly enabled non-private functional session.'}
                if($request.op -in @('driverMemory','collectDriverMemory') -and (-not $DriverMemoryDiagnostic -or $Mode -ne 'bridge' -or -not $AccessibilityInput -or $KeyboardInput -or $PrivateUi)){throw 'Driver memory diagnostics require an explicitly enabled non-private accessibility-only bridge session without keyboard input.'}
                $value=switch($request.op){
                    'releaseClient' {
                        if(-not $ReleaseDiagnosticClient -or $PrivateUi -or $KeyboardInput -or -not $AccessibilityInput -or -not $DriverMemoryDiagnostic){throw 'Diagnostic client release was not explicitly enabled.'}
                        if($request.pid -ne $session.Pid -or [string]$request.creationFileTime -cne $session.CreationFileTime -or $request.windowHandle -ne $session.Handle){throw 'Client handoff application identity changed.'}
                        $handoff=$session.ValidateClientRelease([int]$request.controllerPid,[int]$request.observerPid,[string]$request.observerCreationFileTime)
                        $report.clientHandoff=$handoff;$report.clientReleasedForExternalObservation=$true;$report.ownedProcessStillRunning=$true;$clientReleased=$true
                        $handoff
                    }
                    'search' {if($request.index -lt 0 -or $request.index -gt 999){throw 'Synthetic Skill index outside fixture.'};$session.Search([int]$request.index)}
                    'clear' {$session.Clear();@{cleared=$true}}
                    'filter' {$session.Filter([bool]$request.github)}
                    'openDocument' {$session.OpenDocument([int]$request.index)}
                    'tab' {$session.Tab([bool]$request.home)}
                    'closeDocument' {$session.CloseDocument(('Perf Skill {0:0000}' -f [int]$request.index));@{closed=$true}}
                    'memory' {$session.MemorySample()}
                    'driverMemory' {$session.DriverMemory()}
                    'collectDriverMemory' {$session.CollectDriverMemory()}
                    'windowIdentity' {$identity=$session.WindowIdentity();@{capturedHandle=$identity.capturedHandle;currentMainHandle=$identity.currentMainHandle;uiaProcessId=$identity.uiaProcessId;foregroundHandle=$identity.foregroundHandle}}
                    'cache' {$session.ReadObservation('content_cache_stats')|ConvertFrom-Json}
                    'tasks' {$session.ReadObservation('task_list')|ConvertFrom-Json}
                    'task' {$session.ReadTask([string]$request.taskId)|ConvertFrom-Json}
                    'check' {$session.StartCheck();@{clicked=$true}}
                    'click' {$session.ClickNamed([string]$request.name,[string]$request.scope);@{clicked=$true}}
                    'type' {$session.TypeNamed([string]$request.name,[string]$request.value);@{typed=$true}}
                    'keyboardShortcut' {$session.KeyboardShortcut([string]$request.name,[string]$request.gesture)}
                    'keyboardEdit' {$session.KeyboardEdit([string]$request.name,[string]$request.value)}
                    'keyboardIme' {
                        if($request.PSObject.Properties.Name -contains 'prepareChineseIme' -and $request.prepareChineseIme -isnot [bool]){throw 'Chinese IME preparation requires an explicit boolean.'}
                        if($request.PSObject.Properties.Name -contains 'observeChineseIme' -and $request.observeChineseIme -isnot [bool]){throw 'Chinese IME observation requires an explicit boolean.'}
                        $modeToggleKey='shift'
                        if($request.PSObject.Properties.Name -contains 'modeToggleKey'){
                            if($request.modeToggleKey -isnot [string] -or $request.modeToggleKey -cnotin @('shift','ctrl')){throw 'IME mode toggle supports only the explicit shift or ctrl key.'}
                            $modeToggleKey=$request.modeToggleKey
                        }
                        try{$session.KeyboardIme([string]$request.name,[bool]$request.prepareChineseIme,[bool]$request.observeChineseIme,$modeToggleKey)}
                        finally{$report.keyboardIme=$session.LastKeyboardIme}
                    }
                    'keyboardField' {$session.KeyboardFieldState([string]$request.name)}
                    'prepareKeyboardForeground' {
                        try{$session.PrepareKeyboardForeground()}
                        finally{$report.keyboardForegroundPreparation=$session.LastKeyboardForegroundPreparation}
                    }
                    'diagnoseOwnedFocus' {
                        try{$session.DiagnoseOwnedFocus()}
                        finally{$report.ownedFocusDiagnostic=$session.LastOwnedFocusDiagnostic}
                    }
                    'names' {$session.Names()}
                    'snapshot' {$session.Names()}
                    'state' {$session.InspectNamed([string]$request.name,[string]$request.scope)}
                    'fields' {$session.FormFields()}
                    'invokeName' {$session.InvokeUnique([string]$request.name,[string]$request.scope);@{invoked=$true;functionalOnly=$true}}
                    'setField' {@{value=$session.SetField([string]$request.name,[string]$request.value,[bool]$request.numeric,[string]$request.scope);functionalOnly=$true}}
                    'reveal' {$session.RevealNamed([string]$request.name);@{revealed=$true;functionalOnly=$true}}
                    'selectTab' {$session.SelectTab([string]$request.name);@{selected=$true;functionalOnly=$true}}
                    'selectCombo' {
                        if($null -ne $request.foreground -and $request.foreground -isnot [bool]){throw 'Foreground selection requires an explicit JSON boolean.'}
                        $foregroundSelection=$request.foreground -is [bool] -and $request.foreground
                        if($request.PSObject.Properties.Name -contains 'focusBeforeExpand' -and $request.focusBeforeExpand -isnot [bool]){throw 'Focus before combo expansion requires an explicit JSON boolean.'}
                        $focusBeforeExpand=$request.focusBeforeExpand -is [bool] -and $request.focusBeforeExpand
                        if($focusBeforeExpand -and ($PrivateUi -or -not $AccessibilityInput -or $foregroundSelection)){throw 'Focus before expansion requires a non-private accessibility-only functional selection.'}
                        $selected=$session.SelectCombo([string]$request.name,[string]$request.option,$foregroundSelection,$focusBeforeExpand)
                        if(-not $PrivateUi -and $session.LastComboPointerStates.Length){$report.comboPointerStates=$session.LastComboPointerStates}
                        @{
                            selected=$selected;functionalOnly=$true;foregroundRequested=$foregroundSelection
                            focusBeforeExpandRequested=$focusBeforeExpand;focusBeforeExpandPerformed=$session.LastComboFocusBeforeExpand
                            functionalSelectionMode=if($session.LastComboFocusBeforeExpand){'native-accessibility-focus-before-expansion'}else{$session.LastComboSelectionMethod}
                            selectionMethod=$session.LastComboSelectionMethod;optionEvidence=if($PrivateUi){$null}else{$session.LastComboChosenOption}
                        }
                    }
                    'keyboardSelectPopupCombo' {
                        $report.popupComboSelection=$null
                        if($request.catalogueOptions -isnot [array] -or @($request.catalogueOptions | Where-Object {$_ -isnot [string]}).Count){throw 'Popup combo catalogueOptions must be an explicit JSON string array.'}
                        try{$session.KeyboardSelectPopupCombo([string]$request.name,[string]$request.option,[string[]]$request.catalogueOptions)}
                        finally{$report.popupComboSelection=$session.LastPopupComboSelection}
                    }
                    'keyboardSelectClosedCombo' {
                        if($request.PSObject.Properties.Name -contains 'catalogueOptions' -and $request.catalogueOptions -isnot [array]){throw 'Closed combo catalogueOptions must be a JSON array.'}
                        $catalogueOptions=if($request.PSObject.Properties.Name -contains 'catalogueOptions'){[string[]]$request.catalogueOptions}else{$null}
                        try{$session.KeyboardSelectClosedCombo([string]$request.name,[string]$request.option,$catalogueOptions)}
                        finally{$report.closedComboSelection=$session.LastClosedComboSelection}
                    }
                    'comboState' {$session.ComboState([string]$request.name)}
                    'toggle' {@{checked=$session.SetToggle([string]$request.name,[bool]$request.checked);functionalOnly=$true}}
                    'resize' {$session.Resize([int]$request.width,[int]$request.height);@{resized=$true}}
                    'screenshot' {$session.Capture([string]$request.path);@{path=$request.path;nativeWindowOnly=$true}}
                    'quit' {$report.closedNormally=$session.Quit();if(-not $report.closedNormally){throw 'Normal application quit failed.'};@{closedNormally=$true}}
                    default {throw 'Unknown native test operation; no product action was invoked.'}
                }
                [pscustomobject]@{id=$request.id;ok=$true;value=$value}|ConvertTo-Json -Depth 12 -Compress|Write-Output
                if($request.op -eq 'quit' -or $clientReleased){break}
            }catch{$bridgeException=$_.Exception.GetBaseException();$bridgeError=$bridgeException.Message;if(-not $bridgeError){$bridgeError='Native UI Automation provider failed ('+$bridgeException.GetType().Name+', '+$bridgeException.HResult+').'};[pscustomobject]@{id=$request.id;ok=$false;error=$bridgeError}|ConvertTo-Json -Compress|Write-Output;throw}
        }
        if(-not $report.closedNormally -and -not $clientReleased){$report.closedNormally=$session.Quit()}
    } elseif ($Mode -ne 'startup') {
        $count=if($Mode -eq 'probe'){2}else{100}
        for($i=0;$i -lt $count;$i++){ $report.samples+= $session.Search($i) }
        $session.Clear()
        for($i=0;$i -lt $count;$i++){ $report.samples+= $session.Filter(($i%2)-eq 0) }
        $null=$session.Search(0);$null=$session.OpenDocument(0)
        for($i=0;$i -lt $count;$i++){ $report.samples+= $session.Tab(($i%2)-eq 0) }
        $session.CloseDocument('Perf Skill 0000')
        for($i=0;$i -lt $count;$i++){ $null=$session.Search($i+10);$report.samples+=$session.OpenDocument($i+10);$session.CloseDocument(('Perf Skill {0:0000}' -f ($i+10))) }
    }
    if(-not $report.closedNormally -and -not $clientReleased){$report.closedNormally=$session.Quit()}
    if(-not $report.closedNormally -and -not $clientReleased){throw 'The owned test application did not close through its existing normal quit entry.'}
    $report.status=if($clientReleased){'diagnostic-client-released'}elseif($session.FocusDiagnosticOnly){'owned-focus-diagnostic-only'}elseif($Mode -eq 'probe'){'diagnostic-only'}elseif($Mode -eq 'startup'){'startup-observed'}else{'measurements-collected'}
} catch {
    $report.status='failed-or-blocked';$report.error=$_.Exception.GetBaseException().Message;$report.errorType=$_.Exception.GetBaseException().GetType().Name;$report.errorCode=$_.Exception.GetBaseException().HResult
    $startupFailure=$_.Exception.GetBaseException()
    if($startupFailure.Data.Contains('ownedProcessId')){
      $report.pid=$startupFailure.Data['ownedProcessId'];$report.creationFileTime=$startupFailure.Data['ownedProcessCreationFileTime'];$report.windowHandle=$startupFailure.Data['ownedWindowHandle']
      $report.closedNormally=[bool]$startupFailure.Data['closedNormally'];$report.ownedProcessStillRunning=[bool]$startupFailure.Data['ownedProcessStillRunning']
      if($startupFailure.Data.Contains('closeError')){$report.closeError=$startupFailure.Data['closeError']}
    }
    $report.errorStack=$_.Exception.GetBaseException().StackTrace
    $exceptionChain=@();$failureException=$_.Exception
    while($null -ne $failureException){$exceptionChain+=@{type=$failureException.GetType().FullName;message=$failureException.Message;code=$failureException.HResult;stack=$failureException.StackTrace};$failureException=$failureException.InnerException}
    $report.errorChain=$exceptionChain
    if($session -and $report.lastOperation -eq 'selectCombo'){$report.lastComboStage=$session.LastComboStage}
    if($session -and $report.lastOperation -eq 'search'){$report.requestedSearchValue=$session.RequestedSearchValue}
    if($session -and -not $session.Exited -and -not $clientReleased){
      if($session.InputPending){$report.inputStillPending=$true;$report.closeError='No diagnostics or exit input was sent while the prior native input was pending.'}
      else {
        if(-not $PrivateUi){
            try { $report.windowIdentity=$session.WindowIdentity() } catch { $report.windowIdentityError=$_.Exception.GetBaseException().Message }
            try { $report.names=$session.Names() } catch { $report.namesError=$_.Exception.GetBaseException().Message }
            if($report.lastOperation -eq 'search'){try{$report.searchObservation=$session.SearchObservation();$report.failureScreenshot=[IO.Path]::ChangeExtension($OutputFile,'.png');$session.Capture($report.failureScreenshot)}catch{$report.searchObservationError=$_.Exception.GetBaseException().Message}}
            if($report.lastOperation -eq 'selectCombo'){
                $report.focusBeforeExpandRequested=$request.focusBeforeExpand -is [bool] -and $request.focusBeforeExpand
                $report.focusBeforeExpandPerformed=$session.LastComboFocusBeforeExpand
                $report.comboOptionCandidates=$session.LastComboOptionCandidates
                $report.comboLastObservedOptions=$session.LastComboObservedOptions
                $report.comboChosenOption=$session.LastComboChosenOption
                $report.comboPointerStates=$session.LastComboPointerStates
                try{$report.comboState=$session.ComboState([string]$request.name)}catch{$report.comboStateError=$_.Exception.GetBaseException().Message}
            }
            if($report.lastOperation -eq 'selectCombo'){try{$report.failureScreenshot=[IO.Path]::ChangeExtension($OutputFile,'.png');$session.Capture($report.failureScreenshot)}catch{$report.failureScreenshotError=$_.Exception.GetBaseException().Message}}
        }else{$report.wholeUiDiagnostics='omitted-private-session'}
        if(-not $ready){$report.failedStartupGracefulExitAttempted=$true}
        try{$report.closedNormally=$session.RecoverQuit();$report.recoveryExitUsedInvoke=$true;if(-not $report.closedNormally){$report.closeError='The owned test application did not finish its graceful exit; its process was left running.'}}catch{$report.closeError=$_.Exception.GetBaseException().Message}
      }
    }
    if($session){$report.ownedProcessStillRunning=-not $session.Exited}
} finally {
    if($session){$session.Dispose()}
    $report.finishedAt=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($OutputFile,($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    [pscustomobject]@{status=$report.status;report=$OutputFile;pid=$report.pid;error=$report.error;closedNormally=$report.closedNormally} | ConvertTo-Json -Compress
}
if($report.status -eq 'failed-or-blocked'){exit 1}
