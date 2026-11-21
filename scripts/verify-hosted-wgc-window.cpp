// Standalone Windows SDK ABI probe. No projected C++/WinRT headers are required.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dwmapi.h>
#include <roapi.h>
#include <windows.foundation.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>
#include <wrl/event.h>
#include <wrl/wrappers/corewrappers.h>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <memory>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "runtimeobject.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

namespace {
using namespace ABI::Windows::Graphics::Capture;
using ABI::Windows::Foundation::IClosable;
using ABI::Windows::Foundation::TimeSpan;
using ABI::Windows::Graphics::SizeInt32;
using ABI::Windows::Graphics::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized;
using ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
using ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Wrappers::HStringReference;

constexpr wchar_t windowClass[] = L"ArmWgcSingleOwnedFixture";
constexpr wchar_t branch[] = L"codex/hosted-wgc-style-ab-20261121";
constexpr int width = 320;
constexpr int height = 180;
constexpr UINT row = 90;
constexpr UINT leftX = 80;
constexpr UINT rightX = 240;
constexpr double readBudgetMs = 15.0;
constexpr double frameBudgetMs = 32.0;
constexpr int frameBuffers = 4;
using Rgb = std::array<std::uint8_t, 3>;
using Colors = std::array<Rgb, 2>;
constexpr Colors initial{{Rgb{218, 43, 95}, Rgb{38, 161, 71}}};
constexpr Colors changed{{Rgb{25, 106, 224}, Rgb{238, 166, 29}}};
Colors paintColors{};
unsigned painted{};

struct Failure { const char* stage; HRESULT hr; };
void require(bool test, const char* stage) {
    if (!test) throw Failure{stage, E_FAIL};
}
void check(HRESULT hr, const char* stage) {
    if (FAILED(hr)) throw Failure{stage, hr};
}

struct Runtime {
    Runtime() { check(RoInitialize(RO_INIT_MULTITHREADED), "winrt-initialize"); }
    ~Runtime() { RoUninitialize(); }
};
struct Window {
    HWND hwnd;
    ~Window() { if (hwnd) DestroyWindow(hwnd); }
};
struct CloseWinRt {
    ComPtr<IClosable> value;
    template<class T> explicit CloseWinRt(const ComPtr<T>& object) {
        check(object.As(&value), "closable-interface");
    }
    ~CloseWinRt() { if (value) value->Close(); }
    void close() {
        check(value->Close(), "winrt-close");
        value.Reset();
    }
};
struct Signal {
    HANDLE handle = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    Signal() { require(handle != nullptr, "frame-event"); }
    ~Signal() { CloseHandle(handle); }
};
struct FrameNotification {
    IDirect3D11CaptureFramePool* pool;
    std::shared_ptr<Signal> signal = std::make_shared<Signal>();
    EventRegistrationToken token{};
    bool active = false;
    explicit FrameNotification(IDirect3D11CaptureFramePool* source) : pool(source) {
        auto callback = Microsoft::WRL::Callback<__FITypedEventHandler_2_Windows__CGraphics__CCapture__CDirect3D11CaptureFramePool_IInspectable>(
            [signal = signal](IDirect3D11CaptureFramePool*, IInspectable*) -> HRESULT {
                return SetEvent(signal->handle) ? S_OK : HRESULT_FROM_WIN32(GetLastError());
            });
        require(callback != nullptr, "frame-event-callback");
        check(pool->add_FrameArrived(callback.Get(), &token), "subscribe-frame-event");
        active = true;
    }
    ~FrameNotification() { if (active) pool->remove_FrameArrived(token); }
    void detach() {
        check(pool->remove_FrameArrived(token), "unsubscribe-frame-event");
        active = false;
    }
};

bool envIs(const wchar_t* name, const wchar_t* expected) {
    wchar_t actual[128];
    const DWORD count = GetEnvironmentVariableW(name, actual, static_cast<DWORD>(std::size(actual)));
    return count > 0 && count < std::size(actual) && std::wcscmp(actual, expected) == 0;
}
std::int64_t qpc() {
    LARGE_INTEGER value{};
    require(QueryPerformanceCounter(&value) != FALSE, "qpc");
    return value.QuadPart;
}
void pump() {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}
LRESULT CALLBACK paintWindow(HWND hwnd, UINT message, WPARAM first, LPARAM second) {
    if (message != WM_PAINT) return DefWindowProcW(hwnd, message, first, second);
    PAINTSTRUCT paint{};
    const HDC device = BeginPaint(hwnd, &paint);
    bool drewBoth = device != nullptr;
    for (LONG index = 0; index < 2; ++index) {
        const RECT half{index * width / 2, 0, (index + 1) * width / 2, height};
        const auto color = paintColors[static_cast<std::size_t>(index)];
        const HBRUSH brush = CreateSolidBrush(RGB(color[0], color[1], color[2]));
        if (brush) {
            if (!FillRect(device, &half, brush)) drewBoth = false;
            DeleteObject(brush);
        } else drewBoth = false;
    }
    EndPaint(hwnd, &paint);
    if (drewBoth) ++painted;
    return 0;
}

template<class T> ComPtr<T> factory(const wchar_t* className) {
    ComPtr<T> result;
    check(RoGetActivationFactory(HStringReference(className).Get(), IID_PPV_ARGS(&result)), "activation-factory");
    return result;
}

struct Sample {
    Colors pixels{};
    std::int64_t compositor100ns{};
    double readMs{};
    double frameToCpuMs{};
};
Sample lastSample{};

Sample sampleFrame(IDirect3D11CaptureFrame* frame, ID3D11DeviceContext* context,
    ID3D11Texture2D* staging, std::int64_t frequency, std::int64_t acquired) {
    SizeInt32 size{};
    check(frame->get_ContentSize(&size), "content-size");
    require(size.Width == width && size.Height == height, "exact-fixture-content-size");
    TimeSpan time{};
    check(frame->get_SystemRelativeTime(&time), "system-relative-time");
    require(time.Duration > 0, "positive-system-relative-time");
    ComPtr<IDirect3DSurface> surface;
    check(frame->get_Surface(&surface), "capture-surface");
    ComPtr<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
    check(surface.As(&access), "capture-dxgi-access");
    ComPtr<ID3D11Texture2D> texture;
    check(access->GetInterface(IID_PPV_ARGS(&texture)), "capture-texture");
    D3D11_TEXTURE2D_DESC description{};
    texture->GetDesc(&description);
    require(description.Width == width && description.Height == height &&
        description.Format == DXGI_FORMAT_B8G8R8A8_UNORM, "exact-fixture-texture");
    const D3D11_BOX cut{leftX, row, 0, rightX + 1, row + 1, 1};
    context->CopySubresourceRegion(staging, 0, 0, 0, 0, texture.Get(), 0, &cut);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    HRESULT result;
    do {
        result = context->Map(staging, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
        if (result != DXGI_ERROR_WAS_STILL_DRAWING) break;
        require((qpc() - acquired) * 1000.0 / frequency <= readBudgetMs, "read-budget-staging");
        SwitchToThread();
    } while (true);
    check(result, "map-owned-row");
    const auto* bytes = static_cast<const std::uint8_t*>(mapped.pData);
    const auto* right = bytes + (rightX - leftX) * 4;
    const Colors pixels{{Rgb{bytes[2], bytes[1], bytes[0]}, Rgb{right[2], right[1], right[0]}}};
    context->Unmap(staging, 0);
    const auto finished = qpc();
    return Sample{pixels, time.Duration, (finished - acquired) * 1000.0 / frequency,
        finished * 1000.0 / frequency - time.Duration / 10000.0};
}

Sample expectFrame(IDirect3D11CaptureFramePool* pool, HANDLE changedFrame, ID3D11DeviceContext* context,
    ID3D11Texture2D* staging, std::int64_t frequency, const Colors& colors, std::int64_t previous) {
    const auto deadline = GetTickCount64() + 3000;
    do {
        pump();
        ComPtr<IDirect3D11CaptureFrame> frame;
        check(pool->TryGetNextFrame(&frame), "try-next-owned-frame");
        if (frame) {
            const auto acquired = qpc();
            CloseWinRt release(frame);
            const auto sample = sampleFrame(frame.Get(), context, staging, frequency, acquired);
            lastSample = sample;
            require(sample.readMs <= readBudgetMs, "read-budget");
            if (sample.pixels == colors && sample.compositor100ns > previous) {
                require(sample.frameToCpuMs >= 0.0 && sample.frameToCpuMs <= frameBudgetMs, "frame-to-cpu-budget");
                return sample;
            }
        }
        const auto now = GetTickCount64();
        if (!frame && now < deadline) {
            const DWORD remaining = static_cast<DWORD>(deadline - now);
            const DWORD result = MsgWaitForMultipleObjectsEx(1, &changedFrame, remaining, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            require(result != WAIT_FAILED, "wait-for-frame-or-paint");
        }
    } while (GetTickCount64() < deadline);
    throw Failure{"expected-two-pixels-not-acquired", HRESULT_FROM_WIN32(WAIT_TIMEOUT)};
}

void printSample(const Sample& sample) {
    std::printf("{\"pixels\":[[%u,%u,%u],[%u,%u,%u]],\"systemRelativeTime100ns\":%lld,"
        "\"readMs\":%.4f,\"frameToCpuMs\":%.4f}",
        static_cast<unsigned>(sample.pixels[0][0]), static_cast<unsigned>(sample.pixels[0][1]),
        static_cast<unsigned>(sample.pixels[0][2]), static_cast<unsigned>(sample.pixels[1][0]),
        static_cast<unsigned>(sample.pixels[1][1]), static_cast<unsigned>(sample.pixels[1][2]),
        static_cast<long long>(sample.compositor100ns), sample.readMs, sample.frameToCpuMs);
}

struct Case {
    const char* name;
    DWORD requestedExStyle;
    HWND hwnd{}, root{}, owner{};
    DWORD ownerPid{}, style{}, exStyle{}, cloak{}, affinity{};
    BOOL visible{}, minimized{}, affinityRead{};
    RECT client{}, extendedFrame{};
    bool createAttempted{}, compositionReady{}, capturePassed{};
    unsigned paintCount{};
    HRESULT cloakHr{E_PENDING}, frameHr{E_PENDING}, flushHr{E_PENDING}, beforeTimingHr{E_PENDING}, afterTimingHr{E_PENDING}, createHr{E_PENDING};
    DWM_TIMING_INFO beforeTiming{}, afterTiming{};
    Sample first{}, second{}, last{};
    Failure failure{};
};

void inspectOwnedWindow(Case& result) {
    result.root = GetAncestor(result.hwnd, GA_ROOT);
    result.owner = GetWindow(result.hwnd, GW_OWNER);
    result.style = static_cast<DWORD>(GetWindowLongPtrW(result.hwnd, GWL_STYLE));
    result.exStyle = static_cast<DWORD>(GetWindowLongPtrW(result.hwnd, GWL_EXSTYLE));
    result.visible = IsWindowVisible(result.hwnd);
    result.minimized = IsIconic(result.hwnd);
    result.cloakHr = DwmGetWindowAttribute(result.hwnd, DWMWA_CLOAKED, &result.cloak, sizeof(result.cloak));
    result.frameHr = DwmGetWindowAttribute(result.hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &result.extendedFrame, sizeof(result.extendedFrame));
    result.affinityRead = GetWindowDisplayAffinity(result.hwnd, &result.affinity);
    require(GetWindowThreadProcessId(result.hwnd, &result.ownerPid) != 0 && result.ownerPid == GetCurrentProcessId() &&
        result.root == result.hwnd && !result.owner, "exact-unowned-root-window");
    require(result.visible && !result.minimized && result.exStyle == result.requestedExStyle, "expected-visible-window-style");
    require(GetClientRect(result.hwnd, &result.client) && result.client.right == width &&
        result.client.bottom == height, "exact-fixture-client");
}

void waitForOwnComposition(Case& result) {
    result.beforeTiming.cbSize = sizeof(result.beforeTiming);
    result.afterTiming.cbSize = sizeof(result.afterTiming);
    result.beforeTimingHr = DwmGetCompositionTimingInfo(nullptr, &result.beforeTiming);
    check(result.beforeTimingHr, "dwm-timing-before-show");
    ShowWindow(result.hwnd, SW_SHOWNOACTIVATE);
    UpdateWindow(result.hwnd);
    const auto deadline = GetTickCount64() + 600;
    do {
        pump();
        result.flushHr = DwmFlush();
        check(result.flushHr, "dwm-flush-after-own-paint");
        result.afterTimingHr = DwmGetCompositionTimingInfo(nullptr, &result.afterTiming);
        check(result.afterTimingHr, "dwm-timing-after-show");
        result.paintCount = painted;
        if (painted > 0 && result.afterTiming.cFrame > result.beforeTiming.cFrame) break;
        if (GetTickCount64() < deadline) Sleep(5);
    } while (GetTickCount64() < deadline);
    inspectOwnedWindow(result);
    result.compositionReady = result.paintCount > 0 && result.afterTiming.cFrame > result.beforeTiming.cFrame &&
        SUCCEEDED(result.cloakHr) && result.cloak == 0 && SUCCEEDED(result.frameHr) &&
        result.extendedFrame.right > result.extendedFrame.left && result.extendedFrame.bottom > result.extendedFrame.top &&
        (!result.affinityRead || result.affinity == WDA_NONE);
    require(result.compositionReady, "own-paint-and-live-dwm-cycle");
}

Case runCase(const char* name, DWORD exStyle, HINSTANCE instance, IGraphicsCaptureItemInterop* itemFactory,
    IDirect3D11CaptureFramePoolStatics2* poolFactory, IDirect3DDevice* winrtDevice,
    ID3D11DeviceContext* context, ID3D11Texture2D* staging, std::int64_t frequency) {
    Case result{name, exStyle};
    paintColors = Colors{};
    painted = 0;
    lastSample = Sample{};
    try {
        const Window window{CreateWindowExW(exStyle, windowClass, L"ARM WGC synthetic colors",
            WS_POPUP, 50, 50, width, height, nullptr, nullptr, instance, nullptr)};
        require(window.hwnd != nullptr, "create-synthetic-window");
        result.hwnd = window.hwnd;
        waitForOwnComposition(result);
        ComPtr<IGraphicsCaptureItem> item;
        result.createAttempted = true;
        result.createHr = itemFactory->CreateForWindow(window.hwnd, IID_PPV_ARGS(&item));
        check(result.createHr, "capture-own-window");
        require(item != nullptr, "non-null-capture-item");
        SizeInt32 size{};
        check(item->get_Size(&size), "item-size");
        require(size.Width == width && size.Height == height, "exact-fixture-item-size");
        ComPtr<IDirect3D11CaptureFramePool> pool;
        check(poolFactory->CreateFreeThreaded(winrtDevice, DirectXPixelFormat_B8G8R8A8UIntNormalized, frameBuffers, size, &pool), "create-frame-pool");
        CloseWinRt closePool(pool);
        ComPtr<IGraphicsCaptureSession> capture;
        check(pool->CreateCaptureSession(item.Get(), &capture), "create-capture-session");
        CloseWinRt closeCapture(capture);
        FrameNotification frameNotification(pool.Get());
        ComPtr<IGraphicsCaptureSession2> cursor;
        if (SUCCEEDED(capture.As(&cursor))) check(cursor->put_IsCursorCaptureEnabled(false), "exclude-cursor-from-capture");
        check(capture->StartCapture(), "start-owned-window-capture");
        paintColors = initial;
        RedrawWindow(window.hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
        result.first = expectFrame(pool.Get(), frameNotification.signal->handle, context, staging, frequency, initial, 0);
        paintColors = changed;
        RedrawWindow(window.hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
        result.second = expectFrame(pool.Get(), frameNotification.signal->handle, context, staging, frequency, changed, result.first.compositor100ns);
        frameNotification.detach();
        closeCapture.close();
        closePool.close();
        result.capturePassed = true;
    } catch (const Failure& failure) {
        result.failure = failure;
    }
    result.last = lastSample;
    return result;
}

void printCase(const Case& result) {
    std::printf("{\"name\":\"%s\",\"requestedExStyle\":%lu,\"actualExStyle\":%lu,\"style\":%lu,"
        "\"hwnd\":%llu,\"root\":%llu,\"owner\":%llu,\"ownerPid\":%lu,\"visible\":%s,\"minimized\":%s,"
        "\"client\":[%ld,%ld],\"extendedFrame\":[%ld,%ld,%ld,%ld],\"cloak\":%lu,\"cloakHr\":\"0x%08lx\","
        "\"frameHr\":\"0x%08lx\",\"affinityRead\":%s,\"affinity\":%lu,\"paintCount\":%u,"
        "\"dwmFrameBefore\":%llu,\"dwmFrameAfter\":%llu,\"dwmFlushHr\":\"0x%08lx\","
        "\"dwmBeforeHr\":\"0x%08lx\",\"dwmAfterHr\":\"0x%08lx\",\"compositionReady\":%s,"
        "\"createAttempted\":%s,\"createForWindowHr\":\"0x%08lx\",\"capturePassed\":%s",
        result.name, result.requestedExStyle, result.exStyle, result.style,
        reinterpret_cast<unsigned long long>(result.hwnd), reinterpret_cast<unsigned long long>(result.root),
        reinterpret_cast<unsigned long long>(result.owner), result.ownerPid,
        result.visible ? "true" : "false", result.minimized ? "true" : "false",
        result.client.right, result.client.bottom, result.extendedFrame.left, result.extendedFrame.top,
        result.extendedFrame.right, result.extendedFrame.bottom, result.cloak, static_cast<unsigned long>(result.cloakHr),
        static_cast<unsigned long>(result.frameHr), result.affinityRead ? "true" : "false", result.affinity, result.paintCount,
        result.beforeTiming.cFrame, result.afterTiming.cFrame, static_cast<unsigned long>(result.flushHr),
        static_cast<unsigned long>(result.beforeTimingHr), static_cast<unsigned long>(result.afterTimingHr),
        result.compositionReady ? "true" : "false", result.createAttempted ? "true" : "false",
        static_cast<unsigned long>(result.createHr), result.capturePassed ? "true" : "false");
    std::printf(",\"samples\":[");
    if (result.first.compositor100ns > 0) printSample(result.first);
    if (result.second.compositor100ns > 0) { std::printf(","); printSample(result.second); }
    std::printf("]");
    if (result.failure.stage) std::printf(",\"failedStage\":\"%s\",\"failureHr\":\"0x%08lx\"",
        result.failure.stage, static_cast<unsigned long>(result.failure.hr));
    if (!result.capturePassed && result.last.compositor100ns > 0) { std::printf(",\"lastSample\":"); printSample(result.last); }
    std::printf("}");
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        require(argc == 2 && std::wcscmp(argv[1], L"--capture-owned-fixture") == 0 &&
            envIs(L"GITHUB_ACTIONS", L"true") && envIs(L"RUNNER_ENVIRONMENT", L"github-hosted") &&
            envIs(L"GITHUB_REF_NAME", branch), "explicit-isolated-hosted-only");
        DWORD windowsSession{};
        require(ProcessIdToSessionId(GetCurrentProcessId(), &windowsSession) != FALSE && windowsSession != 0,
            "interactive-session");
        const Runtime runtime;
        LARGE_INTEGER frequency{};
        require(QueryPerformanceFrequency(&frequency) != FALSE && frequency.QuadPart > 0, "qpc-frequency");
        const auto supportedApi = factory<IGraphicsCaptureSessionStatics>(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureSession);
        boolean supported{};
        check(supportedApi->IsSupported(&supported), "graphics-capture-support");
        require(supported != 0, "graphics-capture-unavailable");

        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context), "d3d11-hardware-device");
        ComPtr<IDXGIDevice> dxgi;
        check(device.As(&dxgi), "dxgi-device");
        ComPtr<IInspectable> wrapped;
        check(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), &wrapped), "wrap-d3d11-device");
        ComPtr<IDirect3DDevice> winrtDevice;
        check(wrapped.As(&winrtDevice), "winrt-device");

        const auto instance = GetModuleHandleW(nullptr);
        WNDCLASSW klass{};
        klass.hInstance = instance;
        klass.lpfnWndProc = paintWindow;
        klass.lpszClassName = windowClass;
        require(RegisterClassW(&klass) != 0, "register-synthetic-window-class");
        const auto itemFactory = factory<IGraphicsCaptureItemInterop>(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem);
        const auto poolFactory = factory<IDirect3D11CaptureFramePoolStatics2>(RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool);
        D3D11_TEXTURE2D_DESC buffer{};
        buffer.Width = rightX - leftX + 1;
        buffer.Height = 1;
        buffer.MipLevels = buffer.ArraySize = buffer.SampleDesc.Count = 1;
        buffer.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        buffer.Usage = D3D11_USAGE_STAGING;
        buffer.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> staging;
        check(device->CreateTexture2D(&buffer, nullptr, &staging), "one-row-readback-allocation");
        const auto tool = runCase("tool-noactivate", WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, instance,
            itemFactory.Get(), poolFactory.Get(), winrtDevice.Get(), context.Get(), staging.Get(), frequency.QuadPart);
        const auto plain = runCase("plain", 0, instance, itemFactory.Get(), poolFactory.Get(), winrtDevice.Get(),
            context.Get(), staging.Get(), frequency.QuadPart);
        const bool comparable = tool.createAttempted && plain.createAttempted;
        const bool capability = comparable && (tool.capturePassed || plain.capturePassed);
        std::printf("{\"status\":\"%s\",\"syntheticOnly\":true,\"windowClass\":\"ArmWgcSingleOwnedFixture\","
            "\"currentPid\":%lu,\"defaultCaptureBorder\":true,\"frameBuffersPerCase\":%d,\"row\":90,\"columns\":[80,240],"
            "\"readBudgetMs\":15,\"frameToCpuBudgetMs\":32,\"comparable\":%s,\"cases\":[",
            capability ? "wgc-style-ab-qualified" : "wgc-style-ab-no-qualified-capture", GetCurrentProcessId(),
            frameBuffers, comparable ? "true" : "false");
        printCase(tool);
        std::printf(",");
        printCase(plain);
        std::printf("]}\n");
        return capability ? 0 : 1;
    } catch (const Failure& failure) {
        std::printf("{\"status\":\"wgc-unavailable-or-failed\",\"stage\":\"%s\",\"hresult\":\"0x%08lx\"",
            failure.stage, static_cast<unsigned long>(failure.hr));
        if (lastSample.compositor100ns > 0) {
            std::printf(",\"lastSample\":");
            printSample(lastSample);
        }
        std::printf("}\n");
        return 1;
    }
}
