param([string]$Spec, [switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$refs = @((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName) + @('System.Drawing.Common.dll','System.Private.Windows.GdiPlus.dll','System.Private.Windows.Core.dll' | ForEach-Object { Join-Path $PSHOME $_ })
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public sealed class NativeVisualInput : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l,t,r,b; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; public POINT(int a,int b){x=a;y=b;} }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUT { public uint size,time; }
  [StructLayout(LayoutKind.Sequential)] struct GUI { public uint size,flags; public IntPtr active,focus,capture,menu,move,caret; public RECT rectangle; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION value; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT point; public uint reserved; }
  delegate bool EnumWindow(IntPtr handle,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle,StringBuilder value,int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle,StringBuilder value,int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll",SetLastError=true)] static extern bool AttachThreadInput(uint from,uint to,bool attach);
  [DllImport("user32.dll")] static extern bool PeekMessageW(out MSG message,IntPtr window,uint first,uint last,uint remove);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle,uint command);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle,uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle,out RECT value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr handle,IntPtr insertAfter,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int value);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUT value);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GUI value);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] values,int size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr handle,uint attribute,out uint value,uint size);
  readonly Process process; readonly string created,image,root; readonly IntPtr window; readonly RECT rectangle; readonly uint dpi;
  uint inputTick;
  bool foregroundPrepared;
  public NativeVisualInput(int pid,string creation,string executable,string directory,int[] frozenBounds) {
    if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new InvalidOperationException("Per-monitor DPI observation is unavailable.");
    process=Process.GetProcessById(pid);created=creation;image=Path.GetFullPath(executable);root=Path.GetFullPath(directory);
    if(!root.StartsWith(@"D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data\native-visual-",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Visual files require the exact generated validation root.");
    CheckProcess();inputTick=ReadInputTick();IntPtr found=IntPtr.Zero;int matches=0;
    EnumWindows((handle,unused)=>{uint owner;GetWindowThreadProcessId(handle,out owner);if(owner!=(uint)pid||!IsWindowVisible(handle))return true;var title=new StringBuilder(256);var name=new StringBuilder(256);GetWindowText(handle,title,256);GetClassName(handle,name,256);if(title.ToString()=="Agent Resource Manager"&&name.ToString()=="Tauri Window"){found=handle;matches++;}return true;},IntPtr.Zero);
    if(matches!=1||IsIconic(found))throw new InvalidOperationException("One visible, restored owned Tauri window is required.");
    window=found;
    if(frozenBounds!=null) {
      if(frozenBounds.Length!=4||frozenBounds[2]<600||frozenBounds[3]<400)
        throw new InvalidOperationException("The predetermined reference frame is invalid.");
      if(ReadInputTick()!=inputTick)throw new InvalidOperationException("Input changed before owned frame preparation.");
      if(!SetWindowPos(window,IntPtr.Zero,frozenBounds[0],frozenBounds[1],frozenBounds[2],frozenBounds[3],4|16|512))
        throw new InvalidOperationException("The exact owned reference frame could not be prepared.");
    }
    if(!GetWindowRect(window,out rectangle))throw new InvalidOperationException("Owned bounds unavailable.");
    if(frozenBounds!=null&&(rectangle.l!=frozenBounds[0]||rectangle.t!=frozenBounds[1]||rectangle.r-rectangle.l!=frozenBounds[2]||rectangle.b-rectangle.t!=frozenBounds[3]))
      throw new InvalidOperationException("Windows did not retain the predetermined reference frame.");
    dpi=GetDpiForWindow(window);
    if(dpi==0)throw new InvalidOperationException("Owned DPI unavailable.");
    if(ReadInputTick()!=inputTick)throw new InvalidOperationException("Input changed during owned window preparation.");
  }
  static uint ReadInputTick(){var value=new LASTINPUT{size=(uint)Marshal.SizeOf(typeof(LASTINPUT))};if(!GetLastInputInfo(ref value))throw new InvalidOperationException("Input observation unavailable.");return value.time;}
  void CheckProcess(){process.Refresh();if(process.HasExited||process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()!=created)throw new InvalidOperationException("Owned process identity changed.");var path=new StringBuilder(32768);uint size=(uint)path.Capacity;if(!QueryFullProcessImageName(process.Handle,0,path,ref size)||!String.Equals(Path.GetFullPath(path.ToString()),image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Owned executable changed.");}
  void Guard(bool requireForeground=true) {
    CheckProcess();
    uint owner;
    GetWindowThreadProcessId(window,out owner);
    RECT current;
    if(owner!=(uint)process.Id||!IsWindowVisible(window)||IsIconic(window)||!GetWindowRect(window,out current)||
       current.l!=rectangle.l||current.t!=rectangle.t||current.r!=rectangle.r||current.b!=rectangle.b||GetDpiForWindow(window)!=dpi)
      throw new InvalidOperationException("Owned window, position, size or DPI changed.");
    if(requireForeground&&GetAncestor(GetForegroundWindow(),2)!=window)
      throw new InvalidOperationException("Foreground changed. No further visual input was sent.");
    if(ReadInputTick()!=inputTick)
      throw new InvalidOperationException("Desktop input changed. Its baseline was not reset.");
  }
  public object PrepareForeground() {
    Guard(false);
    if(foregroundPrepared)throw new InvalidOperationException("Foreground preparation is permitted once, before operations.");
    foregroundPrepared=true;
    bool attached=false;
    uint currentThread=GetCurrentThreadId(),foregroundPid;
    IntPtr foregroundBefore=GetForegroundWindow();
    uint foregroundThread=GetWindowThreadProcessId(foregroundBefore,out foregroundPid);
    try {
      if(GetAncestor(foregroundBefore,2)!=window) {
        if(foregroundBefore==IntPtr.Zero||foregroundThread==0)
          throw new InvalidOperationException("The current foreground input thread is unavailable. No activation was attempted.");
        Guard(false);
        if(GetForegroundWindow()!=foregroundBefore)
          throw new InvalidOperationException("Foreground changed before input-queue preparation. No activation was attempted.");
        if(foregroundThread!=currentThread) {
          MSG message;
          // PM_NOREMOVE initializes this caller's queue without consuming messages.
          PeekMessageW(out message,IntPtr.Zero,0,0,0);
          Guard(false);
          if(GetForegroundWindow()!=foregroundBefore)
            throw new InvalidOperationException("Foreground changed before temporary queue attachment. No activation was attempted.");
          attached=AttachThreadInput(currentThread,foregroundThread,true);
          if(!attached)
            throw new InvalidOperationException("Temporary input-queue attachment failed: "+Marshal.GetLastWin32Error()+". No activation was attempted.");
          Guard(false);
        }
        if(GetForegroundWindow()!=foregroundBefore&&GetAncestor(GetForegroundWindow(),2)!=window)
          throw new InvalidOperationException("Foreground changed during temporary queue preparation. No activation was attempted.");
        Guard(false);
        if(GetAncestor(GetForegroundWindow(),2)!=window) {
          SetForegroundWindow(window);
          Guard(false);
        }
      }
    } finally {
      // Detach even when an ownership or input guard failed during preparation.
      if(attached) {
        if(!AttachThreadInput(currentThread,foregroundThread,false))
          throw new InvalidOperationException("Foreground preparation could not detach its input queue: "+Marshal.GetLastWin32Error());
        Guard(false);
      }
    }
    var wait=Stopwatch.StartNew();
    while(GetAncestor(GetForegroundWindow(),2)!=window) {
      Guard(false);
      IntPtr currentForeground=GetForegroundWindow();
      if(currentForeground!=foregroundBefore&&GetAncestor(currentForeground,2)!=window)
        throw new InvalidOperationException("Another window became foreground after the single activation attempt.");
      if(wait.ElapsedMilliseconds>=15000)
        throw new InvalidOperationException("The owned window did not become foreground after one prepared activation attempt.");
      System.Threading.Thread.Sleep(10);
    }
    Guard();
    return Identity();
  }
  public object Identity(){CheckProcess();return new{pid=process.Id,creationFileTime=created,windowHandle=window.ToInt64(),left=rectangle.l,top=rectangle.t,width=rectangle.r-rectangle.l,height=rectangle.b-rectangle.t,dpi=dpi,lastInputTick=inputTick,foreground=GetAncestor(GetForegroundWindow(),2)==window};}
  public object Observe(){Guard();return Identity();}
  void Paint(){if(DwmFlush()!=0||DwmFlush()!=0)throw new InvalidOperationException("Desktop composition failed.");}
  void Send(INPUT[] values) {
    Guard();
    foreach(int key in new[]{16,17,18,91,92})
      if((GetAsyncKeyState(key)&0x8000)!=0)
        throw new InvalidOperationException("A modifier key is already pressed. No input was sent.");
    if(SendInput((uint)values.Length,values,Marshal.SizeOf(typeof(INPUT)))!=(uint)values.Length)
      throw new InvalidOperationException("Native input did not complete.");
    inputTick=ReadInputTick();
    Paint();
    Guard();
  }
  static INPUT Key(ushort vk,bool up=false){return new INPUT{type=1,value=new UNION{key=new KEY{vk=vk,flags=up?2u:0u}}};}
  MOUSE PointMovement(int x,int y) {
    Guard();
    if(x<0||y<0||x>=rectangle.r-rectangle.l||y>=rectangle.b-rectangle.t||
       GetAncestor(WindowFromPoint(new POINT(rectangle.l+x,rectangle.t+y)),2)!=window)
      throw new InvalidOperationException("Frozen click is outside the hit-testable owned window.");
    int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
    return new MOUSE {
      x=(rectangle.l+x-left)*65535/Math.Max(1,width-1),
      y=(rectangle.t+y-top)*65535/Math.Max(1,height-1),
      flags=0x0001u|0x8000u|0x4000u
    };
  }
  public object Click(int x,int y) {
    Send(new[]{
      new INPUT{type=0,value=new UNION{mouse=PointMovement(x,y)}},
      new INPUT{type=0,value=new UNION{mouse=new MOUSE{flags=2}}},
      new INPUT{type=0,value=new UNION{mouse=new MOUSE{flags=4}}}
    });
    return new{clicked=true,x=x,y=y,lastInputTick=inputTick};
  }
  public object ScrollLibrary(int x,int y,bool up) {
    uint delta=up?1200u:unchecked((uint)-1200);
    Send(new[]{
      new INPUT{type=0,value=new UNION{mouse=PointMovement(x,y)}},
      new INPUT{type=0,value=new UNION{mouse=new MOUSE{flags=0x0800u,data=delta}}}
    });
    return new{scrolledUp=up,x=x,y=y,lastInputTick=inputTick};
  }
  public object Text(string value) {
    Guard();
    if(value==null||value.Length!=15||!value.StartsWith("perf-skill-",StringComparison.Ordinal)||
       !Int32.TryParse(value.Substring(11),out int index)||index<0||index>65||value!="perf-skill-"+index.ToString("0000"))
      throw new InvalidOperationException("Only the frozen synthetic search values are allowed.");
    var info=new GUI{size=(uint)Marshal.SizeOf(typeof(GUI))};
    if(!GetGUIThreadInfo(0,ref info)||info.focus==IntPtr.Zero||GetAncestor(info.focus,2)!=window)
      throw new InvalidOperationException("Actual keyboard focus is outside the owned window.");
    var keys=new System.Collections.Generic.List<INPUT>{Key(17),Key(65),Key(65,true),Key(17,true)};
    foreach(char character in value) {
      keys.Add(new INPUT{type=1,value=new UNION{key=new KEY{scan=character,flags=4}}});
      keys.Add(new INPUT{type=1,value=new UNION{key=new KEY{scan=character,flags=6}}});
    }
    Send(keys.ToArray());
    return new{typed=value,method="SendInput-Unicode-synthetic-search-only",imeEvidence=false,lastInputTick=inputTick};
  }
  void Box(int[] box){if(box==null||box.Length!=4||box[0]<0||box[1]<0||box[2]<2||box[3]<2||box[0]+box[2]>rectangle.r-rectangle.l||box[1]+box[3]>rectangle.b-rectangle.t||(long)box[2]*box[3]>2000000)throw new InvalidOperationException("Reference ROI is outside the fixed owned frame.");}
  string FilePath(string path) {
    path=Path.GetFullPath(path);
    if(!path.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||Path.GetExtension(path)!=".png")
      throw new InvalidOperationException("Only PNG files below the owned fixture are allowed.");
    for(string ancestor=File.Exists(path)?path:Path.GetDirectoryName(path);ancestor!=null;ancestor=Path.GetDirectoryName(ancestor))
      if((File.GetAttributes(ancestor)&FileAttributes.ReparsePoint)!=0)
        throw new InvalidOperationException("A capture path is a reparse point.");
    return path;
  }
  void Unobscured(int[] box) {
    Guard();Box(box);
    int left=rectangle.l+box[0],top=rectangle.t+box[1],right=left+box[2],bottom=top+box[3];
    int screenLeft=GetSystemMetrics(76),screenTop=GetSystemMetrics(77);
    if(left<screenLeft||top<screenTop||right>screenLeft+GetSystemMetrics(78)||bottom>screenTop+GetSystemMetrics(79))
      throw new InvalidOperationException("A frozen ROI is outside the current desktop.");
    for(IntPtr other=GetWindow(window,3);other!=IntPtr.Zero;other=GetWindow(other,3)) {
      if(!IsWindowVisible(other)||IsIconic(other))continue;
      uint cloaked;
      if(DwmGetWindowAttribute(other,14,out cloaked,4)==0&&cloaked!=0)continue;
      RECT bounds;
      if(!GetWindowRect(other,out bounds))throw new InvalidOperationException("An above-window obstruction could not be checked.");
      if(bounds.l<right&&bounds.r>left&&bounds.t<bottom&&bounds.b>top)
        throw new InvalidOperationException("Another visible window overlaps a frozen ROI. No reference or match was accepted.");
    }
    foreach(POINT point in new[]{new POINT(left,top),new POINT(right-1,top),new POINT(left,bottom-1),new POINT(right-1,bottom-1),new POINT(left+box[2]/2,top+box[3]/2)})
      if(GetAncestor(WindowFromPoint(point),2)!=window)
        throw new InvalidOperationException("A frozen ROI is not hit-testable in the exact owned window.");
  }
  Bitmap Capture(int[] box) {
    Unobscured(box);Paint();
    var bitmap=new Bitmap(box[2],box[3],PixelFormat.Format32bppArgb);
    try {
      using(var graphics=Graphics.FromImage(bitmap))
        graphics.CopyFromScreen(rectangle.l+box[0],rectangle.t+box[1],0,0,new Size(box[2],box[3]));
      Unobscured(box);
      return bitmap;
    } catch {bitmap.Dispose();throw;}
  }
  static byte[] Pixels(Bitmap bitmap) {
    var area=new Rectangle(0,0,bitmap.Width,bitmap.Height);
    var data=bitmap.LockBits(area,ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
    try {
      var bytes=new byte[bitmap.Width*bitmap.Height*4];
      for(int row=0;row<bitmap.Height;row++)
        Marshal.Copy(IntPtr.Add(data.Scan0,row*data.Stride),bytes,row*bitmap.Width*4,bitmap.Width*4);
      for(int index=3;index<bytes.Length;index+=4)bytes[index]=255;
      return bytes;
    } finally {bitmap.UnlockBits(data);}
  }
  public static int DifferingPixelBytes(byte[] left,byte[] right) {
    if(left==null||right==null||left.Length!=right.Length||left.Length%4!=0)
      throw new ArgumentException("Pixel buffers require equal BGRA dimensions.");
    int differences=0;
    for(int index=0;index<left.Length;index++)
      if(index%4!=3&&left[index]!=right[index])differences++;
    return differences;
  }
  public object Save(string path,int[] box){path=FilePath(path);using(var bitmap=Capture(box))using(var output=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)){bitmap.Save(output,ImageFormat.Png);return new{saved=true,box=box,pixelSha256=Convert.ToHexString(SHA256.HashData(Pixels(bitmap))).ToLowerInvariant()};}}
  public object Match(string path,int[] box,string expectedHash) {
    path=FilePath(path);Box(box);
    using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
      if(Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()!=expectedHash)
        throw new InvalidOperationException("Frozen reference bytes changed.");
      stream.Position=0;
      using(var expected=new Bitmap(stream))using(var actual=Capture(box)) {
        if(expected.Width!=actual.Width||expected.Height!=actual.Height)
          throw new InvalidOperationException("Reference dimensions changed.");
        byte[] left=Pixels(expected),right=Pixels(actual);
        int differences=DifferingPixelBytes(left,right);
        return new{matched=differences==0,differingBytes=differences,pixelSha256=Convert.ToHexString(SHA256.HashData(right)).ToLowerInvariant(),lastInputTick=inputTick};
      }
    }
  }
  public object Sheet(string path,string[] names,string[] paths) {
    Guard();path=FilePath(path);
    if(names==null||paths==null||names.Length!=paths.Length||names.Length<1||names.Length>24)
      throw new ArgumentException("A visual review sheet requires one to twenty-four named source crops.");
    const int width=560,height=112;
    using(var sheet=new Bitmap(width*2,((names.Length+1)/2)*height))
    using(var graphics=Graphics.FromImage(sheet))
    using(var font=new Font("Segoe UI",11)) {
      graphics.Clear(Color.FromArgb(32,32,32));
      for(int index=0;index<paths.Length;index++) {
        int x=index%2*width,y=index/2*height;
        graphics.DrawString(names[index],font,Brushes.White,x+8,y+5);
        using(var image=new Bitmap(FilePath(paths[index]))) {
          double scale=Math.Min(1,Math.Min((width-16.0)/image.Width,(height-32.0)/image.Height));
          graphics.DrawImage(image,new Rectangle(x+8,y+30,(int)(image.Width*scale),(int)(image.Height*scale)));
        }
      }
      using(var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None))sheet.Save(stream,ImageFormat.Png);
      return new{saved=true,reviewOnly=true,path=path};
    }
  }
  public void Dispose(){process.Dispose();}
}
'@
if ($CompileOnly) {
  if ([NativeVisualInput]::DifferingPixelBytes([byte[]]@(1,2,3,0),[byte[]]@(1,2,3,255)) -ne 0) {
    throw 'Alpha normalization changed an identical RGB pixel.'
  }
  if ([NativeVisualInput]::DifferingPixelBytes([byte[]]@(1,2,3,255),[byte[]]@(1,2,4,255)) -ne 1) {
    throw 'The exact pixel comparator missed a one-byte RGB change.'
  }
  $rejected=$false
  try { [void][NativeVisualInput]::DifferingPixelBytes([byte[]]@(1,2,3),[byte[]]@(1,2,3)) }
  catch { $rejected=$true }
  if (-not $rejected) { throw 'The comparator accepted an incomplete pixel buffer.' }
  @{compiled=$true;pixelComparatorCases=3;windowOperationsPerformed=$false;temporary=[IO.Path]::GetTempPath()}|ConvertTo-Json -Compress
  exit 0
}
$session=$null
try {
  $value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec))|ConvertFrom-Json
  $session=[NativeVisualInput]::new([int]$value.pid,[string]$value.creationFileTime,[string]$value.executable,[string]$value.root,[int[]]$value.frame)
  @{event='ready';identity=$session.Identity()}|ConvertTo-Json -Depth 6 -Compress
  while($line=[Console]::ReadLine()) {
    $request=$null
    try {
      $request=$line|ConvertFrom-Json
      $result=switch($request.op) {
        'prepareForeground' {$session.PrepareForeground()}
        'identity' {$session.Observe()}
        'click' {$session.Click([int]$request.x,[int]$request.y)}
        'scrollLibrary' {
          if($request.up -isnot [bool]) {throw 'A frozen library scroll direction is required'}
          $session.ScrollLibrary([int]$request.x,[int]$request.y,[bool]$request.up)
        }
        'text' {$session.Text([string]$request.value)}
        'save' {$session.Save([string]$request.path,[int[]]$request.box)}
        'match' {$session.Match([string]$request.path,[int[]]$request.box,[string]$request.sha256)}
        'sheet' {$session.Sheet([string]$request.path,[string[]]$request.names,[string[]]$request.paths)}
        'finish' {$session.Identity();break}
        default {throw 'Unsupported visual operation'}
      }
      @{id=$request.id;ok=$true;value=$result}|ConvertTo-Json -Depth 8 -Compress
      if($request.op -eq 'finish'){break}
    } catch {
      @{id=$request.id;ok=$false;error=$_.Exception.GetBaseException().Message}|ConvertTo-Json -Compress
      break
    }
  }
} finally {if($session){$session.Dispose()}}
