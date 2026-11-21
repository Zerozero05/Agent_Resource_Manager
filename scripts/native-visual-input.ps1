param([string]$Spec, [switch]$CompileOnly, [switch]$AccessibilitySearchPilot)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$refs = @((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName) + @('System.Drawing.Common.dll','System.Private.Windows.GdiPlus.dll','System.Private.Windows.Core.dll' | ForEach-Object { Join-Path $PSHOME $_ })
$compile = @{}
if ($AccessibilitySearchPilot) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $refs += @('UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll' | ForEach-Object { Join-Path $PSHOME $_ })
  $compile.CompilerOptions = '/define:AX_SEARCH_PILOT'
}
Add-Type @compile -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
#if AX_SEARCH_PILOT
using System.Windows.Automation;
#endif
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
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr handle,out RECT value);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr handle,ref POINT point);
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
  [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetFrameBounds(IntPtr handle,uint attribute,out RECT value,uint size);
  readonly Process process; readonly string created,image,root; readonly IntPtr window; readonly RECT rectangle,captureRectangle; readonly uint dpi;
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
    Paint();
    captureRectangle=CaptureRectangle();
    if(ReadInputTick()!=inputTick)throw new InvalidOperationException("Input changed during owned window preparation.");
  }
  RECT CaptureRectangle() {
    // GetWindowRect includes hit-testable invisible resize borders. Capture only visible client pixels.
    const uint extendedFrameBounds=9;
    if(!GetClientRect(window,out RECT client)||
       DwmGetFrameBounds(window,extendedFrameBounds,out RECT visible,(uint)Marshal.SizeOf(typeof(RECT)))!=0)
      throw new InvalidOperationException("Visible owned client geometry is unavailable.");
    var first=new POINT(client.l,client.t);
    var last=new POINT(client.r,client.b);
    if(!ClientToScreen(window,ref first)||!ClientToScreen(window,ref last))
      throw new InvalidOperationException("Owned client geometry could not be mapped to screen pixels.");
    var result=new RECT {
      l=Math.Max(rectangle.l,Math.Max(visible.l,first.x)), t=Math.Max(rectangle.t,Math.Max(visible.t,first.y)),
      r=Math.Min(rectangle.r,Math.Min(visible.r,last.x)), b=Math.Min(rectangle.b,Math.Min(visible.b,last.y))
    };
    if(result.r-result.l<2||result.b-result.t<2)
      throw new InvalidOperationException("The exact owned window has no visible capture area.");
    return result;
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
  public object Identity(){CheckProcess();return new{pid=process.Id,creationFileTime=created,windowHandle=window.ToInt64(),left=rectangle.l,top=rectangle.t,width=rectangle.r-rectangle.l,height=rectangle.b-rectangle.t,dpi=dpi,captureBounds=new[]{captureRectangle.l-rectangle.l,captureRectangle.t-rectangle.t,captureRectangle.r-captureRectangle.l,captureRectangle.b-captureRectangle.t},lastInputTick=inputTick,foreground=GetAncestor(GetForegroundWindow(),2)==window};}
  public object Observe(){Guard();return Identity();}
  void Paint(){if(DwmFlush()!=0||DwmFlush()!=0)throw new InvalidOperationException("Desktop composition failed.");}
  (long start, long end) Send(INPUT[] values, bool waitForPaint=true) {
    Guard();
    foreach(int key in new[]{16,17,18,91,92})
      if((GetAsyncKeyState(key)&0x8000)!=0)
        throw new InvalidOperationException("A modifier key is already pressed. No input was sent.");
    int inputSize=Marshal.SizeOf(typeof(INPUT));
    long start=waitForPaint?0:Stopwatch.GetTimestamp();
    uint sent=SendInput((uint)values.Length,values,inputSize);
    long end=waitForPaint?0:Stopwatch.GetTimestamp();
    if(sent!=(uint)values.Length)throw new InvalidOperationException("Native input did not complete.");
    inputTick=ReadInputTick();
    if(waitForPaint)Paint();
    Guard();
    return(start,end);
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
    SendWheel(x,y,up?1200:-1200);
    return new{scrolledUp=up,x=x,y=y,lastInputTick=inputTick};
  }
  void SendWheel(int x,int y,int delta) {
    Send(new[]{
      new INPUT{type=0,value=new UNION{mouse=PointMovement(x,y)}},
      new INPUT{type=0,value=new UNION{mouse=new MOUSE{flags=0x0800u,data=unchecked((uint)delta)}}}
    });
  }
  public object ScrollDocument(int x,int y) {
    const int delta=-120;
    SendWheel(x,y,delta);
    return new{wheelDelta=delta,x=x,y=y,lastInputTick=inputTick};
  }
  static void ValidateSearch(string value) {
    if(value==null||value.Length!=15||!value.StartsWith("perf-skill-",StringComparison.Ordinal)||
       !Int32.TryParse(value.Substring(11),out int index)||index<0||index>65||value!="perf-skill-"+index.ToString("0000"))
      throw new InvalidOperationException("Only the frozen synthetic search values are allowed.");
  }
  void GuardSearchFocus() {
    var info=new GUI{size=(uint)Marshal.SizeOf(typeof(GUI))};
    if(!GetGUIThreadInfo(0,ref info)||info.focus==IntPtr.Zero||GetAncestor(info.focus,2)!=window)
      throw new InvalidOperationException("Actual keyboard focus is outside the owned window.");
  }
  static INPUT[] SearchKeys(string value) {
    var keys=new System.Collections.Generic.List<INPUT>{Key(17),Key(65),Key(65,true),Key(17,true)};
    foreach(char character in value) {
      keys.Add(new INPUT{type=1,value=new UNION{key=new KEY{scan=character,flags=4}}});
      keys.Add(new INPUT{type=1,value=new UNION{key=new KEY{scan=character,flags=6}}});
    }
    return keys.ToArray();
  }
  public object Text(string value) {
    Guard();
    ValidateSearch(value);
    GuardSearchFocus();
    Send(SearchKeys(value));
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
    RECT visible=CaptureRectangle();
    if(visible.l!=captureRectangle.l||visible.t!=captureRectangle.t||visible.r!=captureRectangle.r||visible.b!=captureRectangle.b||
       left<visible.l||top<visible.t||right>visible.r||bottom>visible.b)
      throw new InvalidOperationException("A frozen ROI is outside the unchanged visible client area.");
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
  static byte[] Pixels(Bitmap bitmap,byte[] bytes=null) {
    var area=new Rectangle(0,0,bitmap.Width,bitmap.Height);
    var data=bitmap.LockBits(area,ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
    try {
      bool normalizeAlpha=bytes==null;
      bytes=bytes??new byte[bitmap.Width*bitmap.Height*4];
      for(int row=0;row<bitmap.Height;row++)
        Marshal.Copy(IntPtr.Add(data.Scan0,row*data.Stride),bytes,row*bitmap.Width*4,bitmap.Width*4);
      if(normalizeAlpha)
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
  public sealed class SearchRoi {
    internal readonly string role,path,sha256;
    internal readonly int[] box;
    public SearchRoi(string role,string path,int[] box,string sha256) {
      this.role=role;this.path=path;this.box=box;this.sha256=sha256;
    }
  }
  sealed class SearchAnchor {
    internal readonly int[] box;
    internal readonly byte[] pixels;
    internal SearchAnchor(int[] box,byte[] pixels) {this.box=box;this.pixels=pixels;}
  }
  static readonly int[][] SearchContentCrops={new[]{20,0,181,31},new[]{103,0,528,99},new[]{0,0,440,56}};
  static SearchAnchor[] SearchContent(SearchAnchor[] parents) {
    var content=new SearchAnchor[parents.Length];
    for(int index=0;index<parents.Length;index++) {
      SearchAnchor parent=parents[index];
      int[] crop=SearchContentCrops[index];
      int[] box=parent.box;
      if(box[2]!=crop[0]+crop[2]||box[3]!=crop[1]+crop[3])
        throw new InvalidOperationException("A fixed content crop does not match its approved parent dimensions.");
      if(crop[0]==0&&crop[1]==0) {
        content[index]=parent;
        continue;
      }
      int stride=crop[2]*4;
      var pixels=new byte[stride*crop[3]];
      for(int row=0;row<crop[3];row++)
        Buffer.BlockCopy(parent.pixels,((crop[1]+row)*box[2]+crop[0])*4,pixels,row*stride,stride);
      content[index]=new SearchAnchor(new[]{box[0]+crop[0],box[1]+crop[1],crop[2],crop[3]},pixels);
    }
    return content;
  }
  static void RequireSameSearchParentGeometry(SearchAnchor[] previous,SearchAnchor[] target) {
    for(int index=0;index<previous.Length;index++)
      if(!previous[index].box.AsSpan().SequenceEqual(target[index].box))
        throw new InvalidOperationException("Both search states must have identical approved parent boxes.");
  }
  static void RequireDistinctSearchTitles(SearchAnchor[] previous,SearchAnchor[] target) {
    if(DifferingPixelBytes(previous[0].pixels,target[0].pixels)==0)
      throw new InvalidOperationException("The two neutral result titles must differ within the fixed content crop.");
  }
  sealed class SearchFrame {
    internal readonly long start,end;
    internal SearchFrame(long start,long end) {this.start=start;this.end=end;}
    internal object Receipt(){return new{startQpc=start.ToString(),endQpc=end.ToString()};}
  }
  SearchAnchor[] ReadSearchAnchors(SearchRoi[] rois) {
    string[] roles={"result-title","result-table","result-count"};
    if(rois==null||rois.Length!=roles.Length)
      throw new InvalidOperationException("Exactly three frozen search ROIs are required.");
    var anchors=new SearchAnchor[roles.Length];
    for(int index=0;index<roles.Length;index++) {
      SearchRoi roi=rois[index];
      if(roi==null||roi.role!=roles[index])throw new InvalidOperationException("Frozen search ROI roles or order changed.");
      Box(roi.box);
      if((long)roi.box[0]+roi.box[2]>rectangle.r-rectangle.l||
         (long)roi.box[1]+roi.box[3]>rectangle.b-rectangle.t)
        throw new InvalidOperationException("Frozen search ROI is outside the owned frame.");
      using(var stream=new FileStream(FilePath(roi.path),FileMode.Open,FileAccess.Read,FileShare.Read)) {
        if(Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()!=roi.sha256)
          throw new InvalidOperationException("Frozen search reference bytes changed.");
        stream.Position=0;
        using(var image=new Bitmap(stream)) {
          if(image.Width!=roi.box[2]||image.Height!=roi.box[3])
            throw new InvalidOperationException("Frozen search reference dimensions changed.");
          anchors[index]=new SearchAnchor(roi.box,Pixels(image));
        }
      }
    }
    return anchors;
  }
  static int[] SearchBounds(SearchAnchor[] previous,SearchAnchor[] target) {
    int left=int.MaxValue,top=int.MaxValue,right=0,bottom=0;
    foreach(SearchAnchor[] group in new[]{previous,target})
      foreach(SearchAnchor anchor in group) {
        int[] box=anchor.box;
        left=Math.Min(left,box[0]);top=Math.Min(top,box[1]);
        right=Math.Max(right,box[0]+box[2]);bottom=Math.Max(bottom,box[1]+box[3]);
      }
    return new[]{left,top,right-left,bottom-top};
  }
  // Compare visible RGB without the desktop bitmap's unused alpha channel.
  static bool SearchAnchorMatches(byte[] frame,int[] bounds,SearchAnchor anchor) {
    int[] box=anchor.box;
    int stride=box[2]*4;
    for(int row=0;row<box[3];row++) {
      int offset=((box[1]-bounds[1]+row)*bounds[2]+box[0]-bounds[0])*4;
      for(int channel=0;channel<stride;channel++)
        if(channel%4!=3&&frame[offset+channel]!=anchor.pixels[row*stride+channel])return false;
    }
    return true;
  }
  static bool SearchMatches(byte[] frame,int[] bounds,SearchAnchor[] anchors) {
    foreach(SearchAnchor anchor in anchors)
      if(!SearchAnchorMatches(frame,bounds,anchor))return false;
    return true;
  }
  static string SearchMismatch(byte[] frame,int[] bounds,SearchAnchor[] previous,SearchAnchor[] target) {
    string Describe(SearchAnchor[] anchors) {
      return "title="+SearchAnchorMatches(frame,bounds,anchors[0])+
        ", table="+SearchAnchorMatches(frame,bounds,anchors[1])+
        ", count="+SearchAnchorMatches(frame,bounds,anchors[2]);
    }
    return " Last owned frame, previous ("+Describe(previous)+"), target ("+Describe(target)+").";
  }
  SearchFrame CaptureSearchFrame(int[] bounds,Bitmap bitmap,Graphics graphics,byte[] pixels) {
    Unobscured(bounds);
    // Observe after a compositor boundary without the normal action's double flush.
    if(DwmFlush()!=0)throw new InvalidOperationException("Desktop composition failed.");
    Unobscured(bounds);
    long start=Stopwatch.GetTimestamp();
    graphics.CopyFromScreen(rectangle.l+bounds[0],rectangle.t+bounds[1],0,0,bitmap.Size);
    long end=Stopwatch.GetTimestamp();
    Unobscured(bounds);
    Pixels(bitmap,pixels);
    return new SearchFrame(start,end);
  }
  static void WriteSearchMismatchPng(Bitmap bitmap,byte[] pixels,Stream output) {
    // Make the copied desktop RGB visible in PNG viewers regardless of GDI alpha.
    for(int index=3;index<pixels.Length;index+=4)pixels[index]=255;
    var area=new Rectangle(0,0,bitmap.Width,bitmap.Height);
    var data=bitmap.LockBits(area,ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
    try {
      int stride=bitmap.Width*4;
      for(int row=0;row<bitmap.Height;row++)
        Marshal.Copy(pixels,row*stride,IntPtr.Add(data.Scan0,row*data.Stride),stride);
    } finally {bitmap.UnlockBits(data);}
    bitmap.Save(output,ImageFormat.Png);
  }
  string PreserveSearchMismatch(int[] bounds,Bitmap bitmap,byte[] pixels) {
    Unobscured(bounds);
    const string filename="search-paint-mismatch.png";
    string path=FilePath(Path.Combine(root,filename));
    try {
      using(var output=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None))
        WriteSearchMismatchPng(bitmap,pixels,output);
      return " Saved "+filename+" at bounds=["+string.Join(",",bounds)+"].";
    } catch(IOException) {
      return " A new mismatch PNG could not be written.";
    }
  }
#if AX_SEARCH_PILOT
  static AutomationElement SearchPilotFind(AutomationElement owner,string name,ControlType type,bool visible=true) {
    var conditions=new System.Collections.Generic.List<Condition>{new PropertyCondition(AutomationElement.NameProperty,name)};
    if(type!=null)conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty,type));
    if(visible)conditions.Add(new PropertyCondition(AutomationElement.IsOffscreenProperty,false));
    try {
      return owner.FindFirst(TreeScope.Descendants,conditions.Count==1?conditions[0]:new AndCondition(conditions.ToArray()));
    } catch(ElementNotAvailableException) {return null;}
  }
  AutomationElement SearchPilotRoot() {
    Guard();
    return AutomationElement.FromHandle(window);
  }
  ValuePattern SearchPilotPattern() {
    AutomationElement edit=SearchPilotFind(SearchPilotRoot(),"搜索 Skill",ControlType.Edit);
    if(edit==null||!edit.TryGetCurrentPattern(ValuePattern.Pattern,out object pattern))return null;
    return (ValuePattern)pattern;
  }
  bool SearchPilotMatches(string value) {
    ValuePattern search=SearchPilotPattern();
    if(search==null||search.Current.Value!=value)return false;
    AutomationElement table=SearchPilotFind(SearchPilotRoot(),"可横向滚动的 Skill 列表",null,false);
    if(table==null)return false;
    int rowCount=0;
    var cache=new CacheRequest();
    cache.Add(AutomationElement.NameProperty);
    using(cache.Activate()) {
      var buttons=table.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button));
      foreach(AutomationElement row in buttons)
        if(row.Cached.Name.StartsWith("Perf Skill ",StringComparison.Ordinal))rowCount++;
    }
    return rowCount==1&&SearchPilotFind(SearchPilotRoot(),"Perf Skill "+value.Substring(11),ControlType.Button,false)!=null;
  }
  (long start,long invocation,long end) DispatchAccessibilitySearch(string value) {
    Guard();
    long start=Stopwatch.GetTimestamp();
    AutomationElement edit=SearchPilotFind(SearchPilotRoot(),"搜索 Skill",ControlType.Edit);
    if(edit==null||!edit.Current.IsEnabled||!edit.TryGetCurrentPattern(ValuePattern.Pattern,out object pattern)||((ValuePattern)pattern).Current.IsReadOnly)
      throw new InvalidOperationException("The owned search input is not editable.");
    Guard();
    long invocation=Stopwatch.GetTimestamp();
    ((ValuePattern)pattern).SetValue(value);
    long end=Stopwatch.GetTimestamp();
    Guard();
    return(start,invocation,end);
  }
  object ObserveAccessibilitySearch(string value,SearchFrame initial,(long start,long invocation,long end) dispatch) {
    long deadline=dispatch.start+Stopwatch.Frequency*4;
    while(Stopwatch.GetTimestamp()<deadline) {
      Guard();
      if(SearchPilotMatches(value)) {
        long ready=Stopwatch.GetTimestamp();
        Paint();
        long confirmationStart=Stopwatch.GetTimestamp();
        if(SearchPilotMatches(value)) {
          long confirmationEnd=Stopwatch.GetTimestamp();
          if(confirmationEnd>deadline)break;
          Guard();
          return new{typed=value,observer="uia",inputMethod="ValuePattern.SetValue",qpcFrequency=Stopwatch.Frequency.ToString(),
            inputStartedQpc=dispatch.start.ToString(),setValueStartedQpc=dispatch.invocation.ToString(),inputReturnedQpc=dispatch.end.ToString(),
            initial=initial.Receipt(),uiaFirstReadyQpc=ready.ToString(),confirmation=new SearchFrame(confirmationStart,confirmationEnd).Receipt(),
            durationMs=(confirmationEnd-dispatch.start)*1000.0/Stopwatch.Frequency,foreground=true,lastInputTick=inputTick};
        }
      }
      System.Threading.Thread.Sleep(1);
    }
    throw new TimeoutException("The formal UIA search predicate and its DWM confirmation did not complete within the pilot bound.");
  }
#endif
  public object SearchPaint(string value,SearchRoi[] previousRois,SearchRoi[] targetRois,string observer=null) {
    Guard();
    ValidateSearch(value);
    if(dpi!=96)throw new InvalidOperationException("The exact search content crops require 96 DPI.");
    SearchAnchor[] previousParents=ReadSearchAnchors(previousRois),targetParents=ReadSearchAnchors(targetRois);
    RequireSameSearchParentGeometry(previousParents,targetParents);
    SearchAnchor[] previous=SearchContent(previousParents),target=SearchContent(targetParents);
    RequireDistinctSearchTitles(previous,target);
    int[] bounds=SearchBounds(previousParents,targetParents);
    Unobscured(bounds);
    INPUT[] input=observer==null?SearchKeys(value):null;
#if AX_SEARCH_PILOT
    if(observer!=null) {
      if(observer!="pixels"&&observer!="uia")throw new InvalidOperationException("The search pilot requires one native observer.");
      AutomationElement owner=SearchPilotRoot();
      if(owner==null||owner.Current.ProcessId!=process.Id)throw new InvalidOperationException("The search input root is not the owned native window.");
    }
#else
    if(observer!=null)throw new InvalidOperationException("The native accessibility search pilot was not enabled.");
#endif
    var pixels=new byte[bounds[2]*bounds[3]*4];
    using(var bitmap=new Bitmap(bounds[2],bounds[3],PixelFormat.Format32bppArgb))
    using(var graphics=Graphics.FromImage(bitmap)) {
      SearchFrame initial=CaptureSearchFrame(bounds,bitmap,graphics,pixels);
      if(!SearchMatches(pixels,bounds,previous)||SearchMatches(pixels,bounds,target))
        throw new InvalidOperationException("The previous search must be visible and the target absent before any input."+
          SearchMismatch(pixels,bounds,previous,target)+" Full parent comparison:"+
          SearchMismatch(pixels,bounds,previousParents,targetParents)+PreserveSearchMismatch(bounds,bitmap,pixels));
      (long start,long end) dispatch;
      long? invocation=null;
#if AX_SEARCH_PILOT
      if(observer!=null) {
        var ax=DispatchAccessibilitySearch(value);
        if(observer=="uia")return ObserveAccessibilitySearch(value,initial,ax);
        dispatch=(ax.start,ax.end);
        invocation=ax.invocation;
      } else
#endif
      {
        GuardSearchFocus();
        dispatch=Send(input,false);
      }
      const int timeoutMs=4000;
      const int maxObservations=160;
      long deadline=dispatch.start+Stopwatch.Frequency*timeoutMs/1000;
      SearchFrame lastMiss=null,firstHit=null;
      for(int count=1;count<=maxObservations&&Stopwatch.GetTimestamp()<deadline;count++) {
        SearchFrame frame=CaptureSearchFrame(bounds,bitmap,graphics,pixels);
        if(frame.end>deadline)break;
        bool matches=SearchMatches(pixels,bounds,target);
        if(firstHit!=null) {
          if(!matches)throw new InvalidOperationException("The first visible search result failed the independent confirmation."+
            SearchMismatch(pixels,bounds,previous,target)+" Full parent comparison:"+
            SearchMismatch(pixels,bounds,previousParents,targetParents)+PreserveSearchMismatch(bounds,bitmap,pixels));
          Guard();
          long lower=lastMiss==null?dispatch.start:Math.Max(dispatch.start,lastMiss.start);
          int[][] contentBoxes={target[0].box,target[1].box,target[2].box};
          if(observer!=null)return new{typed=value,observer,inputMethod="ValuePattern.SetValue",qpcFrequency=Stopwatch.Frequency.ToString(),
            inputStartedQpc=dispatch.start.ToString(),setValueStartedQpc=invocation.Value.ToString(),inputReturnedQpc=dispatch.end.ToString(),
            initial=initial.Receipt(),lastMiss=lastMiss?.Receipt(),firstHit=firstHit.Receipt(),confirmation=frame.Receipt(),observations=count,
            contentBoxes,fullParentTargetMatched=SearchMatches(pixels,bounds,targetParents),
            lowerBoundMs=(lower-dispatch.start)*1000.0/Stopwatch.Frequency,
            upperBoundMs=(firstHit.end-dispatch.start)*1000.0/Stopwatch.Frequency,foreground=true,lastInputTick=inputTick};
          return new{typed=value,qpcFrequency=Stopwatch.Frequency.ToString(),inputStartedQpc=dispatch.start.ToString(),
            inputReturnedQpc=dispatch.end.ToString(),initial=initial.Receipt(),lastMiss=lastMiss?.Receipt(),
            firstHit=firstHit.Receipt(),confirmation=frame.Receipt(),observations=count,
            contentBoxes=contentBoxes,fullParentTargetMatched=SearchMatches(pixels,bounds,targetParents),
            lowerBoundMs=(lower-dispatch.start)*1000.0/Stopwatch.Frequency,
            upperBoundMs=(firstHit.end-dispatch.start)*1000.0/Stopwatch.Frequency,foreground=true,lastInputTick=inputTick};
        }
        if(matches)firstHit=frame;
        else lastMiss=frame;
      }
      throw new TimeoutException("The frozen search result and its independent confirmation were not observed within the native bound."+
        SearchMismatch(pixels,bounds,previous,target)+" Full parent comparison:"+
        SearchMismatch(pixels,bounds,previousParents,targetParents)+PreserveSearchMismatch(bounds,bitmap,pixels));
    }
  }
  public static int CheckSearchPaintComparator() {
    var bounds=new[]{4,8,4,3};
    var pixels=new byte[4*3*4];
    var target=new[]{new SearchAnchor(new[]{4,8,2,1},new byte[8]),
      new SearchAnchor(new[]{6,9,2,1},new byte[8]),new SearchAnchor(new[]{5,10,2,1},new byte[8])};
    if(!SearchMatches(pixels,bounds,target))throw new InvalidOperationException("Identical composed RGB must match.");
    pixels[3]=255;
    if(!SearchMatches(pixels,bounds,target))throw new InvalidOperationException("Alpha does not describe visible RGB.");
    foreach(int rgb in new[]{0,24,36}) {
      pixels[rgb]=1;
      if(SearchMatches(pixels,bounds,target))throw new InvalidOperationException("Every ROI must match in the same rectangle.");
      pixels[rgb]=0;
    }
    pixels[8]=1;
    if(!SearchMatches(pixels,bounds,target))throw new InvalidOperationException("Pixels outside the frozen ROIs must be ignored.");
    int[] union=SearchBounds(new[]{new SearchAnchor(new[]{1,9,2,2},new byte[16])},target);
    if(union[0]!=1||union[1]!=8||union[2]!=7||union[3]!=3)
      throw new InvalidOperationException("The copied rectangle must cover both sets of exact search ROIs.");
    using(var bitmap=new Bitmap(4,3,PixelFormat.Format32bppArgb))
    using(var graphics=Graphics.FromImage(bitmap)) {
      graphics.Clear(Color.Black);
      byte[] reused=Pixels(bitmap,pixels);
      if(!Object.ReferenceEquals(reused,pixels)||!SearchMatches(reused,bounds,target))
        throw new InvalidOperationException("Sampled bitmap decoding must reuse the buffer and preserve visible RGB.");
      reused[0]=17;reused[1]=34;reused[2]=51;reused[3]=0;
      using(var png=new MemoryStream()) {
        WriteSearchMismatchPng(bitmap,reused,png);
        png.Position=0;
        using(var decoded=new Bitmap(png))
          if(decoded.Size!=bitmap.Size||decoded.GetPixel(0,0)!=Color.FromArgb(255,51,34,17))
            throw new InvalidOperationException("The mismatch PNG must preserve the owned frame size and visible RGB.");
      }
    }
    var parents=new[]{new SearchAnchor(new[]{373,611,201,31},new byte[201*31*4]),
      new SearchAnchor(new[]{290,543,631,99},new byte[631*99*4]),
      new SearchAnchor(new[]{290,473,440,56},new byte[440*56*4])};
    var neutral=new[]{new SearchAnchor((int[])parents[0].box.Clone(),new byte[201*31*4]),
      parents[1],parents[2]};
    RequireSameSearchParentGeometry(parents,neutral);
    neutral[0].pixels[15*4]=1;
    SearchAnchor[] left=SearchContent(parents),right=SearchContent(neutral);
    if(!left[0].box.AsSpan().SequenceEqual(new[]{393,611,181,31})||
       !left[1].box.AsSpan().SequenceEqual(new[]{393,543,528,99})||left[2]!=parents[2]||
       DifferingPixelBytes(left[0].pixels,right[0].pixels)!=0)
      throw new InvalidOperationException("Only the two fixed left strips may be excluded.");
    var rejected=false;
    try {RequireDistinctSearchTitles(left,right);}
    catch(InvalidOperationException) {rejected=true;}
    if(!rejected)throw new InvalidOperationException("Icon-only variants are not distinct result titles.");
    neutral[0].pixels[(201+20)*4]=1;
    right=SearchContent(neutral);
    RequireDistinctSearchTitles(left,right);
    if(right[0].pixels[181*4]!=1||DifferingPixelBytes(left[0].pixels,right[0].pixels)!=1)
      throw new InvalidOperationException("Content differences must survive the exact row-stride copy.");
    neutral[0].box[1]++;
    rejected=false;
    try {RequireSameSearchParentGeometry(parents,neutral);}
    catch(InvalidOperationException) {rejected=true;}
    if(!rejected)throw new InvalidOperationException("A shifted parent box must be rejected.");
    neutral[0].box[2]--;
    rejected=false;
    try {SearchContent(neutral);}
    catch(InvalidOperationException) {rejected=true;}
    if(!rejected)throw new InvalidOperationException("A crop cannot leave its parent image.");
    return 14;
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
  $searchPaintComparatorCases=[NativeVisualInput]::CheckSearchPaintComparator()
  @{compiled=$true;pixelComparatorCases=3;searchPaintComparatorCases=$searchPaintComparatorCases;windowOperationsPerformed=$false;temporary=[IO.Path]::GetTempPath()}|ConvertTo-Json -Compress
  exit 0
}
function Read-SearchRois($Rois) {
  if($Rois -isnot [array] -or $Rois.Count -ne 3) {throw 'Exactly three frozen search ROIs are required'}
  foreach($roi in $Rois) {
    if($roi.role -isnot [string] -or $roi.path -isnot [string] -or
       $roi.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $roi.box -isnot [array] -or $roi.box.Count -ne 4 -or
       @($roi.box | Where-Object { $_ -isnot [long] -or $_ -lt 0 -or $_ -gt [int]::MaxValue }).Count -ne 0) {
      throw 'Each search ROI requires a role, fixture PNG path, exact integer box and SHA-256'
    }
    [NativeVisualInput+SearchRoi]::new($roi.role,$roi.path,[int[]]$roi.box,[string]$roi.sha256)
  }
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
        'scrollDocument' {$session.ScrollDocument([int]$request.x,[int]$request.y)}
        'text' {$session.Text([string]$request.value)}
        'searchPaint' {
          if($request.value -isnot [string]) {throw 'A frozen search value is required'}
          $previousRois=[NativeVisualInput+SearchRoi[]]@(Read-SearchRois $request.previousRois)
          $targetRois=[NativeVisualInput+SearchRoi[]]@(Read-SearchRois $request.targetRois)
          $session.SearchPaint($request.value,$previousRois,$targetRois)
        }
        'searchObserver' {
          if(!$AccessibilitySearchPilot -or $request.value -isnot [string] -or $request.observer -cnotin @('pixels','uia')) {
            throw 'An enabled native accessibility search pilot and one exact observer are required'
          }
          $previousRois=[NativeVisualInput+SearchRoi[]]@(Read-SearchRois $request.previousRois)
          $targetRois=[NativeVisualInput+SearchRoi[]]@(Read-SearchRois $request.targetRois)
          $session.SearchPaint($request.value,$previousRois,$targetRois,$request.observer)
        }
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
