import AppKit
import Foundation
import UserNotifications

private let permissionCategory = "PI_PERMISSION"
private let showCategory = "PI_SHOW_ONLY"
private let actionNames = ["accept", "reject", "show"]

struct Callback: Codable {
    let executable: String
    let arguments: [String]
    let environment: [String: String]
}

struct Notice: Codable {
    let title: String
    let body: String
    let actionable: Bool
    let callback: Callback
    let resident: Bool?
}

func validIdentifier(_ id: String) -> Bool {
    UUID(uuidString: id) != nil && !id.contains("/")
}

func actions() -> [UNNotificationAction] {
    [
        UNNotificationAction(identifier: "accept", title: "Accept once", options: [.authenticationRequired]),
        UNNotificationAction(identifier: "reject", title: "Reject", options: [.authenticationRequired, .destructive]),
        UNNotificationAction(identifier: "show", title: "Show", options: [.foreground])
    ]
}

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private let records = Bundle.main.bundleURL.deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("requests", isDirectory: true)
    private var receivedAction = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(identifier: permissionCategory, actions: actions(), intentIdentifiers: [], options: [.customDismissAction]),
            UNNotificationCategory(identifier: showCategory, actions: [actions()[2]], intentIdentifiers: [], options: [.customDismissAction])
        ])
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let operation = args.first, !operation.hasPrefix("-") else {
            // LaunchServices may supply Cocoa flags; activation arrives through the delegate.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                if !self.receivedAction { self.finish(["error": "No action received"], status: 1) }
            }
            return
        }
        switch operation {
        case "status":
            center.getNotificationSettings { settings in
                self.finish(["authorization": settings.authorizationStatus.rawValue, "alertStyle": settings.alertStyle.rawValue])
            }
        case "authorize": authorize { allowed in self.finish(["allowed": allowed], status: allowed ? 0 : 1) }
        case "list":
            center.getDeliveredNotifications { delivered in
                self.center.getPendingNotificationRequests { pending in
                    self.finish(["delivered": delivered.map { $0.request.identifier }, "pending": pending.map { $0.identifier }])
                }
            }
        case "show", "remove":
            guard args.count == 2, validIdentifier(args[1]) else {
                finish(["error": "Invalid request identifier"], status: 1); return
            }
            if operation == "remove" { remove(args[1]); return }
            do {
                let notice = try readNotice(args[1])
                authorize { allowed in
                    guard allowed else { self.finish(["error": "Notifications are disabled"], status: 1); return }
                    // Approval or shutdown may have removed the record while authorization was pending.
                    guard FileManager.default.fileExists(atPath: self.recordURL(args[1]).path) else {
                        self.remove(args[1]); return
                    }
                    self.deliver(args[1], notice: notice) { error in
                        if let error { self.finish(["error": error.localizedDescription], status: 1) }
                        else { self.finish(["delivered": args[1]]) }
                    }
                }
            } catch { finish(["error": error.localizedDescription], status: 1) }
        default: finish(["error": "Unknown operation"], status: 1)
        }
    }

    private func recordURL(_ id: String) -> URL { records.appendingPathComponent(id + ".json") }

    private func readNotice(_ id: String) throws -> Notice {
        guard validIdentifier(id) else { throw NSError(domain: "PiPermissions", code: 1) }
        return try JSONDecoder().decode(Notice.self, from: Data(contentsOf: recordURL(id)))
    }

    private func authorize(_ done: @escaping (Bool) -> Void) {
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                self.center.requestAuthorization(options: [.alert, .sound]) { allowed, _ in done(allowed) }
            } else {
                done(settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional)
            }
        }
    }

    private func deliver(_ id: String, notice: Notice, completion: @escaping (Error?) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = .default
        content.categoryIdentifier = notice.actionable ? permissionCategory : showCategory
        // Callback details stay in the private record, never in Notification Center's payload.
        content.userInfo = ["id": id]
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            // Covers removal racing add(), including a retry after a failed action.
            if !FileManager.default.fileExists(atPath: self.recordURL(id).path) {
                self.center.removePendingNotificationRequests(withIdentifiers: [id])
                self.center.removeDeliveredNotifications(withIdentifiers: [id])
            }
            completion(error)
        }
    }

    private func remove(_ id: String, attempts: Int = 30) {
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.getDeliveredNotifications { delivered in
            self.center.getPendingNotificationRequests { pending in
                let remains = delivered.contains { $0.request.identifier == id } || pending.contains { $0.identifier == id }
                if !remains { self.finish(["removed": id]); return }
                guard attempts > 0 else { self.finish(["error": "Notification removal timed out"], status: 1); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.remove(id, attempts: attempts - 1) }
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        receivedAction = true
        let action = response.actionIdentifier == UNNotificationDismissActionIdentifier ? "dismiss" :
            (response.actionIdentifier == UNNotificationDefaultActionIdentifier ? "show" : response.actionIdentifier)
        guard actionNames.contains(action) || action == "dismiss", let id = response.notification.request.content.userInfo["id"] as? String,
              let notice = try? readNotice(id), action == "show" || (action == "dismiss" ? notice.resident == true : notice.actionable) else {
            completionHandler(); finish(["ignored": true]); return
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: notice.callback.executable)
        task.arguments = notice.callback.arguments + [action]
        task.environment = ProcessInfo.processInfo.environment.merging(notice.callback.environment) { _, requested in requested }
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        task.terminationHandler = { process in
            completionHandler()
            // A failed/stale decision must never look like an approval; leave the local prompt intact.
            if action != "dismiss", process.terminationStatus != 0, FileManager.default.fileExists(atPath: self.recordURL(id).path) {
                let retry = Notice(title: "Permission still needed", body: "Action failed. Use Show to inspect the request.",
                                   actionable: false, callback: notice.callback, resident: notice.resident)
                self.deliver(id, notice: retry) { _ in self.finish(["error": "Action failed"], status: 1) }
            } else { self.finish(["action": action]) }
        }
        do {
            try task.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { if task.isRunning { task.terminate() } }
        } catch { completionHandler(); finish(["error": error.localizedDescription], status: 1) }
    }

    private func finish(_ result: [String: Any], status: Int32 = 0) {
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
        exit(status)
    }
}

@main
struct Main {
    static func main() {
        if CommandLine.arguments.dropFirst().first == "self-test" {
            precondition(validIdentifier(UUID().uuidString))
            precondition(!validIdentifier("../request"))
            precondition(!validIdentifier(""))
            let registered = actions()
            precondition(registered.map { $0.identifier } == actionNames)
            precondition(registered[0].options.contains(.authenticationRequired))
            precondition(registered[1].options.contains(.authenticationRequired))
            precondition(registered[2].options.contains(.foreground))
            print("{\"actions\":[\"accept\",\"reject\",\"show\"],\"authenticationRequired\":true}")
            return
        }
        let app = NSApplication.shared
        let delegate = Notifier()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}
