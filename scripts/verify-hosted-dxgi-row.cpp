// Capability probe for the synthetic hosted motion harness. It never sends input.
// Compile with the existing x64 Windows SDK: cl /std:c++17 /EHsc /W4 verify-hosted-dxgi-row.cpp
// The local --synthetic mode touches only two in-memory textures on a WARP device.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <Windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cerrno>
#include <cstdint>
#include <iterator>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <limits>
#include <stdexcept>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "user32.lib")

using Microsoft::WRL::ComPtr;

namespace {
constexpr double CaptureLimitMs = 15.0;

struct Error { const char* operation; HRESULT result; };
void Check(HRESULT result, const char* operation) {
    if (FAILED(result)) throw Error{operation, result};
}
int64_t Counter() {
    LARGE_INTEGER value{};
    if (!QueryPerformanceCounter(&value)) throw std::runtime_error("QPC unavailable");
    return value.QuadPart;
}
int64_t Frequency() {
    LARGE_INTEGER value{};
    if (!QueryPerformanceFrequency(&value) || value.QuadPart <= 0)
        throw std::runtime_error("QPC frequency unavailable");
    return value.QuadPart;
}
double DeltaMs(int64_t start, int64_t end, int64_t frequency) {
    return static_cast<double>(end - start) * 1000.0 / static_cast<double>(frequency);
}

bool EnvEquals(const wchar_t* name, const wchar_t* expected) {
    wchar_t value[64]{};
    const auto read = GetEnvironmentVariableW(name, value, static_cast<DWORD>(std::size(value)));
    return read > 0 && read < std::size(value) && std::wcscmp(value, expected) == 0;
}
uint64_t ParseUnsigned(const wchar_t* text) {
    if (*text < L'0' || *text > L'9') throw std::runtime_error("invalid unsigned argument");
    wchar_t* end = nullptr;
    errno = 0;
    const auto result = std::wcstoull(text, &end, 10);
    if (!end || *end || errno == ERANGE) throw std::runtime_error("invalid unsigned argument");
    return result;
}
LONG ParseCoordinate(const wchar_t* text) {
    if ((*text < L'0' || *text > L'9') && *text != L'-')
        throw std::runtime_error("invalid screen coordinate");
    wchar_t* end = nullptr;
    errno = 0;
    const auto result = std::wcstol(text, &end, 10);
    if (!end || end == text || *end || errno == ERANGE)
        throw std::runtime_error("invalid screen coordinate");
    return result;
}
DWORD LastInputTick() {
    LASTINPUTINFO info{sizeof(LASTINPUTINFO), 0};
    if (!GetLastInputInfo(&info)) throw std::runtime_error("input ownership unavailable");
    return info.dwTime;
}
uint64_t ProcessCreation(HANDLE process) {
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(process, &creation, &exit, &kernel, &user))
        throw std::runtime_error("owned process creation unavailable");
    return (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
}

struct OwnedWindow {
    HWND window;
    DWORD pid;
    uint64_t creation;
    POINT first;
    POINT second;
    DWORD inputTick;
    HANDLE process = nullptr;

    OwnedWindow(HWND handle, DWORD ownerPid, uint64_t ownerCreation, POINT a, POINT b)
        : window(handle), pid(ownerPid), creation(ownerCreation), first(a), second(b),
          inputTick(LastInputTick()) {
        process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
        if (!process) throw std::runtime_error("cannot open expected owner");
    }
    ~OwnedWindow() { CloseHandle(process); }
    OwnedWindow(const OwnedWindow&) = delete;
    OwnedWindow& operator=(const OwnedWindow&) = delete;

    void Verify() const {
        DWORD owner = 0;
        DWORD ownSession = 0;
        DWORD ownerSession = 0;
        if (!ProcessIdToSessionId(GetCurrentProcessId(), &ownSession) || !ownSession ||
            !ProcessIdToSessionId(pid, &ownerSession) || ownSession != ownerSession ||
            WaitForSingleObject(process, 0) != WAIT_TIMEOUT || ProcessCreation(process) != creation ||
            !GetWindowThreadProcessId(window, &owner) || owner != pid ||
            GetForegroundWindow() != window || LastInputTick() != inputTick ||
            GetAncestor(WindowFromPoint(first), GA_ROOT) != window ||
            GetAncestor(WindowFromPoint(second), GA_ROOT) != window) {
            throw std::runtime_error("the exact foreground test window or its input ownership changed");
        }
    }
};

struct Output {
    ComPtr<IDXGIAdapter1> adapter;
    ComPtr<IDXGIOutput1> output;
    RECT bounds{};
};

Output FindOutput(HMONITOR monitor) {
    ComPtr<IDXGIFactory1> factory;
    Check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "CreateDXGIFactory1");
    for (UINT adapterIndex = 0;; ++adapterIndex) {
        ComPtr<IDXGIAdapter1> adapter;
        const HRESULT adapterStatus = factory->EnumAdapters1(adapterIndex, &adapter);
        if (adapterStatus == DXGI_ERROR_NOT_FOUND) break;
        Check(adapterStatus, "EnumAdapters1");
        for (UINT outputIndex = 0;; ++outputIndex) {
            ComPtr<IDXGIOutput> candidate;
            const HRESULT next = adapter->EnumOutputs(outputIndex, &candidate);
            if (next == DXGI_ERROR_NOT_FOUND) break;
            Check(next, "EnumOutputs");
            DXGI_OUTPUT_DESC description{};
            Check(candidate->GetDesc(&description), "GetDesc(output)");
            if (description.AttachedToDesktop && description.Monitor == monitor) {
                Output result{adapter, {}, description.DesktopCoordinates};
                Check(candidate.As(&result.output), "QueryInterface(IDXGIOutput1)");
                return result;
            }
        }
    }
    throw std::runtime_error("no attached DXGI output contains both exact points");
}

struct Device {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    explicit Device(IDXGIAdapter1* adapter) {
        Check(D3D11CreateDevice(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_WARP,
              nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context),
              "D3D11CreateDevice");
    }
};

D3D11_TEXTURE2D_DESC RowDescription(UINT width, D3D11_USAGE usage) {
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width;
    description.Height = description.MipLevels = description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = usage;
    if (usage == D3D11_USAGE_STAGING) description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    return description;
}

struct Pixels { COLORREF first; COLORREF second; };
Pixels ReadEndpoints(const void* data, UINT rowBytes, UINT width) {
    if (!data || rowBytes < width * 4 || width < 2)
        throw std::runtime_error("unsafe mapped row span");
    const auto* bytes = static_cast<const uint8_t*>(data);
    const auto* last = bytes + (width - 1) * 4;
    return {RGB(bytes[2], bytes[1], bytes[0]), RGB(last[2], last[1], last[0])};
}
bool TryReadStaging(Device& device, ID3D11Texture2D* texture, UINT width, Pixels& result) {
    D3D11_MAPPED_SUBRESOURCE mapped{};
    const HRESULT status = device.context->Map(texture, 0, D3D11_MAP_READ,
        D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
    if (status == DXGI_ERROR_WAS_STILL_DRAWING) return false;
    Check(status, "Map(staging)");
    try { result = ReadEndpoints(mapped.pData, mapped.RowPitch, width); }
    catch (...) { device.context->Unmap(texture, 0); throw; }
    device.context->Unmap(texture, 0);
    return true;
}

int RunSynthetic() {
    const int64_t frequency = Frequency();
    Device device(nullptr);
    constexpr uint32_t colors[]{0xff102030, 0xffaabbcc, 0xfffedcba, 0xff123456};
    const auto description = RowDescription(4, D3D11_USAGE_DEFAULT);
    const D3D11_SUBRESOURCE_DATA initial{colors, sizeof(colors), 0};
    ComPtr<ID3D11Texture2D> source;
    Check(device.device->CreateTexture2D(&description, &initial, &source), "CreateTexture2D(input)");
    const auto outputDescription = RowDescription(2, D3D11_USAGE_STAGING);
    ComPtr<ID3D11Texture2D> output;
    Check(device.device->CreateTexture2D(&outputDescription, nullptr, &output), "CreateTexture2D(output)");
    const D3D11_BOX box{1, 0, 0, 3, 1, 1};
    const auto begin = Counter();
    device.context->CopySubresourceRegion(output.Get(), 0, 0, 0, 0, source.Get(), 0, &box);
    device.context->Flush();
    Pixels pixels{};
    while (!TryReadStaging(device, output.Get(), 2, pixels)) {
        if (DeltaMs(begin, Counter(), frequency) > 250) throw std::runtime_error("WARP row did not arrive");
        SwitchToThread();
    }
    if (pixels.first != RGB(0xaa, 0xbb, 0xcc) || pixels.second != RGB(0xfe, 0xdc, 0xba))
        throw std::runtime_error("wrong synthetic BGR bytes or clipped coordinates");
    std::printf("{\"status\":\"synthetic-row-exact\",\"first\":%lu,\"second\":%lu,\"desktopAccess\":false}\n",
        pixels.first, pixels.second);
    return 0;
}

struct Frame {
    IDXGIOutputDuplication* duplication;
    ~Frame() { if (duplication) duplication->ReleaseFrame(); }
    void Close() {
        auto* open = duplication;
        duplication = nullptr;
        Check(open->ReleaseFrame(), "ReleaseFrame");
    }
};

int RunHosted(OwnedWindow& target) {
    target.Verify();
    const auto monitor = MonitorFromPoint(target.first, MONITOR_DEFAULTTONULL);
    const auto width64 = static_cast<int64_t>(target.second.x) - target.first.x + 1;
    if (!monitor || target.first.y != target.second.y || width64 < 2 || width64 > 512 ||
        MonitorFromPoint(target.second, MONITOR_DEFAULTTONULL) != monitor)
        throw std::runtime_error("test points must share one clipped row on one output");
    const auto width = static_cast<UINT>(width64);
    const auto output = FindOutput(monitor);
    if (!PtInRect(&output.bounds, target.first) || !PtInRect(&output.bounds, target.second))
        throw std::runtime_error("test points are outside the DXGI output bounds");
    const auto x = static_cast<UINT>(static_cast<int64_t>(target.first.x) - output.bounds.left);
    const auto y = static_cast<UINT>(static_cast<int64_t>(target.first.y) - output.bounds.top);
    Device device(output.adapter.Get());
    ComPtr<IDXGIOutputDuplication> duplication;
    Check(output.output->DuplicateOutput(device.device.Get(), &duplication), "DuplicateOutput");
    DXGI_OUTDUPL_DESC description{};
    duplication->GetDesc(&description);
    if (description.Rotation != DXGI_MODE_ROTATION_IDENTITY ||
        description.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
        description.ModeDesc.Width < width || x > description.ModeDesc.Width - width ||
        y >= description.ModeDesc.Height)
        throw std::runtime_error("unsupported or changed output geometry");

    ComPtr<ID3D11Texture2D> staging;
    if (!description.DesktopImageInSystemMemory) {
        const auto row = RowDescription(width, D3D11_USAGE_STAGING);
        Check(device.device->CreateTexture2D(&row, nullptr, &staging), "CreateTexture2D(staging)");
    }
    const auto frequency = Frequency();
    const auto pollStarted = Counter();
    unsigned unchanged = 0, pointerOnly = 0;
    DXGI_OUTDUPL_FRAME_INFO info{};
    while (DeltaMs(pollStarted, Counter(), frequency) < 250) {
        const auto begin = Counter();
        target.Verify();
        ComPtr<IDXGIResource> resource;
        const auto result = duplication->AcquireNextFrame(0, &info, &resource);
        if (result == DXGI_ERROR_WAIT_TIMEOUT) {
            ++unchanged;
            Sleep(1);
            continue;
        }
        Check(result, "AcquireNextFrame(0)");
        Frame frame{duplication.Get()};
        if (!info.LastPresentTime.QuadPart) {
            ++pointerOnly;
            frame.Close();
            continue;
        }
        if (info.ProtectedContentMaskedOut) throw std::runtime_error("masked desktop capture");
        Pixels pixels{};
        if (description.DesktopImageInSystemMemory) {
            DXGI_MAPPED_RECT mapped{};
            Check(duplication->MapDesktopSurface(&mapped), "MapDesktopSurface");
            try {
                if (mapped.Pitch < 0 || static_cast<UINT>(mapped.Pitch) < (x + width) * 4 || !mapped.pBits)
                    throw std::runtime_error("unsafe mapped desktop pitch");
                pixels = ReadEndpoints(mapped.pBits + static_cast<size_t>(y) * mapped.Pitch + x * 4,
                    static_cast<UINT>(mapped.Pitch) - x * 4, width);
            } catch (...) { duplication->UnMapDesktopSurface(); throw; }
            Check(duplication->UnMapDesktopSurface(), "UnMapDesktopSurface");
        } else {
            ComPtr<ID3D11Texture2D> texture;
            Check(resource.As(&texture), "QueryInterface(ID3D11Texture2D)");
            const D3D11_BOX source{x, y, 0, x + width, y + 1, 1};
            device.context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, texture.Get(), 0, &source);
            device.context->Flush();
            while (!TryReadStaging(device, staging.Get(), width, pixels)) {
                if (DeltaMs(begin, Counter(), frequency) > CaptureLimitMs)
                    throw std::runtime_error("first clipped GPU row exceeded capture budget");
                SwitchToThread();
            }
        }
        frame.Close();
        target.Verify();
        const auto end = Counter();
        if (info.LastPresentTime.QuadPart < 0 || info.LastPresentTime.QuadPart > end ||
            !info.AccumulatedFrames)
            throw std::runtime_error("invalid compositor present metadata");
        const double elapsed = DeltaMs(begin, end, frequency);
        std::printf("{\"status\":\"%s\",\"presentQpc\":%lld,\"sampleBeginQpc\":%lld,"
                    "\"sampleEndQpc\":%lld,\"qpcFrequency\":%lld,\"sampleMs\":%.6f,"
                    "\"accumulatedFrames\":%u,\"noUpdatePolls\":%u,\"pointerOnlyFrames\":%u,"
                    "\"rowWidth\":%u,\"first\":%lu,\"second\":%lu,\"systemMemory\":%s}\n",
            elapsed <= CaptureLimitMs ? "one-compositor-row-within-budget" : "one-compositor-row-over-budget",
            info.LastPresentTime.QuadPart, begin, end, frequency, elapsed, info.AccumulatedFrames,
            unchanged, pointerOnly, width, pixels.first, pixels.second,
            description.DesktopImageInSystemMemory ? "true" : "false");
        return elapsed <= CaptureLimitMs ? 0 : 3;
    }
    std::printf("{\"status\":\"no-compositor-row\",\"noUpdatePolls\":%u,\"pointerOnlyFrames\":%u}\n",
        unchanged, pointerOnly);
    return 2;
}
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc == 2 && std::wcscmp(argv[1], L"--synthetic") == 0) return RunSynthetic();
        if (argc != 8 || std::wcscmp(argv[1], L"--hosted") != 0 ||
            !EnvEquals(L"GITHUB_ACTIONS", L"true") || !EnvEquals(L"RUNNER_ENVIRONMENT", L"github-hosted") ||
            !EnvEquals(L"RUNNER_OS", L"Windows")) {
            throw std::runtime_error("desktop access is limited to the exact foreground synthetic GitHub-hosted window");
        }
        if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
            throw std::runtime_error("physical-pixel DPI awareness unavailable");
        const auto pid = ParseUnsigned(argv[2]);
        const auto window = ParseUnsigned(argv[4]);
        if (!pid || pid > std::numeric_limits<DWORD>::max() || !window)
            throw std::runtime_error("invalid expected PID or HWND");
        const auto y = ParseCoordinate(argv[6]);
        OwnedWindow target(reinterpret_cast<HWND>(window), static_cast<DWORD>(pid),
            ParseUnsigned(argv[3]), {ParseCoordinate(argv[5]), y}, {ParseCoordinate(argv[7]), y});
        return RunHosted(target);
    } catch (const Error& error) {
        std::fprintf(stderr, "%s failed (HRESULT 0x%08lx)\n", error.operation,
            static_cast<unsigned long>(error.result));
    } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); }
    return 1;
}
