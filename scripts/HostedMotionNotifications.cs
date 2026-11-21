using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class HostedMotionNotifications : IDisposable {
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate IntPtr WindowProcedure(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClass {
        public uint style;
        public IntPtr procedure;
        public int classExtra, windowExtra;
        public IntPtr instance, icon, cursor, background;
        public string menuName, className;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
        public IntPtr window;
        public uint message;
        public IntPtr wParam, lParam;
        public uint time;
        public int x, y;
        public uint privateData;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string module);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClass(ref WindowClass windowClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool UnregisterClass(string name, IntPtr module);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowEx(
        uint extended, string className, string title, uint style, int x, int y, int width, int height,
        IntPtr parent, IntPtr menu, IntPtr module, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int result);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)]
    private static extern bool GetSetting(uint action, uint arg, out int value, uint flags);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)]
    private static extern bool SetSetting(uint action, uint arg, IntPtr value, uint flags);

    public sealed class Notice {
        public long Qpc { get; }
        public long Action { get; }
        public Notice(long time, long action) { Qpc = time; Action = action; }
    }

    private const uint SettingsChange = 0x001a, Close = 0x0010, Destroy = 0x0002;
    private readonly ConcurrentQueue<Notice> notices = new ConcurrentQueue<Notice>();
    private readonly ManualResetEventSlim ready = new ManualResetEventSlim();
    private readonly WindowProcedure callback;
    private readonly Thread thread;
    private IntPtr hwnd;
    private Exception error;

    private static void RequireHosted() {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" ||
            Environment.GetEnvironmentVariable("ImageOS") != "win25-vs2026" ||
            Environment.GetEnvironmentVariable("ImageVersion") != "20261116.315.1" ||
            !Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0)
            throw new InvalidOperationException("Require the approved interactive GitHub-hosted Windows image.");
    }

    public HostedMotionNotifications() {
        RequireHosted();
        callback = HandleMessage;
        thread = new Thread(Pump) { IsBackground = true };
        thread.Start();
        if (!ready.Wait(2000)) throw new TimeoutException("The notification window did not initialize.");
        if (error != null) throw new InvalidOperationException("Notification window creation failed.", error);
    }

    public Notice[] Snapshot() {
        if (!thread.IsAlive || error != null) throw new InvalidOperationException("The notification pump is not available.", error);
        return notices.ToArray();
    }

    private void Pump() {
        var module = GetModuleHandle(null);
        var name = "ARM.MotionNotification." + Environment.ProcessId;
        bool registered = false;
        try {
            var windowClass = new WindowClass { instance = module, className = name, procedure = Marshal.GetFunctionPointerForDelegate(callback) };
            if (RegisterClass(ref windowClass) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            registered = true;
            // A hidden top-level window can receive system broadcasts. A message-only window cannot.
            hwnd = CreateWindowEx(0, name, "", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, module, IntPtr.Zero);
            if (hwnd == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            ready.Set();
            int result;
            while ((result = GetMessage(out Message message, IntPtr.Zero, 0, 0)) > 0) DispatchMessage(ref message);
            if (result < 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        } catch (Exception e) { error = e; }
        finally {
            if (registered) UnregisterClass(name, module);
            ready.Set();
        }
    }

    private IntPtr HandleMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam) {
        if (message == SettingsChange) notices.Enqueue(new Notice(Stopwatch.GetTimestamp(), wParam.ToInt64()));
        if (message == Close) { DestroyWindow(window); return IntPtr.Zero; }
        if (message == Destroy) { PostQuitMessage(0); return IntPtr.Zero; }
        return DefWindowProc(window, message, wParam, lParam);
    }

    public static bool AnimationsEnabled() {
        RequireHosted();
        if (!GetSetting(0x1042, 0, out int value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return value != 0;
    }

    public static void SetAnimations(bool value) {
        RequireHosted();
        if (!SetSetting(0x1043, 0, new IntPtr(value ? 1 : 0), 2)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (AnimationsEnabled() != value) throw new InvalidOperationException("Windows did not retain the requested temporary motion state.");
    }

    public void Dispose() {
        if (thread.IsAlive && (!PostMessage(hwnd, Close, IntPtr.Zero, IntPtr.Zero) || !thread.Join(2000)))
            throw new InvalidOperationException("The owned notification window did not close.");
        ready.Dispose();
    }
}
