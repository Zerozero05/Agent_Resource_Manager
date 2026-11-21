// Included by the hosted row harness inside its private namespace.
namespace Wgc {
using namespace ABI::Windows::Graphics::Capture;
using ABI::Windows::Foundation::IClosable;
using ABI::Windows::Foundation::TimeSpan;
using ABI::Windows::Graphics::SizeInt32;
using ABI::Windows::Graphics::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized;
using ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
using ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;
using Microsoft::WRL::Wrappers::HStringReference;

constexpr int FrameBuffers = 4;
constexpr int64_t MinUpdateInterval100ns = 10000;
constexpr double FrameToCpuLimitMs = 32.0;

void MarkPhase(const char* phase) {
    std::fprintf(stderr, "ARM-WGC-PHASE %s\n", phase);
    std::fflush(stderr);
}

struct Runtime {
    Runtime() { Check(RoInitialize(RO_INIT_MULTITHREADED), "RoInitialize"); }
    ~Runtime() { RoUninitialize(); }
};

class CloseOnExit {
    ComPtr<IClosable> closable;
public:
    template<class T> void Track(const ComPtr<T>& object) {
        Check(object.As(&closable), "WGC closable interface");
    }
    void Close() {
        Check(closable->Close(), "Close WGC object");
        closable.Reset();
    }
    ~CloseOnExit() { if (closable) closable->Close(); }
};

using NotificationCount = std::atomic<unsigned>;
using FrameHandler = __FITypedEventHandler_2_Windows__CGraphics__CCapture__CDirect3D11CaptureFramePool_IInspectable;
class AgileFrameHandler final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, FrameHandler, Microsoft::WRL::FtmBase> {
    std::shared_ptr<NotificationCount> offered;
public:
    explicit AgileFrameHandler(const std::shared_ptr<NotificationCount>& count) : offered(count) {}
    HRESULT STDMETHODCALLTYPE Invoke(IDirect3D11CaptureFramePool*, IInspectable*) override {
        offered->fetch_add(1);
        return S_OK;
    }
};

class Notifications {
    IDirect3D11CaptureFramePool* pool = nullptr;
    std::shared_ptr<NotificationCount> offered = std::make_shared<NotificationCount>(0);
    EventRegistrationToken token{};
public:
    void Subscribe(IDirect3D11CaptureFramePool* source) {
        const auto callback = Microsoft::WRL::Make<AgileFrameHandler>(offered);
        if (!callback) throw std::runtime_error("WGC frame handler allocation failed");
        ComPtr<IAgileObject> agile;
        Check(callback.As(&agile), "WGC agile frame handler");
        Check(source->add_FrameArrived(callback.Get(), &token), "WGC subscribe FrameArrived");
        pool = source;
    }
    ~Notifications() { if (pool) pool->remove_FrameArrived(token); }
    unsigned Stop() {
        Check(pool->remove_FrameArrived(token), "WGC unsubscribe FrameArrived");
        pool = nullptr;
        return offered->load();
    }
};

template<class T> ComPtr<T> Factory(const wchar_t* name) {
    ComPtr<T> factory;
    Check(RoGetActivationFactory(HStringReference(name).Get(), IID_PPV_ARGS(&factory)), "WGC activation factory");
    return factory;
}

RECT VisibleFrame(HWND window) {
    DWORD cloaked{};
    RECT result{};
    Check(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked)), "read WGC cloak state");
    Check(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &result, sizeof(result)), "read WGC bounds");
    if (cloaked || !IsWindowVisible(window) || IsIconic(window) || GetAncestor(window, GA_ROOT) != window ||
        result.right <= result.left || result.bottom <= result.top)
        throw std::runtime_error("WGC target must be the visible owned root window");
    return result;
}

struct FrameCounts { unsigned offered; unsigned read; };
}

class Capture {
    OwnedWindow& target;
    Wgc::Runtime runtime;
    RECT bounds{};
    UINT x{}, y{};
    Device device;
    Wgc::SizeInt32 content{};
    ComPtr<ID3D11Texture2D> staging;
    ComPtr<Wgc::IDirect3D11CaptureFramePool> pool;
    Wgc::CloseOnExit closePool;
    ComPtr<Wgc::IGraphicsCaptureSession> session;
    Wgc::CloseOnExit closeSession;
    Wgc::Notifications notifications;
    Wgc::TimeSpan updateIntervalBefore{}, updateInterval{};
    unsigned framesRead{};

public:
    const UINT width;
    const int64_t frequency;

    explicit Capture(OwnedWindow& owned)
        : target(owned), device(nullptr, true), width(RowWidth(owned)), frequency(Frequency()) {
        target.Verify();
        bounds = Wgc::VisibleFrame(target.window);
        if (target.first.y != target.second.y || !PtInRect(&bounds, target.first) || !PtInRect(&bounds, target.second))
            throw std::runtime_error("WGC points must share one row inside the owned window");
        x = static_cast<UINT>(target.first.x - bounds.left);
        y = static_cast<UINT>(target.first.y - bounds.top);

        const auto support = Wgc::Factory<Wgc::IGraphicsCaptureSessionStatics>(
            RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureSession);
        boolean supported{};
        Check(support->IsSupported(&supported), "WGC IsSupported");
        if (!supported) throw std::runtime_error("window capture is unavailable");
        const auto itemFactory = Wgc::Factory<IGraphicsCaptureItemInterop>(
            RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem);
        ComPtr<Wgc::IGraphicsCaptureItem> item;
        Check(itemFactory->CreateForWindow(target.window, IID_PPV_ARGS(&item)), "WGC CreateForWindow");
        Check(item->get_Size(&content), "WGC item size");
        if (content.Width != bounds.right - bounds.left || content.Height != bounds.bottom - bounds.top)
            throw std::runtime_error("WGC item size does not match the owned visible screen bounds");

        ComPtr<IDXGIDevice> dxgi;
        Check(device.device.As(&dxgi), "WGC DXGI device interface");
        ComPtr<IInspectable> wrapped;
        Check(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), &wrapped), "WGC wrap D3D11 device");
        ComPtr<Wgc::IDirect3DDevice> winrtDevice;
        Check(wrapped.As(&winrtDevice), "WGC WinRT device interface");
        const auto poolFactory = Wgc::Factory<Wgc::IDirect3D11CaptureFramePoolStatics2>(
            RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool);
        Check(poolFactory->CreateFreeThreaded(winrtDevice.Get(), Wgc::DirectXPixelFormat_B8G8R8A8UIntNormalized,
            Wgc::FrameBuffers, content, &pool), "WGC CreateFreeThreaded");
        closePool.Track(pool);
        Check(pool->CreateCaptureSession(item.Get(), &session), "WGC CreateCaptureSession");
        closeSession.Track(session);
        ComPtr<Wgc::IGraphicsCaptureSession2> cursor;
        Check(session.As(&cursor), "WGC cursor option interface");
        Check(cursor->put_IsCursorCaptureEnabled(false), "exclude pointer from WGC pixels");
        ComPtr<Wgc::IGraphicsCaptureSession5> cadence;
        Check(session.As(&cadence), "WGC minimum update interval interface");
        Check(cadence->get_MinUpdateInterval(&updateIntervalBefore), "read original WGC minimum update interval");
        Check(cadence->put_MinUpdateInterval(Wgc::TimeSpan{Wgc::MinUpdateInterval100ns}),
            "set 1 ms WGC minimum update interval");
        Check(cadence->get_MinUpdateInterval(&updateInterval), "read back WGC minimum update interval");
        if (updateInterval.Duration != Wgc::MinUpdateInterval100ns)
            throw std::runtime_error("WGC did not retain the exact 1 ms session interval");
        notifications.Subscribe(pool.Get());
        const auto row = RowDescription(width, D3D11_USAGE_STAGING);
        Check(device.device->CreateTexture2D(&row, nullptr, &staging), "allocate one WGC readback row");
        target.Verify();
        Wgc::MarkPhase("session-starting");
        Check(session->StartCapture(), "WGC StartCapture");
        Wgc::MarkPhase("session-started");
    }

    const RECT& Bounds() const { return bounds; }
    int64_t UpdateIntervalBefore100ns() const { return updateIntervalBefore.Duration; }
    int64_t UpdateInterval100ns() const { return updateInterval.Duration; }

    Sample Poll() {
        Sample sample{};
        sample.begin = Counter();
        target.Verify();
        ComPtr<Wgc::IDirect3D11CaptureFrame> frame;
        Check(pool->TryGetNextFrame(&frame), "WGC TryGetNextFrame");
        sample.acquireReturned = Counter();
        if (!frame) {
            sample.kind = SampleKind::Unchanged;
        } else {
            Wgc::CloseOnExit closeFrame;
            closeFrame.Track(frame);
            const RECT visible = Wgc::VisibleFrame(target.window);
            if (!EqualRect(&visible, &bounds)) throw std::runtime_error("WGC target geometry changed");
            Wgc::SizeInt32 size{};
            Check(frame->get_ContentSize(&size), "WGC frame size");
            if (size.Width != content.Width || size.Height != content.Height)
                throw std::runtime_error("WGC frame size changed");
            Wgc::TimeSpan time{};
            Check(frame->get_SystemRelativeTime(&time), "WGC compositor time");
            sample.compositor100ns = time.Duration;
            sample.present = static_cast<int64_t>(
                static_cast<double>(time.Duration) * static_cast<double>(frequency) / 10000000.0);
            if (sample.present <= 0 || sample.present > sample.acquireReturned)
                throw std::runtime_error("WGC frame does not share the native QPC clock");
            sample.pixels = ReadRow(frame.Get(), sample.begin);
            sample.rowRead = Counter();
            if (DeltaMs(sample.present, sample.rowRead, frequency) > Wgc::FrameToCpuLimitMs)
                throw std::runtime_error("WGC compositor-to-CPU latency exceeded 32 ms");
            closeFrame.Close();
            sample.released = Counter();
            ++framesRead;
        }
        target.Verify();
        sample.end = Counter();
        return sample;
    }

    Wgc::FrameCounts Finish() {
        target.Verify();
        Wgc::MarkPhase("session-closing");
        closeSession.Close();
        Wgc::MarkPhase("notifications-detaching");
        const auto offered = notifications.Stop();
        Wgc::MarkPhase("pool-closing");
        closePool.Close();
        Wgc::MarkPhase("capture-closed");
        return {offered, framesRead};
    }

private:
    Pixels ReadRow(Wgc::IDirect3D11CaptureFrame* frame, int64_t begin) {
        ComPtr<Wgc::IDirect3DSurface> surface;
        Check(frame->get_Surface(&surface), "WGC frame surface");
        ComPtr<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
        Check(surface.As(&access), "WGC surface DXGI interface");
        ComPtr<ID3D11Texture2D> texture;
        Check(access->GetInterface(IID_PPV_ARGS(&texture)), "WGC surface texture");
        D3D11_TEXTURE2D_DESC description{};
        texture->GetDesc(&description);
        if (description.Width != static_cast<UINT>(content.Width) ||
            description.Height != static_cast<UINT>(content.Height) ||
            description.Format != DXGI_FORMAT_B8G8R8A8_UNORM)
            throw std::runtime_error("WGC texture geometry or format changed");
        const D3D11_BOX source{x, y, 0, x + width, y + 1, 1};
        device.context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, texture.Get(), 0, &source);
        Pixels pixels{};
        while (!TryReadStaging(device, staging.Get(), width, pixels)) {
            if (DeltaMs(begin, Counter(), frequency) > CaptureLimitMs)
                throw std::runtime_error("clipped WGC row exceeded capture budget");
            SwitchToThread();
        }
        return pixels;
    }
};
