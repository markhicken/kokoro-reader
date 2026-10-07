// kokoro-helper: long-lived Accessibility helper for Kokoro Reader.
//
// Line-delimited JSON over stdin/stdout. Never touches the clipboard.
//
// Requests:
//   {"cmd":"capture"}                         read the frontmost app's selection
//   {"cmd":"highlight","from":N,"to":M,"text":"word"}
//                                             overlay the word at UTF-16 offsets [from, to)
//                                             of the captured text, in the source app
//   {"cmd":"clear"}                           hide the overlay
// Responses:
//   {"type":"capture","ok":true,"text":"...","sourceHighlight":true}
//   {"type":"capture","ok":false,"error":"untrusted"|"noselection"}
import AppKit
import ApplicationServices

// MARK: - IO

func log(_ msg: String) {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
}

func send(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

// MARK: - AX helpers

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func param(_ el: AXUIElement, _ name: String, _ arg: CFTypeRef) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyParameterizedAttributeValue(el, name as CFString, arg, &value) == .success ? value : nil
}

func rectValue(_ v: CFTypeRef?) -> CGRect? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var rect = CGRect.zero
    guard AXValueGetValue(v as! AXValue, .cgRect, &rect), rect.width > 0, rect.height > 0 else { return nil }
    return rect
}

func rangeValue(_ v: CFTypeRef?) -> CFRange? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(v as! AXValue, .cfRange, &range) ? range : nil
}

// MARK: - Making apps expose their accessibility tree

/// App whose AXEnhancedUserInterface we switched on; restored when reading ends.
var enhancedApp: AXUIElement?

/// Chromium (Chrome, Edge, Brave, Arc), Electron and Firefox only build a full AX tree
/// when an assistive app asks for it. Spoken Content and VoiceOver do this too.
/// Returns true if anything was switched on (the app needs a moment to build the tree).
func requestAccessibility(_ app: AXUIElement) -> Bool {
    var changed = false
    // Electron-specific switch; harmless elsewhere.
    if (attr(app, "AXManualAccessibility") as? Bool) != true,
       AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
        changed = true
    }
    // Chromium/Firefox switch. It can slow window animations, so it's reverted after reading.
    if (attr(app, "AXEnhancedUserInterface") as? Bool) == false,
       AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success {
        enhancedApp = app
        changed = true
    }
    return changed
}

func restoreAccessibility() {
    if let app = enhancedApp {
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
    }
    enhancedApp = nil
}

func focusedElement(in app: AXUIElement) -> AXUIElement? {
    if let el = attr(app, kAXFocusedUIElementAttribute) { return (el as! AXUIElement) }
    let system = AXUIElementCreateSystemWide()
    if let el = attr(system, kAXFocusedUIElementAttribute) { return (el as! AXUIElement) }
    return nil
}

// MARK: - Source location of the captured selection

private typealias CopyStartMarker = @convention(c) (CFTypeRef) -> Unmanaged<CFTypeRef>?
private let copyStartMarker: CopyStartMarker? = {
    guard let h = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW), let f = dlsym(h, "AXTextMarkerRangeCopyStartMarker") else { return nil }
    return unsafeBitCast(f, to: CopyStartMarker.self)
}()

private let copyEndMarker: CopyStartMarker? = {
    guard let h = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW), let f = dlsym(h, "AXTextMarkerRangeCopyEndMarker") else { return nil }
    return unsafeBitCast(f, to: CopyStartMarker.self)
}()

/// Earliest marker of a selection. A right-to-left selection yields a reversed range
/// whose "start" is really its end, so order the two ends first.
func earliestMarker(_ el: AXUIElement, _ range: CFTypeRef) -> CFTypeRef? {
    guard let a = startMarker(el, range) else { return nil }
    guard let end = param(el, "AXEndTextMarkerForTextMarkerRange", range) ?? copyEndMarker?(range)?.takeRetainedValue(),
          let ordered = param(el, "AXTextMarkerRangeForUnorderedTextMarkers", [a, end] as CFArray),
          let first = startMarker(el, ordered) else { return a }
    return first
}

/// Start marker of a marker range. Newer macOS no longer advertises the
/// AXStartTextMarkerForTextMarkerRange attribute, so fall back to the C function.
func startMarker(_ el: AXUIElement, _ range: CFTypeRef) -> CFTypeRef? {
    if let m = param(el, "AXStartTextMarkerForTextMarkerRange", range) { return m }
    return copyStartMarker?(range)?.takeRetainedValue()
}

/// Text-marker based text (WebKit, Chromium, Firefox). Positions are UTF-16 offsets
/// relative to the selection start. Uses marker indices when the app supports them
/// (WebKit), otherwise walks marker-by-marker from the selection start (Chromium).
final class MarkerText {
    let el: AXUIElement
    private var startIndex: Int?
    private var cursor: CFTypeRef
    private var cursorPos = 0
    /// Correction for drift between the selected string and marker positions
    /// (collapsed whitespace, line breaks, list bullets).
    var delta = 0

    init?(_ el: AXUIElement) {
        guard let markers = attr(el, "AXSelectedTextMarkerRange") else {
            log("markers: AXSelectedTextMarkerRange is nil")
            return nil
        }
        guard let start = earliestMarker(el, markers) else {
            log("markers: could not get start marker (no AXStartTextMarkerForTextMarkerRange, no C fallback)")
            return nil
        }
        self.el = el
        cursor = start
        startIndex = param(el, "AXIndexForTextMarker", start) as? Int
    }

    var mode: String { startIndex == nil ? "walk" : "index" }

    func marker(_ pos: Int) -> CFTypeRef? {
        if let s = startIndex {
            return s + pos < 0 ? nil : param(el, "AXTextMarkerForIndex", (s + pos) as CFNumber)
        }
        while cursorPos < pos {
            guard let next = param(el, "AXNextTextMarkerForTextMarker", cursor) else { return nil }
            cursor = next
            cursorPos += 1
        }
        while cursorPos > pos {
            guard let prev = param(el, "AXPreviousTextMarkerForTextMarker", cursor) else { return nil }
            cursor = prev
            cursorPos -= 1
        }
        return cursor
    }

    func range(_ a: Int, _ b: Int) -> CFTypeRef? {
        guard let m1 = marker(a), let m2 = marker(b) else { return nil }
        return param(el, "AXTextMarkerRangeForUnorderedTextMarkers", [m1, m2] as CFArray)
    }

    func string(_ a: Int, _ b: Int) -> String? {
        range(a, b).flatMap { param(el, "AXStringForTextMarkerRange", $0) as? String }
    }

    /// Bounds of `text`, expected at [from, to). Verifies the word and re-syncs nearby if it drifted.
    func rect(from: Int, to: Int, text: String) -> CGRect? {
        let len = to - from
        var a = from + delta
        if startIndex != nil, string(a, a + len) != text, string(a - 40, a + len + 40)?.contains(text) != true {
            // Index lookups don't line up with this app (some Chromium builds): walk markers instead.
            diag("index mode failed for \"\(text)\" at \(a); switching to walk")
            startIndex = nil
            delta = 0
            a = from
        }
        if string(a, a + len) != text {
            let pad = 40
            let lo = a - pad
            guard let window = string(lo, a + len + pad), let hit = nearest(text, in: window, to: pad) else {
                diag("resync failed for \"\(text)\" at \(a)")
                return nil
            }
            delta += lo + hit - a
            a = lo + hit
        }
        guard let r = range(a, a + len) else { return nil }
        return rectValue(param(el, "AXBoundsForTextMarkerRange", r))
    }

    /// UTF-16 offset of the occurrence of `needle` in `hay` closest to `target`.
    private func nearest(_ needle: String, in hay: String, to target: Int) -> Int? {
        let h = Array(hay.utf16), n = Array(needle.utf16)
        guard !n.isEmpty, h.count >= n.count else { return nil }
        var best: Int?
        for i in 0...(h.count - n.count) where Array(h[i..<(i + n.count)]) == n {
            if best == nil || abs(i - target) < abs(best! - target) { best = i }
        }
        return best
    }
}

enum Source {
    /// Standard text element: selection start as a UTF-16 index.
    case range(AXUIElement, Int)
    /// Web content (WebKit, Chromium, Firefox) via text markers.
    case markers(MarkerText)
}

var source: Source?
/// App and focused element the current selection was captured from.
var sourcePid: pid_t?
var sourceElement: AXUIElement?
/// Log the first highlight failure per capture, to diagnose apps that don't cooperate.
var loggedFailure = false

func diag(_ msg: String) {
    if loggedFailure { return }
    loggedFailure = true
    log("highlight: \(msg)")
}

func locateSelection(_ el: AXUIElement) -> Source? {
    if let range = rangeValue(attr(el, kAXSelectedTextRangeAttribute)) {
        var p = CFRange(location: range.location, length: 1) // probe: can this element report bounds?
        if let arg = AXValueCreate(.cfRange, &p), rectValue(param(el, kAXBoundsForRangeParameterizedAttribute, arg)) != nil {
            return .range(el, range.location)
        }
    }
    if let text = MarkerText(el) { return .markers(text) }
    return nil
}

func selectedText(_ el: AXUIElement) -> String? {
    if let text = attr(el, kAXSelectedTextAttribute) as? String, !text.isEmpty { return text }
    if let markers = attr(el, "AXSelectedTextMarkerRange"),
       let text = param(el, "AXStringForTextMarkerRange", markers) as? String, !text.isEmpty {
        return text
    }
    return nil
}

func describe(_ el: AXUIElement) -> String {
    var names: CFArray?
    AXUIElementCopyParameterizedAttributeNames(el, &names)
    let params = (names as? [String]) ?? []
    let role = attr(el, kAXRoleAttribute) as? String ?? "?"
    let hasRange = attr(el, kAXSelectedTextRangeAttribute) != nil
    let hasMarkers = attr(el, "AXSelectedTextMarkerRange") != nil
    return "role=\(role) selectedRange=\(hasRange) selectedMarkers=\(hasMarkers) params=[\(params.joined(separator: ","))]"
}

// MARK: - Commands

func waitForModifierRelease() {
    let mask: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand]
    for _ in 0..<100 {
        if CGEventSource.flagsState(.combinedSessionState).intersection(mask).isEmpty { return }
        usleep(10_000)
    }
}

func capture() {
    overlay.hide()
    restoreAccessibility()
    source = nil
    sourcePid = nil
    sourceElement = nil
    loggedFailure = false
    guard AXIsProcessTrusted() else {
        send(["type": "capture", "ok": false, "error": "untrusted"])
        return
    }
    waitForModifierRelease()
    guard let front = NSWorkspace.shared.frontmostApplication else {
        send(["type": "capture", "ok": false, "error": "noselection"])
        return
    }
    let appName = front.bundleIdentifier ?? front.localizedName ?? "?"
    let app = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 0.5)

    var el = focusedElement(in: app)
    var text = el.flatMap(selectedText)
    var located = el.flatMap(locateSelection)
    // Partial or missing AX tree: ask the app to build it fully, then retry.
    if (text == nil || located == nil) && requestAccessibility(app) {
        for _ in 0..<10 {
            usleep(100_000)
            el = focusedElement(in: app)
            text = el.flatMap(selectedText)
            located = el.flatMap(locateSelection)
            if text != nil && located != nil { break }
        }
    }

    guard let el, let text else {
        log("capture[\(appName)]: no selection via Accessibility\(el.map { " — " + describe($0) } ?? " — no focused element")")
        restoreAccessibility()
        send(["type": "capture", "ok": false, "error": "noselection"])
        return
    }
    source = located
    sourcePid = front.processIdentifier
    sourceElement = el
    let how: String
    switch located {
    case .range?: how = "range"
    case let .markers(m)?: how = "markers/\(m.mode)"
    case nil: how = "none — " + describe(el)
    }
    log("capture[\(appName)]: \(text.utf16.count) chars, source=\(how)")
    send(["type": "capture", "ok": true, "text": text, "sourceHighlight": located != nil])
}

/// True while the captured selection is still what the user is looking at: its app is
/// frontmost and its element still has focus (a tab switch changes the focused web area).
func sourceStillVisible() -> Bool {
    guard let pid = sourcePid, let el = sourceElement else { return false }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return false }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    guard let focused = focusedElement(in: app) else { return false }
    return CFEqual(focused, el)
}

func wordRect(from: Int, to: Int, text: String) -> CGRect? {
    guard sourceStillVisible() else {
        diag("source no longer frontmost/focused; hiding")
        return nil
    }
    switch source {
    case let .range(el, start)?:
        var range = CFRange(location: start + from, length: to - from)
        guard let arg = AXValueCreate(.cfRange, &range) else { return nil }
        let rect = rectValue(param(el, kAXBoundsForRangeParameterizedAttribute, arg))
        if rect == nil { diag("no bounds for range \(start + from)+\(to - from)") }
        return rect
    case let .markers(m)?:
        let rect = m.rect(from: from, to: to, text: text)
        if rect == nil { diag("no bounds for \"\(text)\" (\(m.mode))") }
        return rect
    case nil:
        return nil
    }
}

// MARK: - Overlay

final class Overlay {
    private let window: NSWindow

    init() {
        window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.systemYellow.withAlphaComponent(0.38).cgColor
        view.layer?.cornerRadius = 4
        view.layer?.borderColor = NSColor.systemOrange.withAlphaComponent(0.6).cgColor
        view.layer?.borderWidth = 1
        window.contentView = view
    }

    /// `rect` is in AX coordinates (origin at top-left of the primary screen).
    func show(_ rect: CGRect) {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let pad: CGFloat = 2
        let frame = NSRect(
            x: rect.minX - pad,
            y: primaryHeight - rect.maxY - pad,
            width: rect.width + 2 * pad,
            height: rect.height + 2 * pad
        )
        if window.isVisible {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.08
                window.animator().setFrame(frame, display: true)
            }
        } else {
            window.setFrame(frame, display: true)
            window.orderFrontRegardless()
        }
    }

    func hide() {
        window.orderOut(nil)
    }
}

// MARK: - Main

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let overlay = Overlay()
// Hide the highlight as soon as another app comes to the front.
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
    let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    if let pid = sourcePid, app?.processIdentifier != pid { overlay.hide() }
}

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let cmd = msg["cmd"] as? String else { return }
    switch cmd {
    case "capture":
        capture()
    case "highlight":
        guard let from = msg["from"] as? Int, let to = msg["to"] as? Int, let text = msg["text"] as? String else { return }
        if let rect = wordRect(from: from, to: to, text: text) { overlay.show(rect) } else { overlay.hide() }
    case "clear":
        overlay.hide()
        restoreAccessibility()
    default:
        break
    }
}

Thread {
    while let line = readLine() {
        DispatchQueue.main.async { handle(line) }
    }
    DispatchQueue.main.async { exit(0) }
}.start()

app.run()
