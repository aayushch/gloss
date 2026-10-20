//
//  SafariWebExtensionHandler.swift
//  Gloss Extension
//
//  The native side of the Safari extension. Safari hands every
//  `browser.runtime.sendNativeMessage` call to `beginRequest`; the message
//  is one Gloss bridge request, relayed over a loopback TCP connection to
//  the Gloss app, and the app's reply goes back as the response. The
//  connection details come from `bridge.json`, which Gloss writes into the
//  App Group container at launch: `{ "port": 12345, "token": "…" }`.
//  Every connection starts by sending that token as its own line.
//

import Foundation
import SafariServices
import os.log

private let log = OSLog(subsystem: "sh.aay.gloss.extension", category: "bridge")
private let appGroup = "BG78RT6D5Z.sh.aay.gloss"

/// One TCP connection to Gloss, shared by every request. The sandbox allows
/// outgoing network connections, which is what the loopback listener needs.
final class BridgeClient {
    static let shared = BridgeClient()

    private let queue = DispatchQueue(label: "sh.aay.gloss.bridge")
    private var fd: Int32 = -1
    private var buffer = Data()
    /// Events Gloss pushed on the connection while a reply was awaited. The
    /// extension's JavaScript polls for turn text, so these are only logged.
    private var droppedEvents = 0

    struct Info: Decodable {
        let port: UInt16
        let token: String
    }

    /// The candidate locations of `bridge.json`: the App Group container
    /// first, then the Gloss home for a build running without the group
    /// entitlement (an unsigned development build).
    private func infoCandidates() -> [URL] {
        var urls: [URL] = []
        if let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            urls.append(group.appendingPathComponent("bridge.json"))
        }
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            let home = URL(fileURLWithPath: String(cString: dir))
            urls.append(home.appendingPathComponent(".gloss/bridge.json"))
        }
        return urls
    }

    private func readInfo() -> Info? {
        for url in infoCandidates() {
            if let data = try? Data(contentsOf: url), let info = try? JSONDecoder().decode(Info.self, from: data) {
                return info
            }
        }
        return nil
    }

    private func close() {
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
        buffer.removeAll()
    }

    /// Connects and authenticates. Returns false when Gloss is not running
    /// or `bridge.json` is missing.
    private func connect() -> Bool {
        close()
        guard let info = readInfo() else { return false }
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = info.port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let rc = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard rc == 0 else {
            Darwin.close(sock)
            return false
        }
        var timeout = timeval(tv_sec: 60, tv_usec: 0)
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        fd = sock
        return writeLine("{\"token\":\"\(info.token)\"}")
    }

    private func writeLine(_ line: String) -> Bool {
        guard fd >= 0, var data = line.data(using: .utf8) else { return false }
        data.append(0x0A)
        var sent = 0
        while sent < data.count {
            let n = data.withUnsafeBytes { raw -> Int in
                Darwin.send(fd, raw.baseAddress!.advanced(by: sent), data.count - sent, 0)
            }
            if n <= 0 { return false }
            sent += n
        }
        return true
    }

    /// The next complete line from the connection, or nil when it closed.
    private func readLine() -> String? {
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                return String(data: line, encoding: .utf8)
            }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let n = recv(fd, &chunk, chunk.count, 0)
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
        }
    }

    /// Sends one request and returns Gloss's reply for it, skipping pushed
    /// events. When Gloss is not reachable the reply is an `app_not_running`
    /// error in the protocol's own shape.
    func relay(_ request: [String: Any]) -> [String: Any] {
        return queue.sync {
            let id = request["id"] as? String ?? ""
            let method = request["method"] as? String ?? ""
            if method == "launchApp" {
                let launched = launchGloss(request)
                return ["id": id, "result": ["launched": launched, "running": fd >= 0]]
            }
            guard let data = try? JSONSerialization.data(withJSONObject: request),
                  let line = String(data: data, encoding: .utf8) else {
                return ["id": id, "error": ["code": "invalid", "message": "request is not JSON"]]
            }
            // One retry covers a connection Gloss closed since the last call.
            for attempt in 0..<2 {
                if fd < 0 && !connect() {
                    break
                }
                if !writeLine(line) {
                    close()
                    continue
                }
                while let reply = readLine() {
                    guard let obj = try? JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any] else { continue }
                    if obj["id"] as? String == id {
                        return obj
                    }
                    if obj["event"] != nil {
                        droppedEvents += 1
                        continue
                    }
                }
                close()
                if attempt == 1 { break }
            }
            return ["id": id, "error": ["code": "app_not_running", "message": "Gloss is not running"]]
        }
    }

    /// Opens Gloss with a `gloss://` link, which launches it when needed.
    private func launchGloss(_ request: [String: Any]) -> Bool {
        var url = "gloss://open"
        if let params = request["params"] as? [String: Any], let key = params["urlKey"] as? String,
           let encoded = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
            url = "gloss://pages/\(encoded)"
        }
        guard let target = URL(string: url) else { return false }
        let done = DispatchSemaphore(value: 0)
        var ok = false
        NSWorkspace.shared.open(target, configuration: NSWorkspace.OpenConfiguration()) { app, error in
            ok = error == nil
            done.signal()
        }
        _ = done.wait(timeout: .now() + 5)
        return ok
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        os_log(.debug, log: log, "relay %{public}@", message["method"] as? String ?? "?")
        let reply = BridgeClient.shared.relay(message)
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
