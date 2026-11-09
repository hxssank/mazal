import AppKit
import CryptoKit
import Darwin
import LocalAuthentication
import Security
import WebKit

struct LocalNavigation {
    let port: Int

    func permits(_ url: URL) -> Bool {
        if url.scheme == "blob" {
            guard let origin = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
            return permits(origin)
        }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == port
            && url.user == nil && url.password == nil
    }
}

struct DesktopWorkspace {
    enum LockRequest { case begin, wait, stop }

    static func needsSetup(markerExists: Bool, recordsExist: Bool) -> Bool { !markerExists || !recordsExist }
    static func canReveal(authenticated: Bool, active: Bool, sessionReady: Bool) -> Bool { authenticated && active && sessionReady }
    static func canKeepServerOnLock(openingSession: Bool, quitting: Bool) -> Bool { !openingSession && !quitting }

    static func lockRequest(alreadyLocked: Bool, pending: Bool, quitting: Bool) -> LockRequest {
        guard alreadyLocked && pending else { return .begin }
        return quitting ? .stop : .wait
    }
}

struct BackupKeychain {
    static let service = "com.mazal.automatic-backup"

    static func validCredential(_ value: String) -> Bool {
        value.count == 36 && UUID(uuidString: value) != nil
    }

    static func validPassphrase(_ value: String) -> Bool {
        (12...1024).contains(value.utf16.count)
    }

    private static func security(_ arguments: [String], input: Data = Data()) -> (Int32, Data) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = arguments
        let incoming = Pipe(), output = Pipe()
        process.standardInput = incoming
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return (1, Data()) }
        let deadline = DispatchWorkItem { if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: deadline)
        incoming.fileHandleForWriting.write(input)
        try? incoming.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        deadline.cancel()
        return (process.terminationReason == .exit ? process.terminationStatus : 1, data)
    }

    private static func read(_ credential: String) -> (Int32, Data) {
        let result = security(["find-generic-password", "-s", service, "-a", credential, "-w"])
        var data = result.1
        if data.last == 10 { data.removeLast() }
        if result.0 != 0 { return (result.0, Data()) }
        guard let text = String(data: data, encoding: .utf8) else { return (1, Data()) }
        let legacy = "MAZAL-BACKUP-KEY-V1:", current = "MAZAL-BACKUP-KEY-V2:"
        if text.hasPrefix(legacy), let decoded = Data(base64Encoded: String(text.dropFirst(legacy.count))) { return (0, decoded) }
        if text.hasPrefix(current), let decoded = Data(base64Encoded: String(text.dropFirst(current.count))), let secret = String(data: decoded, encoding: .utf16LittleEndian) {
            return (0, Data(secret.utf8))
        }
        return (1, Data())
    }

    static func run(_ arguments: [String]) -> Int32 {
        guard arguments.count == 2, ["get", "set", "delete"].contains(arguments[0]), validCredential(arguments[1]) else {
            FileHandle.standardError.write(Data("Invalid backup Keychain request.\n".utf8))
            return 1
        }
        let result: Int32
        switch arguments[0] {
        case "get":
            let found = read(arguments[1])
            result = found.0
            if result == 44 { return 2 }
            let data = found.1
            if result == 0, !data.isEmpty, data.count <= 4096, String(data: data, encoding: .utf8) != nil {
                FileHandle.standardOutput.write(data)
                return 0
            }
            if result == 0 {
                FileHandle.standardError.write(Data("The saved backup key is invalid.\n".utf8))
                return 1
            }
        case "set":
            var secret = Data()
            do {
                while secret.count <= 4096 {
                    guard let next = try FileHandle.standardInput.read(upToCount: 4097 - secret.count), !next.isEmpty else { break }
                    secret.append(next)
                }
            } catch {
                FileHandle.standardError.write(Data("The backup key could not be read.\n".utf8))
                return 1
            }
            guard secret.count <= 4096, let text = String(data: secret, encoding: .utf8), validPassphrase(text) else {
                FileHandle.standardError.write(Data("The backup key must contain 12 to 1024 characters.\n".utf8))
                return 1
            }
            let existing = read(arguments[1])
            if existing.0 == 0 { return existing.1 == secret ? 0 : 1 }
            guard existing.0 == 44 else { return 1 }
            // Apple's signed utility retains access across builds. UTF-16 keeps the command below its 4096-byte limit.
            guard let encoded = text.data(using: .utf16LittleEndian) else { return 1 }
            let password = "MAZAL-BACKUP-KEY-V2:" + encoded.base64EncodedString()
            let command = "add-generic-password -s \(service) -a \(arguments[1]) -T /usr/bin/security -w \(password)\n"
            guard command.utf8.count < 4096 else { return 1 }
            let added = security(["-i"], input: Data(command.utf8)).0
            guard added == 0 else {
                FileHandle.standardError.write(Data("Mazal could not save the backup key in macOS Keychain. Status \(added).\n".utf8))
                return 1
            }
            let verified = read(arguments[1])
            result = verified.0 == 0 && verified.1 == secret ? 0 : 1
        default:
            result = security(["delete-generic-password", "-s", service, "-a", arguments[1]]).0
            if result == 44 { return 0 }
        }
        if result == 0 { return 0 }
        FileHandle.standardError.write(Data("Mazal could not access the backup key in macOS Keychain. Status \(result).\n".utf8))
        return 1
    }
}

struct BackupFolderAccess {
    static func permits(unlocked: Bool, mainFrame: Bool, mainWebView: Bool, scheme: String, host: String, sourcePort: Int, appPort: Int) -> Bool {
        unlocked && mainFrame && mainWebView && scheme == "http" && host == "127.0.0.1" && sourcePort == appPort
    }
}

struct DesktopDrafts {
    enum Decision { case proceed, confirm, busy, unavailable, cancelled }
    static let query = "(() => { const status = { ready: false, dirty: false, busy: false }; window.dispatchEvent(new CustomEvent('mazal:check-drafts', { detail: status })); const event = new Event('beforeunload', { cancelable: true }); if (!window.dispatchEvent(event)) status.dirty = true; return status; })()"

    static func decision(_ value: Any?) -> Decision {
        guard let status = value as? [String: Any], status["ready"] as? Bool == true, let dirty = status["dirty"] as? Bool, let busy = status["busy"] as? Bool else { return .unavailable }
        return busy ? .busy : dirty ? .confirm : .proceed
    }
}

struct LocalAgentAccess {
    static func isEnabled(at url: URL) -> Bool {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o777 == 0o600,
              info.st_size >= 64, info.st_size <= 129 else { return false }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        guard let data = try? handle.read(upToCount: 130), let value = String(data: data, encoding: .utf8) else { return false }
        let secret = value.hasSuffix("\n") ? String(value.dropLast()) : value
        return (64...128).contains(secret.utf8.count) && secret.utf8.allSatisfy { (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }
    }
}

struct LocalAgentService {
    enum RecoveryAction { case restart, checkReady, wait }
    static let retryDelays: [TimeInterval] = [1, 2, 5]
    private(set) var retryCount = 0
    private var readyAt: TimeInterval?

    static func canStart(credentialValid: Bool, workspaceReady: Bool, locked: Bool, serverAbsent: Bool, quitting: Bool) -> Bool {
        credentialValid && workspaceReady && locked && serverAbsent && !quitting
    }

    static func recoveryAction(serverExists: Bool, running: Bool, locked: Bool, stopping: Bool) -> RecoveryAction {
        if !serverExists { return .restart }
        return running && locked && !stopping ? .checkReady : .wait
    }

    mutating func becameReady(now: TimeInterval) {
        if readyAt == nil { readyAt = now }
    }

    mutating func nextRetryDelay(now: TimeInterval) -> TimeInterval? {
        if let readyAt, now >= readyAt + 60 { retryCount = 0 }
        readyAt = nil
        guard retryCount < Self.retryDelays.count else { return nil }
        let delay = Self.retryDelays[retryCount]
        retryCount += 1
        return delay
    }

    mutating func reset() { retryCount = 0; readyAt = nil }
}

struct AuthenticationHandoff {
    private var success: (generation: UUID, acceptedAt: TimeInterval)?
    var isPending: Bool { success != nil }

    mutating func recordSuccess(generation: UUID, now: TimeInterval) {
        success = (generation, now)
    }

    mutating func clear() { success = nil }

    mutating func consume(generation: UUID, now: TimeInterval, isActive: Bool) -> Bool {
        guard let accepted = success else { return false }
        guard accepted.generation == generation, now >= accepted.acceptedAt, now < accepted.acceptedAt + 10 else {
            clear()
            return false
        }
        guard isActive else { return false }
        clear()
        return true
    }
}

final class LocalSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class MazalApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandlerWithReply {
    private enum State { case locked, authenticating, starting, unlocked }
    private let port = 5196
    private let dataStore = WKWebsiteDataStore.default()
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration, delegate: LocalSessionDelegate(), delegateQueue: nil)
    }()
    private let supportDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Mazal", isDirectory: true)
    private var state = State.locked
    private var generation = UUID()
    private var authenticationHandoff = AuthenticationHandoff()
    private var context: LAContext?
    private var server: Process?
    private var serverToken: String?
    private var serverLocked = false
    private var revokingSession = false
    private var stoppingServer = false
    private var serverLog: FileHandle?
    private var window: NSWindow!
    private var webView: WKWebView?
    private var restoreOnOpen = false
    private var recordsLoaded = false
    private var documentWindows: [NSWindow] = []
    private var downloads: [WKDownload] = []
    private var downloadLocations: [ObjectIdentifier: (temporary: URL, destination: URL)] = [:]
    private var unlockButton: NSButton!
    private var statusLabel: NSTextField!
    private var eventMonitor: Any?
    private var idleTimer: Timer?
    private var lastInteraction = Date()
    private var quitting = false
    private var checkingDrafts = false
    private var clearingCookies = false
    private var agentService = LocalAgentService()
    private var agentRestart: DispatchWorkItem?
    private var agentRestartGeneration = UUID()
    private var agentReadiness = UUID()
    private var agentReadinessDeadline: Date?

    private var canAuthenticate: Bool { !quitting && !clearingCookies && !revokingSession && !stoppingServer && (server == nil || serverLocked) }
    private var canStartAgentService: Bool {
        let data = supportDirectory.appendingPathComponent("data", isDirectory: true)
        return LocalAgentService.canStart(
            credentialValid: LocalAgentAccess.isEnabled(at: supportDirectory.appendingPathComponent("local-agent-token")),
            workspaceReady: !DesktopWorkspace.needsSetup(markerExists: FileManager.default.fileExists(atPath: data.appendingPathComponent(".desktop-only").path), recordsExist: FileManager.default.fileExists(atPath: data.appendingPathComponent("live.sqlite").path)),
            locked: state == .locked, serverAbsent: server == nil, quitting: quitting)
    }

    private var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let background = CommandLine.arguments.contains("--agent-service")
        if background && !canStartAgentService {
            fputs("Mazal automation requires existing protected records and a valid private local-agent credential.\n", stderr)
            exit(EXIT_FAILURE)
        }
        installMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Mazal"
        window.minSize = NSSize(width: 760, height: 600)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        showLock("Use Touch ID or your Mac login password to open your financial records.")
        if !background {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(lockForSleep), name: NSWorkspace.willSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(lockForSleep), name: NSWorkspace.screensDidSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(lockForSleep), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]) { [weak self] event in
            self?.lastInteraction = Date()
            return event
        }
        idleTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self, self.state == .unlocked, Date().timeIntervalSince(self.lastInteraction) >= 15 * 60 else { return }
            self.lock(message: "Mazal locked after 15 minutes without activity.")
        }
        if LocalAgentAccess.isEnabled(at: supportDirectory.appendingPathComponent("local-agent-token")) {
            startServer(keepingLocked: true)
        } else { DispatchQueue.main.async { [weak self] in self?.unlock() } }
    }

    func applicationDidResignActive(_ notification: Notification) {
        if state == .unlocked || state == .starting { lock(message: "Mazal locked when you switched away.") }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        completeAuthenticationHandoff()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        if canStartAgentService {
            cancelAgentRestart()
            agentService.reset()
            startServer(keepingLocked: true)
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting else { return .terminateLater }
        guard !checkingDrafts else { return .terminateCancel }
        checkingDrafts = true
        DispatchQueue.main.async { [weak self] in
            self?.confirmDiscard(action: "quit") { [weak self] approved in
                guard let self else { NSApp.reply(toApplicationShouldTerminate: false); return }
                self.checkingDrafts = false
                guard approved else { NSApp.reply(toApplicationShouldTerminate: false); return }
                self.quitting = true
                self.cancelAgentRestart()
                self.lock(message: "Closing Mazal…")
                if self.server == nil { NSApp.reply(toApplicationShouldTerminate: true) }
            }
        }
        return .terminateLater
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === window, !quitting else { return true }
        NSApp.terminate(nil)
        return false
    }

    func windowWillClose(_ notification: Notification) {
        guard let document = notification.object as? NSWindow, document !== window else { return }
        if let view = document.contentView as? WKWebView {
            view.stopLoading()
            view.navigationDelegate = nil
            view.uiDelegate = nil
        }
        document.delegate = nil
        document.contentView = nil
        documentWindows.removeAll { $0 === document }
    }

    private func confirmDiscard(action: String, completion: @escaping (Bool) -> Void) {
        guard let view = webView, recordsLoaded else { completion(true); return }
        let attempt = generation
        readDrafts(view, attempt: attempt) { [weak self, weak view] decision in
            guard let self, let view else { completion(false); return }
            switch decision {
            case .proceed:
                completion(true)
            case .cancelled:
                completion(false)
            case .busy:
                self.showError("Wait for the current save", detail: "Mazal is still saving or reading a file. Finish that operation before you \(action).")
                completion(false)
            case .unavailable, .confirm:
                let alert = NSAlert()
                alert.messageText = decision == .unavailable ? "Mazal could not check unsaved entries" : "Discard unsaved entries and \(action)?"
                alert.informativeText = (decision == .unavailable ? "The page did not answer. If you \(action), unsaved entries may be lost and an unfinished save may need confirmation. " : "Entries you have not saved will be lost. ") + "Check your records before entering an uncertain save again."
                alert.addButton(withTitle: decision == .unavailable ? "Keep open" : "Keep editing")
                alert.addButton(withTitle: "Discard and \(action)")
                alert.beginSheetModal(for: self.window) { [weak self, weak view] result in
                    guard result == .alertSecondButtonReturn, let self, let view, view === self.webView, self.generation == attempt else { completion(false); return }
                    if decision == .unavailable { completion(true); return }
                    self.readDrafts(view, attempt: attempt) { latest in
                        completion(latest == .proceed || latest == .confirm)
                    }
                }
            }
        }
    }

    private func readDrafts(_ view: WKWebView, attempt: UUID, completion: @escaping (DesktopDrafts.Decision) -> Void) {
        var finished = false
        let finish: (DesktopDrafts.Decision) -> Void = { [weak self, weak view] decision in
            guard !finished else { return }
            finished = true
            guard let self, let view, view === self.webView, self.generation == attempt else { completion(.cancelled); return }
            completion(decision)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish(.unavailable) }
        view.evaluateJavaScript(DesktopDrafts.query) { value, error in
            finish(error == nil ? DesktopDrafts.decision(value) : .unavailable)
        }
    }

    private func installMenu() {
        let menu = NSMenu()
        let appMenu = NSMenu()
        let root = NSMenuItem()
        root.submenu = appMenu
        menu.addItem(root)
        appMenu.addItem(withTitle: "About Mazal", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        let lockItem = appMenu.addItem(withTitle: "Lock Mazal", action: #selector(lockFromMenu), keyEquivalent: "l")
        lockItem.keyEquivalentModifierMask = [.command, .shift]
        appMenu.addItem(withTitle: "Show data folder", action: #selector(showDataFolder), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Mazal", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", Selector(("undo:")), "z"), ("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] {
            editMenu.addItem(withTitle: title, action: action, keyEquivalent: key)
        }
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        edit.submenu = editMenu
        menu.addItem(edit)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        let view = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        view.submenu = viewMenu
        menu.addItem(view)
        NSApp.mainMenu = menu
    }

    private func showLock(_ message: String) {
        guard window != nil else { return }
        let background = NSView()
        background.appearance = NSAppearance(named: .darkAqua)
        background.wantsLayer = true
        background.layer?.backgroundColor = NSColor(calibratedRed: 0.055, green: 0.09, blue: 0.13, alpha: 1).cgColor
        let title = NSTextField(labelWithString: "Mazal")
        title.font = .systemFont(ofSize: 42, weight: .semibold)
        title.textColor = .white
        title.alignment = .center
        let symbol = NSImageView(image: NSImage(systemSymbolName: "lock.shield", accessibilityDescription: "Locked")!)
        symbol.contentTintColor = NSColor(calibratedRed: 0.64, green: 0.88, blue: 0.80, alpha: 1)
        symbol.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 42, weight: .regular)
        statusLabel = NSTextField(wrappingLabelWithString: message)
        statusLabel.textColor = NSColor(calibratedWhite: 0.8, alpha: 1)
        statusLabel.font = .systemFont(ofSize: 15)
        statusLabel.alignment = .center
        unlockButton = NSButton(title: "Unlock Mazal", target: self, action: #selector(unlock))
        unlockButton.bezelStyle = .rounded
        unlockButton.controlSize = .large
        unlockButton.keyEquivalent = "\r"
        unlockButton.isEnabled = canAuthenticate
        let stack = NSStackView(views: [symbol, title, statusLabel, unlockButton])
        stack.orientation = .vertical
        stack.spacing = 22
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: background.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            stack.widthAnchor.constraint(equalToConstant: 460),
            statusLabel.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        window.contentView = background
    }

    @objc private func unlock() {
        guard state == .locked, canAuthenticate else { return }
        cancelAgentRestart()
        agentService.reset()
        agentReadiness = UUID()
        let authentication = LAContext()
        authentication.localizedCancelTitle = "Keep locked"
        authentication.touchIDAuthenticationAllowableReuseDuration = 0
        var error: NSError?
        guard authentication.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            showLock("Mac authentication is unavailable. Set a Mac login password in System Settings, then reopen Mazal.")
            resumeAgentService()
            return
        }
        state = .authenticating
        generation = UUID()
        authenticationHandoff.clear()
        unlockButton.isEnabled = false
        statusLabel.stringValue = "Confirm with Touch ID or your Mac login password."
        context = authentication
        let attempt = generation
        authentication.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "open your Mazal financial records") { [weak self] success, _ in
            DispatchQueue.main.async {
                guard let self, self.generation == attempt, self.state == .authenticating else { return }
                self.context = nil
                guard success else {
                    self.state = .locked
                    self.showLock("Mazal is locked. Use Touch ID or your Mac login password to continue.")
                    self.resumeAgentService()
                    return
                }
                self.authenticationHandoff.recordSuccess(generation: attempt, now: ProcessInfo.processInfo.systemUptime)
                self.statusLabel.stringValue = "Authentication accepted. Return to Mazal to open your records."
                self.completeAuthenticationHandoff()
                DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                    guard let self, self.generation == attempt else { return }
                    self.completeAuthenticationHandoff()
                }
            }
        }
    }

    private func completeAuthenticationHandoff() {
        guard state == .authenticating, authenticationHandoff.isPending, !quitting else { return }
        if authenticationHandoff.consume(generation: generation, now: ProcessInfo.processInfo.systemUptime, isActive: NSApp.isActive) {
            startServer()
        } else if !authenticationHandoff.isPending {
            lock(message: "Mazal is locked. Unlock again when you are ready to open your records.")
        }
    }

    private func startServer(keepingLocked: Bool = false) {
        guard !quitting, keepingLocked ? canStartAgentService : state == .authenticating && NSApp.isActive else {
            if keepingLocked { return }
            lock(message: "Return to Mazal and unlock to continue.")
            return
        }
        cancelAgentRestart()
        if let existing = server, existing.isRunning, serverLocked, let token = serverToken {
            state = .starting
            serverLocked = false
            pollReady(token: token, attempt: generation, deadline: Date().addingTimeInterval(5))
            return
        }
        let dataDirectory = supportDirectory.appendingPathComponent("data", isDirectory: true)
        let marker = dataDirectory.appendingPathComponent(".desktop-only")
        if DesktopWorkspace.needsSetup(markerExists: FileManager.default.fileExists(atPath: marker.path), recordsExist: FileManager.default.fileExists(atPath: dataDirectory.appendingPathComponent("live.sqlite").path)) {
            if keepingLocked { return }
            let setup = NSAlert()
            setup.messageText = "Set up Mazal on this Mac"
            setup.informativeText = "Create financial records or open the backup restore screen. Existing files stay on this Mac. Complete backups restore records, original documents, and calculation evidence together."
            setup.addButton(withTitle: "Restore a backup")
            setup.addButton(withTitle: "Create or open records")
            setup.addButton(withTitle: "Keep locked")
            let choice = setup.runModal()
            guard choice != .alertThirdButtonReturn, state == .authenticating, NSApp.isActive else { lock(message: "Mazal is locked."); return }
            restoreOnOpen = choice == .alertFirstButtonReturn
            do {
                try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try Data("Mazal desktop authentication required.\n".utf8).write(to: marker, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
            } catch { fail("Mazal could not prepare its data folder. Your existing files were kept."); return }
        }
        guard let resources = Bundle.main.resourceURL else { fail("Mazal's bundled runtime is missing. Reinstall the app."); return }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { fail("macOS could not create a private session. Reopen Mazal."); return }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        let child = Process()
        child.executableURL = resources.appendingPathComponent("runtime/node")
        child.arguments = ["--disable-warning=ExperimentalWarning", "server/index.ts"]
        child.currentDirectoryURL = resources.appendingPathComponent("app", isDirectory: true)
        child.environment = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": NSTemporaryDirectory(), "LANG": "en_CA.UTF-8", "NODE_ENV": "production",
            "PORT": String(port), "MAZAL_DATA_DIR": dataDirectory.path, "MAZAL_DESKTOP_TOKEN": token,
            "MAZAL_DESKTOP_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier),
            "MAZAL_ENGINE_AUTOSTART": "1", "PYTHONDONTWRITEBYTECODE": "1",
            "XDG_CACHE_HOME": supportDirectory.appendingPathComponent("cache").path,
            "MPLCONFIGDIR": supportDirectory.appendingPathComponent("cache/matplotlib").path,
            "MAZAL_KEYCHAIN_HELPER": Bundle.main.executableURL?.path ?? CommandLine.arguments[0]
        ]
        do {
            let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Mazal", isDirectory: true)
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let logURL = logs.appendingPathComponent("desktop.log")
            if let size = try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? NSNumber, size.intValue > 2_000_000 {
                let previous = logs.appendingPathComponent("desktop.previous.log")
                try? FileManager.default.removeItem(at: previous)
                try FileManager.default.moveItem(at: logURL, to: previous)
            }
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let log = try FileHandle(forWritingTo: logURL)
            try log.seekToEnd()
            serverLog = log
            child.standardOutput = log
            child.standardError = log
            child.standardInput = FileHandle.nullDevice
            child.terminationHandler = { [weak self, weak child] _ in
                DispatchQueue.main.async {
                    guard let self, let child, self.server === child else { return }
                    self.server = nil
                    self.serverToken = nil
                    self.serverLocked = false
                    self.agentReadiness = UUID()
                    self.agentReadinessDeadline = nil
                    self.revokingSession = false
                    self.stoppingServer = false
                    try? self.serverLog?.close()
                    self.serverLog = nil
                    if self.quitting { NSApp.reply(toApplicationShouldTerminate: true); return }
                    if self.state == .starting || self.state == .unlocked {
                        self.lock(message: "Mazal stopped unexpectedly. Your saved records are still on this Mac. Unlock to retry. If it repeats, check Library/Logs/Mazal/desktop.log.")
                    } else { self.unlockButton?.isEnabled = self.canAuthenticate }
                    self.scheduleAgentRecovery()
                }
            }
            server = child
            serverToken = token
            serverLocked = keepingLocked
            state = keepingLocked ? .locked : .starting
            statusLabel.stringValue = keepingLocked ? "Mazal is locked. Starting trusted local automation…" : "Opening your saved records…"
            try child.run()
            if keepingLocked {
                unlockButton.isEnabled = canAuthenticate
                agentReadiness = UUID()
                agentReadinessDeadline = Date().addingTimeInterval(30)
                pollAgentReady(child, token: token, attempt: agentReadiness, deadline: agentReadinessDeadline!)
            }
            else { pollReady(token: token, attempt: generation, deadline: Date().addingTimeInterval(30)) }
        } catch {
            server = nil
            serverToken = nil
            serverLocked = false
            try? serverLog?.close()
            serverLog = nil
            fail("Mazal could not start its local server. Check Library/Logs/Mazal/desktop.log and reopen the app.")
        }
    }

    private func cancelAgentRestart() {
        agentRestart?.cancel()
        agentRestart = nil
        agentRestartGeneration = UUID()
    }

    private func resumeAgentService() {
        guard state == .locked, !quitting else { return }
        switch LocalAgentService.recoveryAction(serverExists: server != nil, running: server?.isRunning == true, locked: serverLocked, stopping: stoppingServer) {
        case .restart:
            scheduleAgentRecovery()
        case .checkReady:
            guard let child = server, let token = serverToken else { return }
            agentReadiness = UUID()
            let deadline = agentReadinessDeadline ?? Date().addingTimeInterval(30)
            agentReadinessDeadline = deadline
            pollAgentReady(child, token: token, attempt: agentReadiness, deadline: deadline)
        case .wait:
            break
        }
    }

    private func scheduleAgentRecovery() {
        guard canStartAgentService, agentRestart == nil else { return }
        guard let delay = agentService.nextRetryDelay(now: ProcessInfo.processInfo.systemUptime) else {
            showLock("Mazal is locked. Local automation could not restart after 3 retries. Reopen Mazal or unlock to retry. Check Library/Logs/Mazal/desktop.log if it repeats.")
            return
        }
        showLock("Mazal is locked. Restarting trusted local automation in \(Int(delay)) seconds.")
        let attempt = UUID()
        agentRestartGeneration = attempt
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.agentRestartGeneration == attempt else { return }
            self.agentRestart = nil
            guard self.canStartAgentService else {
                if self.state == .locked, self.server == nil, !self.quitting {
                    self.showLock("Mazal is locked. Local automation is unavailable because its private credential or saved records are unavailable.")
                }
                return
            }
            self.startServer(keepingLocked: true)
        }
        agentRestart = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func pollAgentReady(_ child: Process, token: String, attempt: UUID, deadline: Date) {
        guard agentReadiness == attempt, server === child, child.isRunning, state == .locked, !quitting, !stoppingServer else { return }
        guard LocalAgentAccess.isEnabled(at: supportDirectory.appendingPathComponent("local-agent-token")) else {
            showLock("Mazal is locked. Trusted local automation is disabled because its private credential is unavailable.")
            stopServer(child)
            return
        }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/desktop/health"))
        request.timeoutInterval = 1
        session.dataTask(with: request) { [weak self, weak child] data, response, _ in
            DispatchQueue.main.async {
                guard let self, let child, self.agentReadiness == attempt, self.server === child, child.isRunning, self.state == .locked, !self.quitting, !self.stoppingServer else { return }
                guard LocalAgentAccess.isEnabled(at: self.supportDirectory.appendingPathComponent("local-agent-token")) else {
                    self.showLock("Mazal is locked. Trusted local automation is disabled because its private credential is unavailable.")
                    self.stopServer(child)
                    return
                }
                if let http = response as? HTTPURLResponse, http.statusCode == 200, let data,
                   let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any], body["ready"] as? Bool == true {
                    let expected = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
                    guard body["instance"] as? String == expected else {
                        self.showLock("Mazal is locked. Another service is using port 5196. Local automation is unavailable.")
                        self.stopServer(child)
                        return
                    }
                    self.agentService.becameReady(now: ProcessInfo.processInfo.systemUptime)
                    self.agentReadinessDeadline = nil
                    self.statusLabel.stringValue = "Mazal is locked. Trusted local automation can access your saved records."
                    return
                }
                if Date() < deadline {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak child] in
                        guard let self, let child else { return }
                        self.pollAgentReady(child, token: token, attempt: attempt, deadline: deadline)
                    }
                } else {
                    self.showLock("Mazal is locked. Its local server did not become ready. Local automation is unavailable.")
                    self.stopServer(child)
                }
            }
        }.resume()
    }

    private func pollReady(token: String, attempt: UUID, deadline: Date) {
        guard generation == attempt, state == .starting else { return }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/desktop/health"))
        request.timeoutInterval = 1
        session.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self, self.generation == attempt, self.state == .starting else { return }
                if let http = response as? HTTPURLResponse, http.statusCode == 200, let data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], json["ready"] as? Bool == true {
                    let expected = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
                    guard json["instance"] as? String == expected else {
                        self.fail("Another service is using Mazal's local port 5196. Close that service and unlock Mazal again.")
                        return
                    }
                    self.createSession(token: token, attempt: attempt)
                } else if Date() < deadline {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.pollReady(token: token, attempt: attempt, deadline: deadline) }
                } else { self.fail("Mazal's local server did not become ready. Check whether another copy is using port 5196, then unlock to retry.") }
            }
        }.resume()
    }

    private func createSession(token: String, attempt: UUID) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/desktop/session"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
        request.timeoutInterval = 5
        session.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self, self.generation == attempt, self.state == .starting else { return }
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { self.fail("Mazal could not establish a private session. Unlock to retry."); return }
                let headers = http.allHeaderFields.reduce(into: [String: String]()) { result, pair in result[String(describing: pair.key)] = String(describing: pair.value) }
                let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: self.baseURL)
                guard let cookie = cookies.first(where: { $0.name == "mazal_desktop_session" && $0.isHTTPOnly && $0.path == "/" && $0.domain == "127.0.0.1" }) else {
                    self.fail("Mazal refused an invalid session. Reinstall the app if this continues.")
                    return
                }
                self.dataStore.httpCookieStore.setCookie(cookie) {
                    guard self.generation == attempt, self.state == .starting, NSApp.isActive else { return }
                    self.openRecords()
                }
            }
        }.resume()
    }

    private func makeWebView(configuration: WKWebViewConfiguration? = nil) -> WKWebView {
        let config = configuration ?? WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.userContentController.removeScriptMessageHandler(forName: "mazalBackupFolder", contentWorld: .page)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "mazalBackupFolder")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        return view
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.name == "mazalBackupFolder", let body = message.body as? [String: String], body == ["action": "chooseBackupFolder"],
              BackupFolderAccess.permits(unlocked: state == .unlocked, mainFrame: message.frameInfo.isMainFrame, mainWebView: message.webView === webView, scheme: origin.protocol, host: origin.host, sourcePort: origin.port, appPort: port), window.attachedSheet == nil else {
            replyHandler(nil, "Choose the backup folder from the unlocked Mazal window.")
            return
        }
        let attempt = generation
        let panel = NSOpenPanel()
        panel.title = "Choose automatic backup folder"
        panel.prompt = "Use this folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self, self.generation == attempt, self.state == .unlocked, result == .OK, let destination = panel.url else { replyHandler(NSNull(), nil); return }
            let records = self.supportDirectory.appendingPathComponent("data").standardizedFileURL.resolvingSymlinksInPath().path
            let selected = destination.standardizedFileURL.resolvingSymlinksInPath().path
            guard selected != records, !selected.hasPrefix(records + "/") else { replyHandler(nil, "Choose a folder outside Mazal's data folder."); return }
            replyHandler(selected, nil)
        }
    }

    private func openRecords() {
        guard DesktopWorkspace.canReveal(authenticated: state == .starting, active: NSApp.isActive, sessionReady: server?.isRunning == true) else { return }
        let retained = webView != nil && recordsLoaded
        let view = (retained ? webView : nil) ?? makeWebView()
        if !retained { recordsLoaded = false }
        webView = view
        state = .unlocked
        agentReadinessDeadline = nil
        agentService.becameReady(now: ProcessInfo.processInfo.systemUptime)
        window.contentView = view
        view.isHidden = false
        lastInteraction = Date()
        if retained {
            view.evaluateJavaScript("window.dispatchEvent(new Event('focus'))", completionHandler: nil)
        } else {
            let destination = restoreOnOpen ? URL(string: "/?setup=restore", relativeTo: baseURL)! : baseURL
            restoreOnOpen = false
            view.load(URLRequest(url: destination))
        }
    }

    @objc private func lockForSleep() { lock(message: "Mazal locked when this Mac went to sleep or changed users.") }
    @objc private func lockFromMenu() { lock(message: "Mazal is locked.") }
    @objc private func reload() {
        guard state == .unlocked, !checkingDrafts else { return }
        checkingDrafts = true
        confirmDiscard(action: "reload") { [weak self] approved in
            guard let self else { return }
            self.checkingDrafts = false
            if approved, self.state == .unlocked { self.webView?.reload() }
        }
    }
    @objc private func showDataFolder() { NSWorkspace.shared.open(supportDirectory.appendingPathComponent("data")) }
    @objc private func showAbout() {
        let alert = NSAlert()
        let version = Bundle.main.object(forInfoDictionaryKey: "MazalReleaseVersion") as? String ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown version"
        let source = Bundle.main.object(forInfoDictionaryKey: "MazalSourceSHA256") as? String
        alert.messageText = "Mazal \(version)"
        let identity = source.map { "Build \($0.prefix(12)).\n\n" } ?? ""
        alert.informativeText = identity + "Your records stay in Library/Application Support/Mazal/data. Mazal locks when you switch away, when this Mac sleeps, or after 15 minutes without activity. Unlock with Touch ID or your Mac login password."
        alert.runModal()
    }

    private func fail(_ message: String) { lock(message: message) }

    private func lock(message: String) {
        // Keep pending callbacks valid. A second revocation or cookie clear could erase the next session.
        switch DesktopWorkspace.lockRequest(alreadyLocked: state == .locked, pending: revokingSession || clearingCookies || stoppingServer, quitting: quitting) {
        case .wait:
            showLock(message)
            return
        case .stop:
            if let child = server, child.isRunning { stopServer(child) }
            showLock(message)
            return
        case .begin:
            break
        }
        let keepServer = DesktopWorkspace.canKeepServerOnLock(openingSession: state == .starting, quitting: quitting)
        generation = UUID()
        let attempt = generation
        authenticationHandoff.clear()
        state = .locked
        context?.invalidate()
        context = nil
        clearingCookies = true
        for download in downloads { download.cancel { [weak self] _ in self?.discardDownload(download) } }
        downloads.removeAll()
        if let sheet = window?.attachedSheet { window.endSheet(sheet, returnCode: .cancel) }
        webView?.isHidden = true
        if quitting {
            webView?.stopLoading()
            webView?.navigationDelegate = nil
            webView?.uiDelegate = nil
            webView = nil
        }
        let documents = documentWindows
        documentWindows.removeAll()
        for document in documents {
            (document.contentView as? WKWebView)?.stopLoading()
            if let sheet = document.attachedSheet { document.endSheet(sheet, returnCode: .cancel) }
            document.close()
        }
        showLock(message)
        dataStore.removeData(ofTypes: [WKWebsiteDataTypeCookies], modifiedSince: .distantPast) { [weak self] in
            guard let self, self.generation == attempt else { return }
            self.clearingCookies = false
            self.unlockButton?.isEnabled = self.canAuthenticate
        }
        session.configuration.httpCookieStorage?.removeCookies(since: .distantPast)
        if let child = server, child.isRunning {
            // An unfinished session request can arrive after revocation. Stop its server to invalidate both.
            if keepServer, !stoppingServer, let token = serverToken {
                revokingSession = true
                unlockButton?.isEnabled = false
                var request = URLRequest(url: baseURL.appendingPathComponent("api/desktop/lock"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
                request.timeoutInterval = 2
                session.dataTask(with: request) { [weak self, weak child] _, response, _ in
                    DispatchQueue.main.async {
                        guard let self, let child, self.generation == attempt, self.server === child, !self.stoppingServer else { return }
                        self.revokingSession = false
                        if (response as? HTTPURLResponse)?.statusCode == 200 {
                            self.serverLocked = true
                            self.unlockButton?.isEnabled = self.canAuthenticate
                            if LocalAgentAccess.isEnabled(at: self.supportDirectory.appendingPathComponent("local-agent-token")) { self.resumeAgentService() }
                        } else { self.stopServer(child) }
                    }
                }.resume()
            } else { stopServer(child) }
        } else { scheduleAgentRecovery() }
    }

    private func stopServer(_ child: Process) {
        guard !stoppingServer else { return }
        stoppingServer = true
        agentReadiness = UUID()
        agentReadinessDeadline = nil
        serverLocked = false
        unlockButton?.isEnabled = false
        child.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            if child.isRunning { Darwin.kill(child.processIdentifier, SIGKILL) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard state == .unlocked, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if LocalNavigation(port: port).permits(url) {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard state == .unlocked, let url = navigationResponse.response.url, LocalNavigation(port: port).permits(url) else { decisionHandler(.cancel); return }
        if let response = navigationResponse.response as? HTTPURLResponse, response.statusCode == 401 { decisionHandler(.cancel); lock(message: "Your private session ended. Unlock Mazal to continue."); return }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(!navigationResponse.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard state == .unlocked, let url = navigationAction.request.url, LocalNavigation(port: port).permits(url) else { return nil }
        let view = makeWebView(configuration: configuration)
        let document = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        document.title = "Mazal source document"
        document.delegate = self
        document.isReleasedWhenClosed = false
        document.contentView = view
        document.center()
        document.makeKeyAndOrderFront(nil)
        documentWindows.append(document)
        return view
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === self.webView { recordsLoaded = true }
    }

    func webViewDidClose(_ webView: WKWebView) { webView.window?.close() }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { registerDownload(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { registerDownload(download) }
    private func registerDownload(_ download: WKDownload) { downloads.append(download); download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard state == .unlocked else { completionHandler(nil); return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .OK, self.state == .unlocked, let destination = panel.url else { completionHandler(nil); return }
            let records = self.supportDirectory.appendingPathComponent("data").standardizedFileURL.resolvingSymlinksInPath().path
            let selected = destination.standardizedFileURL.resolvingSymlinksInPath().path
            guard !selected.hasPrefix(records + "/") else {
                completionHandler(nil)
                self.showError("Choose a location outside Mazal’s data folder.", detail: "Use Downloads or an external drive so restoring records cannot replace the backup.")
                return
            }
            let temporary = destination.deletingLastPathComponent().appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).download")
            self.downloadLocations[ObjectIdentifier(download)] = (temporary, destination)
            completionHandler(temporary)
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let location = downloadLocations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        downloads.removeAll { $0 === download }
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: location.temporary.path)
            if FileManager.default.fileExists(atPath: location.destination.path) {
                _ = try FileManager.default.replaceItemAt(location.destination, withItemAt: location.temporary)
            } else { try FileManager.default.moveItem(at: location.temporary, to: location.destination) }
        } catch {
            try? FileManager.default.removeItem(at: location.temporary)
            if state == .unlocked { showError("The file could not be saved.", detail: error.localizedDescription) }
        }
    }
    private func discardDownload(_ download: WKDownload) {
        if let location = downloadLocations.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: location.temporary) }
        downloads.removeAll { $0 === download }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        discardDownload(download)
        if state == .unlocked { showError("The file could not be saved.", detail: error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard state == .unlocked else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: webView.window ?? window) { [weak self] result in
            completionHandler(result == .OK && self?.state == .unlocked ? panel.urls : nil)
        }
    }

    private func showError(_ message: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.beginSheetModal(for: window)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard state == .unlocked else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = "Mazal"
        alert.informativeText = message
        alert.beginSheetModal(for: webView.window ?? window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard state == .unlocked else { completionHandler(false); return }
        let alert = NSAlert()
        alert.messageText = "Mazal"
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: webView.window ?? window) { [weak self] result in completionHandler(result == .alertFirstButtonReturn && self?.state == .unlocked) }
    }
}

if CommandLine.arguments.dropFirst().first == "--backup-keychain" {
    exit(BackupKeychain.run(Array(CommandLine.arguments.dropFirst(2))))
} else if CommandLine.arguments.contains("--self-test") {
    precondition(BackupKeychain.validCredential("11111111-1111-4111-8111-111111111111"))
    for value in ["", "../key", "token", "11111111-1111-4111-8111-111111111111\n", "11111111111141118111111111111111"] { precondition(!BackupKeychain.validCredential(value)) }
    for value in [String(repeating: "a", count: 12), String(repeating: "😀", count: 6), String(repeating: "a\u{0301}", count: 6), String(repeating: "漢", count: 1024), String(repeating: "😀", count: 512)] { precondition(BackupKeychain.validPassphrase(value)) }
    for value in [String(repeating: "a", count: 11), String(repeating: "😀", count: 5), String(repeating: "a", count: 1025), String(repeating: "😀", count: 513)] { precondition(!BackupKeychain.validPassphrase(value)) }
    precondition(BackupFolderAccess.permits(unlocked: true, mainFrame: true, mainWebView: true, scheme: "http", host: "127.0.0.1", sourcePort: 5196, appPort: 5196))
    for allowed in [false, true] {
        precondition(BackupFolderAccess.permits(unlocked: allowed, mainFrame: true, mainWebView: true, scheme: "http", host: "127.0.0.1", sourcePort: 5196, appPort: 5196) == allowed)
        precondition(BackupFolderAccess.permits(unlocked: true, mainFrame: allowed, mainWebView: true, scheme: "http", host: "127.0.0.1", sourcePort: 5196, appPort: 5196) == allowed)
        precondition(BackupFolderAccess.permits(unlocked: true, mainFrame: true, mainWebView: allowed, scheme: "http", host: "127.0.0.1", sourcePort: 5196, appPort: 5196) == allowed)
    }
    precondition(!BackupFolderAccess.permits(unlocked: true, mainFrame: true, mainWebView: true, scheme: "https", host: "127.0.0.1", sourcePort: 5196, appPort: 5196))
    precondition(!BackupFolderAccess.permits(unlocked: true, mainFrame: true, mainWebView: true, scheme: "http", host: "localhost", sourcePort: 5196, appPort: 5196))
    precondition(!BackupFolderAccess.permits(unlocked: true, mainFrame: true, mainWebView: true, scheme: "http", host: "127.0.0.1", sourcePort: 5191, appPort: 5196))
    precondition(DesktopDrafts.decision(nil) == .unavailable)
    precondition(DesktopDrafts.decision(["ready": true, "dirty": "yes", "busy": false]) == .unavailable)
    precondition(DesktopDrafts.decision(["dirty": false, "busy": false]) == .unavailable)
    precondition(DesktopDrafts.decision(["ready": false, "dirty": false, "busy": false]) == .unavailable)
    precondition(DesktopDrafts.decision(["ready": true, "dirty": false, "busy": false]) == .proceed)
    precondition(DesktopDrafts.decision(["ready": true, "dirty": true, "busy": false]) == .confirm)
    precondition(DesktopDrafts.decision(["ready": true, "dirty": false, "busy": true]) == .busy)
    precondition(DesktopDrafts.decision(["ready": true, "dirty": true, "busy": true]) == .busy)
    let credentialDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("mazal-local-agent-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: credentialDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: credentialDirectory) }
    let credential = credentialDirectory.appendingPathComponent("local-agent-token")
    precondition(!LocalAgentAccess.isEnabled(at: credential))
    try Data((String(repeating: "a", count: 64) + "\n").utf8).write(to: credential)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: credential.path)
    precondition(LocalAgentAccess.isEnabled(at: credential))
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: credential.path)
    precondition(!LocalAgentAccess.isEnabled(at: credential))
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: credential.path)
    for value in [String(repeating: "b", count: 63), String(repeating: "b", count: 129), String(repeating: "z", count: 64), String(repeating: "b", count: 64) + "\n\n"] {
        try Data(value.utf8).write(to: credential)
        precondition(!LocalAgentAccess.isEnabled(at: credential))
    }
    try Data(String(repeating: "C", count: 128).utf8).write(to: credential)
    precondition(LocalAgentAccess.isEnabled(at: credential))
    let linkedCredential = credentialDirectory.appendingPathComponent("linked-token")
    try FileManager.default.createSymbolicLink(at: linkedCredential, withDestinationURL: credential)
    precondition(!LocalAgentAccess.isEnabled(at: linkedCredential))
    precondition(!LocalAgentAccess.isEnabled(at: credentialDirectory))
    precondition(LocalAgentService.canStart(credentialValid: true, workspaceReady: true, locked: true, serverAbsent: true, quitting: false))
    precondition(!LocalAgentService.canStart(credentialValid: false, workspaceReady: true, locked: true, serverAbsent: true, quitting: false))
    precondition(!LocalAgentService.canStart(credentialValid: true, workspaceReady: false, locked: true, serverAbsent: true, quitting: false))
    precondition(!LocalAgentService.canStart(credentialValid: true, workspaceReady: true, locked: false, serverAbsent: true, quitting: false))
    precondition(!LocalAgentService.canStart(credentialValid: true, workspaceReady: true, locked: true, serverAbsent: false, quitting: false))
    precondition(!LocalAgentService.canStart(credentialValid: true, workspaceReady: true, locked: true, serverAbsent: true, quitting: true))
    precondition(LocalAgentService.recoveryAction(serverExists: true, running: true, locked: true, stopping: false) == .checkReady)
    precondition(LocalAgentService.recoveryAction(serverExists: false, running: false, locked: false, stopping: false) == .restart)
    precondition(LocalAgentService.recoveryAction(serverExists: true, running: true, locked: true, stopping: true) == .wait)
    precondition(LocalAgentService.recoveryAction(serverExists: true, running: false, locked: true, stopping: false) == .wait)
    precondition(LocalAgentService.recoveryAction(serverExists: true, running: true, locked: false, stopping: false) == .wait)
    var agentService = LocalAgentService()
    precondition(agentService.nextRetryDelay(now: 100) == 1)
    agentService.becameReady(now: 101)
    precondition(agentService.nextRetryDelay(now: 102) == 2)
    agentService.becameReady(now: 104)
    precondition(agentService.nextRetryDelay(now: 105) == 5)
    agentService.becameReady(now: 110)
    precondition(agentService.nextRetryDelay(now: 111) == nil)
    precondition(agentService.nextRetryDelay(now: 1000) == nil)
    agentService.becameReady(now: 1001)
    agentService.becameReady(now: 1030)
    precondition(agentService.nextRetryDelay(now: 1061) == 1)
    agentService.reset()
    precondition(agentService.retryCount == 0)
    precondition(agentService.nextRetryDelay(now: 1062) == 1)
    precondition(!DesktopWorkspace.needsSetup(markerExists: true, recordsExist: true))
    precondition(DesktopWorkspace.needsSetup(markerExists: false, recordsExist: false))
    precondition(DesktopWorkspace.needsSetup(markerExists: true, recordsExist: false))
    precondition(DesktopWorkspace.needsSetup(markerExists: false, recordsExist: true))
    precondition(DesktopWorkspace.canKeepServerOnLock(openingSession: false, quitting: false))
    precondition(!DesktopWorkspace.canKeepServerOnLock(openingSession: true, quitting: false))
    precondition(!DesktopWorkspace.canKeepServerOnLock(openingSession: false, quitting: true))
    precondition(!DesktopWorkspace.canKeepServerOnLock(openingSession: true, quitting: true))
    precondition(DesktopWorkspace.lockRequest(alreadyLocked: true, pending: true, quitting: false) == .wait)
    precondition(DesktopWorkspace.lockRequest(alreadyLocked: true, pending: true, quitting: true) == .stop)
    for quitting in [false, true] {
        precondition(DesktopWorkspace.lockRequest(alreadyLocked: false, pending: false, quitting: quitting) == .begin)
        precondition(DesktopWorkspace.lockRequest(alreadyLocked: false, pending: true, quitting: quitting) == .begin)
        precondition(DesktopWorkspace.lockRequest(alreadyLocked: true, pending: false, quitting: quitting) == .begin)
    }
    for authenticated in [false, true] {
        for active in [false, true] {
            for ready in [false, true] { precondition(DesktopWorkspace.canReveal(authenticated: authenticated, active: active, sessionReady: ready) == (authenticated && active && ready)) }
        }
    }
    let policy = LocalNavigation(port: 5196)
    let accepted = ["http://127.0.0.1:5196/", "http://127.0.0.1:5196/api/documents/a/content?workspace=live", "blob:http://127.0.0.1:5196/abc"]
    let rejected = ["https://127.0.0.1:5196/", "http://127.0.0.1:5191/", "http://localhost:5196/", "http://127.0.0.1.evil.example:5196/", "http://user:secret@127.0.0.1:5196/", "file:///etc/passwd", "javascript:alert(1)", "blob:https://example.com/abc"]
    for value in accepted { precondition(policy.permits(URL(string: value)!)) }
    for value in rejected { precondition(!policy.permits(URL(string: value)!)) }
    let attempt = UUID()
    var handoff = AuthenticationHandoff()
    precondition(!handoff.consume(generation: attempt, now: 100, isActive: true))
    handoff.recordSuccess(generation: attempt, now: 100)
    precondition(!handoff.consume(generation: attempt, now: 100.1, isActive: false))
    precondition(handoff.isPending)
    precondition(handoff.consume(generation: attempt, now: 109.9, isActive: true))
    precondition(!handoff.consume(generation: attempt, now: 109.9, isActive: true))
    handoff.recordSuccess(generation: attempt, now: 100)
    precondition(!handoff.consume(generation: attempt, now: 110, isActive: true))
    precondition(!handoff.isPending)
    handoff.recordSuccess(generation: attempt, now: 100)
    precondition(!handoff.consume(generation: UUID(), now: 101, isActive: true))
    precondition(!handoff.isPending)
    handoff.recordSuccess(generation: attempt, now: 100)
    handoff.clear()
    precondition(!handoff.consume(generation: attempt, now: 101, isActive: true))
    handoff.recordSuccess(generation: attempt, now: 100)
    precondition(!handoff.consume(generation: attempt, now: 99, isActive: true))
    precondition(!handoff.isPending)
    handoff.recordSuccess(generation: attempt, now: 100)
    precondition(!handoff.consume(generation: attempt, now: 111, isActive: false))
    precondition(!handoff.isPending)
    print("Mazal desktop navigation, local access, and authentication handoff checks passed.")
} else {
    let application = NSApplication.shared
    let delegate = MazalApp()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
}
