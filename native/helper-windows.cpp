#include <windows.h>
#include <uiautomation.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

using Microsoft::WRL::ComPtr;

struct WindowFocus {
    HWND window = nullptr;
    HWND control = nullptr;
};

std::mutex stateMutex;
std::mutex outputMutex;
WindowFocus lastExternal;
WindowFocus highlighted;
std::atomic<bool> running = true;
DWORD readerPid = 0;

void send(const std::string& message) {
    std::lock_guard<std::mutex> lock(outputMutex);
    std::cout << message << std::endl;
}

WindowFocus foreground() {
    WindowFocus focus;
    focus.window = GetForegroundWindow();
    if (!focus.window) return focus;
    GUITHREADINFO info{sizeof(info)};
    if (GetGUIThreadInfo(GetWindowThreadProcessId(focus.window, nullptr), &info)) {
        focus.control = info.hwndFocus;
    }
    return focus;
}

bool external(HWND window) {
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (!pid || pid == readerPid) return false;
    wchar_t name[64]{};
    GetClassNameW(window, name, ARRAYSIZE(name));
    const std::wstring windowClass(name);
    return windowClass != L"Shell_TrayWnd" && windowClass != L"Shell_SecondaryTrayWnd" &&
        windowClass != L"NotifyIconOverflowWindow" && windowClass != L"TopLevelWindowForOverflowXamlIsland" &&
        windowClass != L"#32768";
}

// Kokoro Reader's own windows (reader panel, playback controls) may take focus without ending the highlight.
bool ours(HWND window) {
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    return pid && pid == readerPid;
}

void trackFocus() {
    while (running) {
        const auto focus = foreground();
        {
            std::lock_guard<std::mutex> lock(stateMutex);
            if (external(focus.window)) lastExternal = focus;
            if (highlighted.window && !ours(focus.window) &&
                (highlighted.window != focus.window || highlighted.control != focus.control)) {
                highlighted = {};
                send(R"({"type":"hide"})");
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
}

std::string jsonString(const std::wstring& text) {
    const int length = static_cast<int>(text.size());
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), length, nullptr, 0, nullptr, nullptr);
    std::string utf8(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), length, utf8.data(), size, nullptr, nullptr);
    const char hex[] = "0123456789abcdef";
    std::string json = "\"";
    for (const unsigned char byte : utf8) {
        if (byte == '"' || byte == '\\') {
            json += '\\';
            json += static_cast<char>(byte);
        } else if (byte < 0x20) {
            json += "\\u00";
            json += hex[byte >> 4];
            json += hex[byte & 15];
        } else {
            json += static_cast<char>(byte);
        }
    }
    return json + '"';
}

std::wstring readText(IUIAutomationTextRange* range) {
    BSTR value = nullptr;
    if (FAILED(range->GetText(-1, &value)) || !value) return {};
    std::wstring text(value, SysStringLen(value));
    SysFreeString(value);
    return text;
}

// UIA's Character unit may group multiple UTF-16 code units. Verify every
// boundary against the selected text before using it to place the overlay.
ComPtr<IUIAutomationTextRange> prefixAt(IUIAutomationTextRange* selection, const std::wstring& text, int offset) {
    ComPtr<IUIAutomationTextRange> prefix;
    if (FAILED(selection->Clone(&prefix)) || !prefix ||
        FAILED(prefix->MoveEndpointByRange(TextPatternRangeEndpoint_End, prefix.Get(), TextPatternRangeEndpoint_Start))) {
        return {};
    }
    int move = offset;
    for (int attempt = 0; attempt < 6; ++attempt) {
        if (move) {
            int moved = 0;
            if (FAILED(prefix->MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, move, &moved))) return {};
            if (!moved) return {};
        }
        int comparison = 0;
        if (FAILED(prefix->CompareEndpoints(TextPatternRangeEndpoint_End, selection, TextPatternRangeEndpoint_End, &comparison))) return {};
        if (comparison > 0 && FAILED(prefix->MoveEndpointByRange(TextPatternRangeEndpoint_End, selection, TextPatternRangeEndpoint_End))) return {};
        const auto actual = readText(prefix.Get());
        if (actual.size() == static_cast<size_t>(offset) && text.compare(0, actual.size(), actual) == 0) return prefix;
        if (actual.size() > text.size() || text.compare(0, actual.size(), actual) != 0) return {};
        move = offset - static_cast<int>(actual.size());
        if (comparison > 0 && move >= 0) return {};
    }
    return {};
}

std::string boundsFor(IUIAutomationTextRange* selection, const std::wstring& text, int from, int to) {
    if (from < 0 || to <= from || static_cast<size_t>(to) > text.size()) return "null";
    const auto start = prefixAt(selection, text, from);
    const auto end = prefixAt(selection, text, to);
    if (!start || !end || FAILED(end->MoveEndpointByRange(TextPatternRangeEndpoint_Start, start.Get(), TextPatternRangeEndpoint_End))) {
        return "null";
    }
    if (readText(end.Get()) != text.substr(from, to - from)) return "null";
    SAFEARRAY* rectangles = nullptr;
    if (FAILED(end->GetBoundingRectangles(&rectangles)) || !rectangles) return "null";
    std::string result = "null";
    LONG first = 0, last = -1;
    double* values = nullptr;
    if (SUCCEEDED(SafeArrayGetLBound(rectangles, 1, &first)) &&
        SUCCEEDED(SafeArrayGetUBound(rectangles, 1, &last)) &&
        SUCCEEDED(SafeArrayAccessData(rectangles, reinterpret_cast<void**>(&values)))) {
        for (LONG i = 0; i + 3 <= last - first; i += 4) {
            const double x = values[i], y = values[i + 1], width = values[i + 2], height = values[i + 3];
            if (std::abs(x) < 100000 && std::abs(y) < 100000 && width >= 1 && height >= 1 &&
                width < 10000 && height < 1000) {
                result = "{\"x\":" + std::to_string(std::lround(x)) + ",\"y\":" + std::to_string(std::lround(y)) +
                    ",\"width\":" + std::to_string(std::lround(width)) + ",\"height\":" + std::to_string(std::lround(height)) + "}";
                break;
            }
        }
        SafeArrayUnaccessData(rectangles);
    }
    SafeArrayDestroy(rectangles);
    return result;
}

struct Selection {
    WindowFocus focus;
    ComPtr<IUIAutomationTextRange> range;
    std::wstring text;
};

Selection capture(IUIAutomation* automation, bool fromTray) {
    auto focus = foreground();
    const bool active = external(focus.window);
    if (!active && fromTray) {
        std::lock_guard<std::mutex> lock(stateMutex);
        focus = lastExternal;
    }
    if (!IsWindow(focus.window) || !external(focus.window)) return {};

    ComPtr<IUIAutomationElement> element;
    if (active) automation->GetFocusedElement(&element);
    else if (IsWindow(focus.control)) automation->ElementFromHandle(focus.control, &element);
    if (!element) automation->ElementFromHandle(focus.window, &element);
    ComPtr<IUIAutomationTreeWalker> walker;
    automation->get_RawViewWalker(&walker);
    DWORD pid = 0;
    GetWindowThreadProcessId(focus.window, &pid);
    for (int i = 0; element && i < 8; ++i) {
        int elementPid = 0;
        BOOL password = FALSE;
        if (FAILED(element->get_CurrentProcessId(&elementPid)) || static_cast<DWORD>(elementPid) != pid ||
            FAILED(element->get_CurrentIsPassword(&password)) || password) break;
        ComPtr<IUIAutomationTextPattern> pattern;
        ComPtr<IUIAutomationTextRangeArray> ranges;
        int count = 0;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) && pattern &&
            SUCCEEDED(pattern->GetSelection(&ranges)) && ranges && SUCCEEDED(ranges->get_Length(&count))) {
            Selection result{focus, {}, {}};
            for (int index = 0; index < count; ++index) {
                ComPtr<IUIAutomationTextRange> range;
                if (FAILED(ranges->GetElement(index, &range)) || !range) continue;
                auto text = readText(range.Get());
                if (text.find_first_not_of(L" \r\n\t") == std::wstring::npos) continue;
                if (!result.text.empty()) result.text += L'\n';
                result.text += text;
                if (count == 1) result.range = range;
            }
            if (!result.text.empty() && (!active || GetForegroundWindow() == focus.window)) return result;
        }
        ComPtr<IUIAutomationElement> parent;
        if (walker) walker->GetParentElement(element.Get(), &parent);
        element = parent;
    }
    return {};
}

int main(int argc, char** argv) {
    if (argc > 1) readerPid = std::strtoul(argv[1], nullptr, 10);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
    ComPtr<IUIAutomation> automation;
    if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)))) {
        CoUninitialize();
        return 1;
    }
    ComPtr<IUIAutomation2> options;
    if (SUCCEEDED(automation.As(&options))) {
        options->put_ConnectionTimeout(700);
        options->put_TransactionTimeout(1000);
    }
    std::thread tracker(trackFocus);
    Selection selection;
    for (std::string line; std::getline(std::cin, line);) {
        if (line == "capture" || line == "capture tray") {
            selection = capture(automation.Get(), line == "capture tray");
            if (selection.text.empty()) send(R"({"type":"capture","ok":false,"error":"noselection"})");
            else send("{\"type\":\"capture\",\"ok\":true,\"text\":" + jsonString(selection.text) +
                ",\"sourceHighlight\":" + (selection.range ? "true" : "false") + "}");
        } else if (line == "refocus") {
            // Best effort: the helper was started by Kokoro Reader, which lets it set the foreground window.
            if (ours(GetForegroundWindow()) && IsWindow(selection.focus.window) && !IsIconic(selection.focus.window)) {
                SetForegroundWindow(selection.focus.window);
            }
        } else if (line == "clear") {
            selection = {};
            std::lock_guard<std::mutex> lock(stateMutex);
            highlighted = {};
        } else {
            std::istringstream input(line);
            std::string command;
            int request = 0, from = 0, to = 0;
            if (!(input >> command >> request >> from >> to) || command != "highlight") continue;
            auto focus = foreground();
            const auto matches = [&] {
                if (ours(focus.window)) {
                    return IsWindow(selection.focus.window) && IsWindowVisible(selection.focus.window) &&
                        !IsIconic(selection.focus.window);
                }
                return focus.window == selection.focus.window &&
                    (!selection.focus.control || focus.control == selection.focus.control);
            };
            auto bounds = selection.range && matches() ? boundsFor(selection.range.Get(), selection.text, from, to) : "null";
            std::lock_guard<std::mutex> lock(stateMutex);
            focus = foreground();
            if (!matches()) bounds = "null";
            highlighted = bounds == "null" ? WindowFocus{} : (ours(focus.window) ? selection.focus : focus);
            send("{\"type\":\"rect\",\"request\":" + std::to_string(request) + ",\"bounds\":" + bounds + "}");
        }
    }
    running = false;
    tracker.join();
    selection = {};
    options.Reset();
    automation.Reset();
    CoUninitialize();
}
