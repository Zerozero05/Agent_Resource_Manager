// Standalone Windows SDK ABI probe. No projected C++/WinRT headers are required.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
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
constexpr wchar_t branch[] = L"codex/hosted-wgc-capability-20261121";
constexpr int width = 320;
constexpr int height = 180;
constexpr UINT row = 90;
constexpr UINT leftX = 80;
constexpr UINT rightX = 240;
constexpr double readBudgetMs = 15.0;
constexpr double frameBudgetMs = 32.0;
using Rgb = std::array<std::uint8_t, 3>;
using Colors = std::array<Rgb, 2>;
constexpr Colors initial{{Rgb{218, 43, 95}, Rgb{38, 161, 71}}};
constexpr Colors changed{{Rgb{25, 106, 224}, Rgb{238, 166, 29}}};
Colors paintColors{};

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
    for (LONG index = 0; index < 2; ++index) {
        const RECT half{index * width / 2, 0, (index + 1) * width / 2, height};
        const auto color = paintColors[static_cast<std::size_t>(index)];
        const HBRUSH brush = CreateSolidBrush(RGB(color[0], color[1], color[2]));
        if (brush) {
            FillRect(device, &half, brush);
            DeleteObject(brush);
        }
    }
    EndPaint(hwnd, &paint);
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
        const Window window{CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, windowClass, L"ARM WGC synthetic colors",
            WS_POPUP, 50, 50, width, height, nullptr, nullptr, instance, nullptr)};
        require(window.hwnd != nullptr, "create-synthetic-window");
        DWORD owner{};
        require(GetWindowThreadProcessId(window.hwnd, &owner) != 0 && owner == GetCurrentProcessId(), "exact-window-owner");
        ShowWindow(window.hwnd, SW_SHOWNOACTIVATE);
        UpdateWindow(window.hwnd);
        require(IsWindowVisible(window.hwnd) != FALSE, "synthetic-window-visibility");
        const auto itemFactory = factory<IGraphicsCaptureItemInterop>(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem);
        ComPtr<IGraphicsCaptureItem> item;
        check(itemFactory->CreateForWindow(window.hwnd, IID_PPV_ARGS(&item)), "capture-own-window");
        SizeInt32 size{};
        check(item->get_Size(&size), "item-size");
        require(size.Width == width && size.Height == height, "exact-fixture-item-size");
        const auto poolFactory = factory<IDirect3D11CaptureFramePoolStatics2>(RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool);
        ComPtr<IDirect3D11CaptureFramePool> pool;
        check(poolFactory->CreateFreeThreaded(winrtDevice.Get(), DirectXPixelFormat_B8G8R8A8UIntNormalized, 2, size, &pool), "create-frame-pool");
        CloseWinRt closePool(pool);
        ComPtr<IGraphicsCaptureSession> capture;
        check(pool->CreateCaptureSession(item.Get(), &capture), "create-capture-session");
        CloseWinRt closeCapture(capture);
        FrameNotification frameNotification(pool.Get());
        ComPtr<IGraphicsCaptureSession2> cursor;
        if (SUCCEEDED(capture.As(&cursor))) check(cursor->put_IsCursorCaptureEnabled(false), "exclude-cursor-from-capture");
        D3D11_TEXTURE2D_DESC buffer{};
        buffer.Width = rightX - leftX + 1;
        buffer.Height = 1;
        buffer.MipLevels = buffer.ArraySize = buffer.SampleDesc.Count = 1;
        buffer.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        buffer.Usage = D3D11_USAGE_STAGING;
        buffer.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> staging;
        check(device->CreateTexture2D(&buffer, nullptr, &staging), "one-row-readback-allocation");
        check(capture->StartCapture(), "start-owned-window-capture");
        paintColors = initial;
        RedrawWindow(window.hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
        const auto first = expectFrame(pool.Get(), frameNotification.signal->handle, context.Get(), staging.Get(), frequency.QuadPart, initial, 0);
        paintColors = changed;
        RedrawWindow(window.hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
        const auto second = expectFrame(pool.Get(), frameNotification.signal->handle, context.Get(), staging.Get(), frequency.QuadPart, changed, first.compositor100ns);
        frameNotification.detach();
        closeCapture.close();
        closePool.close();
        std::printf("{\"status\":\"wgc-owned-window-capability\",\"syntheticOnly\":true,"
            "\"windowOwnerPid\":%lu,\"defaultCaptureBorder\":true,\"row\":90,\"columns\":[80,240],"
            "\"readBudgetMs\":15,\"frameToCpuBudgetMs\":32,\"samples\":[", static_cast<unsigned long>(owner));
        printSample(first);
        std::printf(",");
        printSample(second);
        std::printf("]}\n");
        return 0;
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
