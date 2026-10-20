import Foundation

/// One top-level task or bot, and whether it or any agent working under it is busy right now.
struct WorkEntry {
    let id: String
    let name: String
    let isWorking: Bool
    /// The agents with a turn in flight: the entry's own agent first, then its working subtasks.
    /// The row's elapsed time is the turn of the first of them whose start is known.
    let workingAgentIds: [String]
}

/// Which quota window this is, in the order a row shows its gauges from left to right. Fable's
/// allowance never gets a gauge; it is only ever named in the tooltip.
enum PlanWindowKind: Int, Comparable {
    case session
    case week
    case month
    case fable

    var label: String {
        switch self {
        case .session: return "Session"
        case .week: return "Week"
        case .month: return "Month"
        case .fable: return "Fable"
        }
    }

    static func < (left: PlanWindowKind, right: PlanWindowKind) -> Bool {
        left.rawValue < right.rawValue
    }
}

/// One named quota window: how much is spent, and when it starts over.
struct PlanWindow {
    let kind: PlanWindowKind
    let usedPercent: Double
    let resetsAt: Date?

    /// What is left, the way a battery reads: 100 when nothing is spent, 0 when it is gone.
    var remainingPercent: Double { min(max(100 - usedPercent, 0), 100) }
    var isFull: Bool { usedPercent >= 100 }
}

/// One provider account's plan: the windows its row draws as gauges, and Claude's separate Fable
/// allowance, which has no gauge of its own. An account with no reading yet has no windows and
/// draws as a placeholder in its place.
struct PlanEntry {
    let providerId: String
    let vendorType: String
    let vendor: String
    let name: String
    let planName: String?
    let windows: [PlanWindow]
    let fable: PlanWindow?
    let exhausted: Bool

    var isPlaceholder: Bool { windows.isEmpty }

    /// Every window the vendor reported that the menu speaks about, in tooltip order.
    var allWindows: [PlanWindow] { windows + (fable.map { [$0] } ?? []) }

    /// The window that holds the account back: while any window is full, Fable included, the one
    /// that resets last, since the account stays blocked until every full window has started over;
    /// otherwise the gauge with the least left.
    var limiting: PlanWindow? {
        let full = allWindows.filter(\.isFull)
        if !full.isEmpty {
            return full.max { ($0.resetsAt ?? .distantPast) < ($1.resetsAt ?? .distantPast) }
        }
        return windows.max { $0.usedPercent < $1.usedPercent }
    }

    var isBlocked: Bool { exhausted || allWindows.contains(where: \.isFull) }

    /// Whether this gauge is the one keeping a blocked account blocked. Fable is a weekly
    /// allowance without a gauge, so when it is the block the week's gauge stands in for it.
    func isBlocking(_ window: PlanWindow) -> Bool {
        guard isBlocked, let limiting else { return false }
        return limiting.kind == window.kind || (limiting.kind == .fable && window.kind == .week)
    }
}

/// The accounts of one vendor, in the order the desktop model picker lists them.
struct PlanVendor {
    let type: String
    let name: String
    let plans: [PlanEntry]
    /// The gauge columns this vendor's rows share, so every row lines up under one header.
    let columns: [PlanWindowKind]
}

/// One account as `/v0/usage` reports it right now, before the menu decides how to show it.
struct PlanReading {
    let providerId: String
    let type: String
    /// The configured friendly name, or `nil` when configuration could not be read this time.
    let name: String?
    /// The latest reading, or `nil` before the first one arrives.
    let entry: PlanEntry?
    /// No reading yet, but the daemon has not finished asking: one is on its way.
    let awaiting: Bool
}

/// Keeps the plan rows still between refreshes.
///
/// The daemon starts with no reading for any account and gets them one at a time; it also drops a
/// window from a reading once that window has reset. Drawn as reported, rows appeared one by one
/// and pushed the others down after every daemon start, and gauges and whole columns came and went
/// at each reset. The book remembers each account's last reading, its name, and every column a
/// vendor has shown, so a row keeps its place and its shape: an account without a reading draws
/// as a placeholder, a reading that lost a window keeps the last one, and a window whose reset has
/// passed shows its full allowance.
struct PlanBook {
    private var readings: [String: PlanEntry] = [:]
    private var names: [String: String] = [:]
    private var shown: Set<String> = []
    private var columns: [String: Set<PlanWindowKind>] = [:]

    /// Vendors whose accounts the daemon can read usage for. Others, such as Bedrock or a pool,
    /// never produce a reading, so they never get a placeholder row either.
    static let readableTypes: Set<String> = ["claude", "codex", "grok"]
    static let defaultColumns: Set<PlanWindowKind> = [.session, .week]

    /// The rows to draw for `accounts`, which arrive in configuration order.
    mutating func update(_ accounts: [PlanReading], now: Date = Date()) -> [PlanVendor] {
        var vendors: [(type: String, plans: [PlanEntry])] = []
        for account in accounts {
            if let name = account.name { names[account.providerId] = name }
            let name = names[account.providerId]
                ?? DaemonSnapshotReader.providerName(account.providerId)
            let previous = readings[account.providerId]
            let entry: PlanEntry
            if let fresh = account.entry {
                entry = PlanBook.carry(fresh, from: previous, now: now).renamed(name)
            } else if let previous {
                entry = PlanBook.carry(previous, from: nil, now: now).renamed(name)
            } else if PlanBook.readableTypes.contains(account.type)
                && (account.awaiting || shown.contains(account.providerId))
            {
                entry = PlanEntry(
                    providerId: account.providerId,
                    vendorType: account.type,
                    vendor: DaemonSnapshotReader.vendorName(account.type),
                    name: name,
                    planName: nil,
                    windows: [],
                    fable: nil,
                    exhausted: false
                )
            } else {
                continue
            }
            if !entry.isPlaceholder { readings[account.providerId] = entry }
            shown.insert(account.providerId)
            columns[account.type, default: []].formUnion(entry.windows.map(\.kind))
            if let index = vendors.firstIndex(where: { $0.type == account.type }) {
                vendors[index].plans.append(entry)
            } else {
                vendors.append((account.type, [entry]))
            }
        }
        return vendors.map { vendor in
            let known = columns[vendor.type] ?? []
            return PlanVendor(
                type: vendor.type,
                name: DaemonSnapshotReader.vendorName(vendor.type),
                plans: vendor.plans,
                columns: (known.isEmpty ? PlanBook.defaultColumns : known).sorted()
            )
        }
    }

    /// `entry` with any window it lacks taken from `previous`, and every window whose reset has
    /// passed shown as a fresh allowance rather than the period that is over.
    private static func carry(
        _ entry: PlanEntry,
        from previous: PlanEntry?,
        now: Date
    ) -> PlanEntry {
        var windows = entry.windows
        for window in previous?.windows ?? []
        where !windows.contains(where: { $0.kind == window.kind }) {
            windows.append(window)
        }
        func current(_ window: PlanWindow) -> PlanWindow {
            guard let reset = window.resetsAt, reset <= now else { return window }
            return PlanWindow(kind: window.kind, usedPercent: 0, resetsAt: nil)
        }
        let reported = windows + ((entry.fable ?? previous?.fable).map { [$0] } ?? [])
        let renewed = windows.sorted { $0.kind < $1.kind }.map(current)
        let fable = (entry.fable ?? previous?.fable).map(current)
        // A spent account is usable again once every full window has reset. One the vendor blocked
        // without a full window has no reset to wait for, so it stays spent until a new reading.
        let wasFull = reported.contains(where: \.isFull)
        let isFull = (renewed + (fable.map { [$0] } ?? [])).contains(where: \.isFull)
        let stillSpent = entry.exhausted && (isFull || !wasFull)
        return PlanEntry(
            providerId: entry.providerId,
            vendorType: entry.vendorType,
            vendor: entry.vendor,
            name: entry.name,
            planName: entry.planName ?? previous?.planName,
            windows: renewed,
            fable: fable,
            exhausted: stillSpent
        )
    }
}

private extension PlanEntry {
    func renamed(_ name: String) -> PlanEntry {
        PlanEntry(
            providerId: providerId,
            vendorType: vendorType,
            vendor: vendor,
            name: name,
            planName: planName,
            windows: windows,
            fable: fable,
            exhausted: exhausted
        )
    }
}

struct TokenTotals {
    var input = 0
    var output = 0

    var total: Int { input + output }
    var isEmpty: Bool { total == 0 }
}

/// Everything the menu draws, as of the last successful read.
struct DaemonSnapshot {
    var connected = false
    var work: [WorkEntry] = []
    var vendors: [PlanVendor] = []
    var day = TokenTotals()

    var working: [WorkEntry] { work.filter(\.isWorking) }
}

/// Reads the daemon's tasks, bots, and usage into the shape the menu draws.
///
/// Tasks and bots are the units a person thinks in, so the menu lists nothing else: a subtask or
/// subagent is not a row of its own but makes the task or bot it works under count as working.
enum DaemonSnapshotReader {
    /// `nil` when the daemon is not answering. A daemon without tasks answers `404` on the task
    /// list, which leaves the bots alone rather than looking like a lost connection.
    ///
    /// Tasks are the person's own list — the joined ones, as the desktop sidebar shows — and only
    /// top-level ones: a task opened by an agent working inside another task belongs to that task's
    /// work, so it is left out the way the task's subtasks are.
    static func work(botsBody: Any?, tasksBody: Any?) -> [WorkEntry]? {
        guard let bots = (botsBody as? [String: Any])?["bots"] as? [[String: Any]] else {
            return nil
        }
        let tasks = (tasksBody as? [String: Any])?["tasks"] as? [[String: Any]] ?? []
        var insideTasks: Set<String> = []
        for task in tasks {
            if let agent = task["agent"] as? [String: Any] { collectAgentIds(agent, into: &insideTasks) }
        }
        let topLevel = tasks.filter { task in
            guard let creator = task["creatorAgentId"] as? String else { return true }
            return !insideTasks.contains(creator)
        }
        return (bots + topLevel).compactMap { row in
            guard let id = row["id"] as? String, row["status"] as? String == "active" else {
                return nil
            }
            let agent = row["agent"] as? [String: Any]
            var working: [String] = []
            if let agent { collectWorkingAgentIds(agent, into: &working) }
            return WorkEntry(
                id: id,
                name: row["name"] as? String ?? "Untitled",
                isWorking: agent.map(isWorking) ?? false,
                workingAgentIds: working
            )
        }
    }

    private static func collectAgentIds(_ agent: [String: Any], into ids: inout Set<String>) {
        if let id = agent["id"] as? String { ids.insert(id) }
        for subtask in agent["subtasks"] as? [[String: Any]] ?? [] {
            collectAgentIds(subtask, into: &ids)
        }
    }

    private static func collectWorkingAgentIds(_ agent: [String: Any], into ids: inout [String]) {
        if let id = agent["id"] as? String, let status = agent["status"] as? String, status != "idle" {
            ids.append(id)
        }
        for subtask in agent["subtasks"] as? [[String: Any]] ?? [] {
            collectWorkingAgentIds(subtask, into: &ids)
        }
    }

    /// An agent is working while it runs a turn, while one of its subagents runs, or while any
    /// subtask under it is working.
    private static func isWorking(_ agent: [String: Any]) -> Bool {
        if let status = agent["status"] as? String, status != "idle" { return true }
        if let subagents = agent["subagents"] as? [String: Any],
            (number(subagents["running"]) ?? 0) > 0
        {
            return true
        }
        let subtasks = agent["subtasks"] as? [[String: Any]] ?? []
        return subtasks.contains(where: isWorking)
    }

    /// When the newest running turn in an agent's history began: the same `startedAt` the desktop
    /// counts its running-turn clock from.
    static func runningTurnStart(messagesBody: Any?) -> Date? {
        let runs = (messagesBody as? [String: Any])?["runs"] as? [[String: Any]] ?? []
        return runs
            .filter { $0["status"] as? String == "running" }
            .compactMap { date($0["startedAt"]) }
            .max()
    }

    /// What a run event says about an agent's turn: the start of the turn now running, or `nil`
    /// when the agent has gone idle. `nil` overall for any other event.
    static func turnChange(type: String, data: String) -> (agentId: String, startedAt: Date?)? {
        guard type.hasPrefix("run."),
            let body = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any],
            let agentId = body["agentId"] as? String
        else { return nil }
        switch type {
        case "run.started":
            return (agentId, date((body["run"] as? [String: Any])?["startedAt"]))
        case "run.boundary":
            return (agentId, date((body["startedRun"] as? [String: Any])?["startedAt"]))
        case "run.finished":
            return (agentId, nil)
        default:
            return nil
        }
    }

    /// Every account in configuration order. `/v0/usage` lists providers in exactly the order of
    /// `/v0/config`, which is the order the desktop model picker uses; the configuration's own
    /// provider map cannot supply it here, because a parsed JSON object has no order. Disabled and
    /// hidden accounts are left out, as the picker leaves them out.
    static func plans(usageBody: Any?, configBody: Any? = nil) -> ([PlanReading], TokenTotals)? {
        guard let body = usageBody as? [String: Any] else { return nil }
        let config = (configBody as? [String: Any])?["config"] as? [String: Any]
        let configured = config?["providers"] as? [String: [String: Any]]
        var readings: [PlanReading] = []
        for provider in body["providers"] as? [[String: Any]] ?? [] {
            guard let id = provider["providerId"] as? String else { continue }
            guard provider["enabled"] as? Bool ?? true else { continue }
            guard !(provider["hidden"] as? Bool ?? configured?[id]?["hidden"] as? Bool ?? false)
            else { continue }
            let type = provider["type"] as? String ?? "unknown"
            let name = configured.map { $0[id]?["name"] as? String ?? providerName(id) }
            var entry: PlanEntry?
            if let usage = provider["usage"] as? [String: Any] {
                let reported = usage["windows"] as? [String: Any]
                let windows = usageWindows(reported)
                if !windows.isEmpty {
                    entry = PlanEntry(
                        providerId: id,
                        vendorType: type,
                        vendor: vendorName(type),
                        name: name ?? providerName(id),
                        planName: (usage["planName"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                        windows: windows,
                        fable: window(reported?["fableWeekly"], kind: .fable),
                        exhausted: usage["exhausted"] as? Bool ?? false
                    )
                }
            }
            let awaiting = provider["refreshing"] as? Bool == true || provider["checkedAt"] is NSNull
                || provider["checkedAt"] == nil
            readings.append(
                PlanReading(providerId: id, type: type, name: name, entry: entry, awaiting: awaiting)
            )
        }
        return (readings, totals(body["day"]))
    }

    /// A configured provider's ID as something to read. A person names their own accounts, so an
    /// unfamiliar ID becomes words rather than being shown as the raw identifier it is.
    static func providerName(_ id: String) -> String {
        switch id {
        case "claude", "codex", "grok": return "Current CLI"
        case "bedrock": return "Bedrock"
        default:
            return id
                .split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == "." })
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    static func vendorName(_ type: String) -> String {
        switch type {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "grok": return "Grok"
        case "bedrock": return "Amazon Bedrock"
        case "smart": return "Pool"
        default: return "Provider"
        }
    }

    /// Every provider shows the same pair: the session and the week when the vendor reports them,
    /// and a monthly window only when there is no session, so a week-and-month pair still has
    /// both. Claude's separate Fable allowance is read on its own and never becomes a gauge.
    private static func usageWindows(_ windows: [String: Any]?) -> [PlanWindow] {
        guard let windows else { return [] }
        var shown: [PlanWindow] = []
        if let session = window(windows["fiveHour"], kind: .session) {
            shown.append(session)
        }
        if let week = window(windows["weekly"], kind: .week) {
            shown.append(week)
        }
        if shown.count < 2, let month = window(windows["monthly"], kind: .month) {
            shown.append(month)
        }
        return shown
    }

    private static func window(_ raw: Any?, kind: PlanWindowKind) -> PlanWindow? {
        guard let body = raw as? [String: Any], let percent = number(body["usedPercent"]) else {
            return nil
        }
        return PlanWindow(kind: kind, usedPercent: percent, resetsAt: date(body["resetsAt"]))
    }

    /// JSONSerialization turns whole numbers into `NSNumber`/`Int`, so a direct `as? Double` misses
    /// the percentages and timestamps a vendor reports as integers.
    private static func number(_ value: Any?) -> Double? {
        if let n = value as? NSNumber { return n.doubleValue }
        if let n = value as? Double { return n }
        if let n = value as? Int { return Double(n) }
        return nil
    }

    private static func date(_ value: Any?) -> Date? {
        guard let ms = number(value) else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    private static func totals(_ window: Any?) -> TokenTotals {
        var totals = TokenTotals()
        guard let providers = window as? [String: Any] else { return totals }
        for models in providers.values {
            guard let models = models as? [String: Any] else { continue }
            for usage in models.values {
                guard let usage = usage as? [String: Any] else { continue }
                totals.input += usage["input"] as? Int ?? 0
                totals.output += usage["output"] as? Int ?? 0
            }
        }
        return totals
    }
}
