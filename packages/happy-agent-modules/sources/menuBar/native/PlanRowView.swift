import AppKit

/// One provider account on a single line: its name, its plan in a column of its own, a small gauge
/// for each window, and when the window holding it back starts over.
///
/// A gauge reads like a battery — the ring and the number are what is left, not what is spent —
/// and turns yellow when little is left and red when almost nothing is. The row never highlights
/// and never accepts a click; it is a readout inside the menu.
final class PlanRowView: NSView {
    private let entry: PlanEntry
    private let columns: [PlanWindowKind]
    private let planWidth: CGFloat

    /// `planWidth` is the vendor's plan column, shared by every row under the same header.
    init(entry: PlanEntry, columns: [PlanWindowKind], planWidth: CGFloat) {
        self.entry = entry
        self.columns = columns
        self.planWidth = planWidth
        super.init(
            frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: MenuMetrics.rowHeight)
        )
        autoresizingMask = [.width]
        toolTip = PlanRowView.tooltip(entry)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlanRowView is created in code.")
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let layout = PlanColumns(columns: columns, planWidth: planWidth, width: bounds.width)
        let limiting = entry.limiting
        for (index, kind) in columns.enumerated() {
            guard let window = entry.windows.first(where: { $0.kind == kind }) else {
                // An account still waiting for its first reading keeps its place with empty rings.
                if entry.isPlaceholder { drawEmptyGauge(in: layout.gauge(index)) }
                continue
            }
            let level = GaugeLevel(window: window, blocked: entry.isBlocking(window))
            drawGauge(window: window, level: level, in: layout.gauge(index))
        }

        if let reset = limiting?.resetsAt {
            drawLine(
                resetPhrase(reset),
                font: MenuMetrics.detailFont,
                color: entry.isBlocked ? .systemRed : .secondaryLabelColor,
                in: layout.reset,
                alignment: .right
            )
        }

        // The name gives way first: it is cut short before the plan column, and the plan only
        // within its own column, so the gauges never move.
        drawLine(
            entry.name,
            font: MenuMetrics.font,
            color: .labelColor,
            in: NSRect(
                x: MenuMetrics.inset,
                y: 0,
                width: max(0, layout.namesEnd - MenuMetrics.inset),
                height: bounds.height
            )
        )
        if let planName = entry.planName, let cell = layout.plan {
            drawLine(planName, font: MenuMetrics.planFont, color: .secondaryLabelColor, in: cell)
        }
    }

    /// The share left, right-aligned against its ring, so rings line up down the column and
    /// every number sits right beside its own.
    private func drawEmptyGauge(in cell: NSRect) {
        let diameter = MenuMetrics.gaugeDiameter
        let track = NSBezierPath(ovalIn: NSRect(
            x: cell.maxX - diameter,
            y: cell.midY - diameter / 2,
            width: diameter,
            height: diameter
        ).insetBy(dx: MenuMetrics.gaugeLine / 2, dy: MenuMetrics.gaugeLine / 2))
        track.lineWidth = MenuMetrics.gaugeLine
        NSColor.quaternaryLabelColor.setStroke()
        track.stroke()
        drawLine(
            "–",
            font: MenuMetrics.detailFont,
            color: .tertiaryLabelColor,
            in: NSRect(
                x: cell.minX,
                y: 0,
                width: cell.width - diameter - MenuMetrics.gaugeTextGap,
                height: bounds.height
            ),
            alignment: .right
        )
    }

    private func drawGauge(window: PlanWindow, level: GaugeLevel, in cell: NSRect) {
        let diameter = MenuMetrics.gaugeDiameter
        let ring = NSRect(
            x: cell.maxX - diameter,
            y: cell.midY - diameter / 2,
            width: diameter,
            height: diameter
        ).insetBy(dx: MenuMetrics.gaugeLine / 2, dy: MenuMetrics.gaugeLine / 2)
        let track = NSBezierPath(ovalIn: ring)
        track.lineWidth = MenuMetrics.gaugeLine
        NSColor.quaternaryLabelColor.setStroke()
        track.stroke()

        let remaining = window.remainingPercent / 100
        if remaining > 0 {
            // Clockwise from twelve o'clock, like every other progress ring. The view is flipped,
            // so increasing angles already run clockwise on screen.
            let arc = NSBezierPath()
            arc.appendArc(
                withCenter: NSPoint(x: ring.midX, y: ring.midY),
                radius: ring.width / 2,
                startAngle: -90,
                endAngle: -90 + 360 * CGFloat(remaining),
                clockwise: false
            )
            arc.lineWidth = MenuMetrics.gaugeLine
            arc.lineCapStyle = remaining < 1 ? .round : .butt
            level.ring.setStroke()
            arc.stroke()
        }

        let text = NSRect(
            x: cell.minX,
            y: 0,
            width: cell.width - diameter - MenuMetrics.gaugeTextGap,
            height: bounds.height
        )
        drawLine(
            "\(Int(window.remainingPercent.rounded()))%",
            font: MenuMetrics.detailFont,
            color: level.text,
            in: text,
            alignment: .right
        )
    }

    /// The account and plan in full, then every window the vendor reported, Fable included, with
    /// its exact local reset time; a blocked account first says until when.
    static func tooltip(_ entry: PlanEntry) -> String {
        let account = [entry.name, entry.planName].compactMap { $0 }.joined(separator: " · ")
        if entry.isPlaceholder { return "\(account)\nWaiting for the first usage reading" }
        var lines = entry.allWindows.map { window -> String in
            let left = "\(window.kind.label): \(Int(window.remainingPercent.rounded()))% left"
            guard let reset = window.resetsAt else { return left }
            return "\(left), resets \(resetPhrase(reset, precise: true))"
        }
        if entry.isBlocked, let limiting = entry.limiting {
            let reached = limiting.isFull ? "\(limiting.kind.label) limit reached" : "Out of usage"
            let reset = limiting.resetsAt.map { ", resets \(resetPhrase($0, precise: true))" } ?? ""
            lines.insert(reached + reset, at: 0)
        }
        return ([account] + lines).joined(separator: "\n")
    }
}

/// A vendor's name above its accounts, with the names of the plan and gauge columns when they
/// differ from the vendor above.
final class PlanHeaderView: NSView {
    private let vendor: PlanVendor
    private let planWidth: CGFloat
    private let labelsColumns: Bool

    init(vendor: PlanVendor, planWidth: CGFloat, labelsColumns: Bool) {
        self.vendor = vendor
        self.planWidth = planWidth
        self.labelsColumns = labelsColumns
        super.init(
            frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: MenuMetrics.headerHeight)
        )
        autoresizingMask = [.width]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlanHeaderView is created in code.")
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let layout = PlanColumns(columns: vendor.columns, planWidth: planWidth, width: bounds.width)
        drawLine(
            columnHeader(vendor.name.uppercased(), kern: 0.6),
            in: line(MenuMetrics.inset, layout.namesEnd - MenuMetrics.inset)
        )
        guard labelsColumns else { return }
        if let plan = layout.plan {
            drawLine(columnHeader("Plan"), in: line(plan.minX, plan.width))
        }
        for (index, kind) in vendor.columns.enumerated() {
            let cell = layout.gauge(index)
            drawLine(columnHeader(kind.label), in: line(cell.minX, cell.width), alignment: .right)
        }
        let reset = layout.reset
        drawLine(columnHeader("Resets"), in: line(reset.minX, reset.width), alignment: .right)
    }

    /// The header's text sits low in its row, close to the accounts it names.
    private func line(_ x: CGFloat, _ width: CGFloat) -> NSRect {
        NSRect(
            x: x,
            y: MenuMetrics.headerTop,
            width: width,
            height: bounds.height - MenuMetrics.headerTop
        )
    }
}

/// A header's small, quiet text: the vendor's name and the names of its columns.
private func columnHeader(_ text: String, kern: CGFloat = 0) -> NSAttributedString {
    NSAttributedString(
        string: text,
        attributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
            .foregroundColor: NSColor.tertiaryLabelColor,
            .kern: kern,
        ]
    )
}

/// Where a vendor's columns sit, measured from the right edge so every vendor's week, session,
/// and reset line up however many columns it has. The plan column sits just left of the gauges,
/// as wide as the vendor's widest plan up to a limit, and the name has whatever is left.
struct PlanColumns {
    let columns: [PlanWindowKind]
    let planWidth: CGFloat
    let width: CGFloat

    var reset: NSRect {
        NSRect(
            x: width - MenuMetrics.inset - PlanColumns.resetWidth,
            y: 0,
            width: PlanColumns.resetWidth,
            height: MenuMetrics.rowHeight
        )
    }

    func gauge(_ index: Int) -> NSRect {
        let fromRight = CGFloat(columns.count - 1 - index)
        let right = reset.minX - MenuMetrics.resetGap
            - fromRight * (PlanColumns.gaugeWidth + MenuMetrics.gaugeGap)
        return NSRect(
            x: right - PlanColumns.gaugeWidth,
            y: 0,
            width: PlanColumns.gaugeWidth,
            height: MenuMetrics.rowHeight
        )
    }

    private var gaugesStart: CGFloat {
        (columns.isEmpty ? reset.minX : gauge(0).minX) - MenuMetrics.resetGap
    }

    /// The plan column, or `nil` when no account under this header has a plan.
    var plan: NSRect? {
        guard planWidth > 0 else { return nil }
        return NSRect(
            x: gaugesStart - planWidth,
            y: 0,
            width: planWidth,
            height: MenuMetrics.rowHeight
        )
    }

    var namesEnd: CGFloat {
        plan.map { $0.minX - MenuMetrics.planGap } ?? gaugesStart
    }

    /// The plan column a vendor's rows share: as wide as its widest plan, and never narrower than
    /// its header, up to `MenuMetrics.planMaximumWidth`, past which a plan is cut short. No plan
    /// under the vendor means no column.
    static func planWidth(_ vendor: PlanVendor) -> CGFloat {
        let plans = vendor.plans.compactMap(\.planName)
        guard !plans.isEmpty else { return 0 }
        let widest = plans.map {
            ceil(NSAttributedString(string: $0, attributes: [.font: MenuMetrics.planFont]).size().width)
        }.max() ?? 0
        return min(max(widest, ceil(columnHeader("Plan").size().width)), MenuMetrics.planMaximumWidth)
    }

    /// Wide enough for "100%" beside its ring.
    static let gaugeWidth: CGFloat = {
        let digits = NSAttributedString(string: "100%", attributes: [.font: MenuMetrics.detailFont])
        return MenuMetrics.gaugeDiameter + MenuMetrics.gaugeTextGap + ceil(digits.size().width)
    }()

    /// Wide enough for the longest clock time this locale writes.
    static let resetWidth: CGFloat = {
        var parts = DateComponents()
        parts.year = 2026
        parts.month = 1
        parts.day = 1
        parts.hour = 22
        parts.minute = 58
        let sample = localCalendar.date(from: parts) ?? Date()
        let text = NSAttributedString(
            string: clockTime(sample),
            attributes: [.font: MenuMetrics.detailFont]
        )
        return ceil(text.size().width)
    }()
}

/// The gauge's colors: quiet while there is room, yellow when little is left, red when almost
/// nothing is or the account cannot be used until this window starts over.
private struct GaugeLevel {
    let ring: NSColor
    let text: NSColor

    init(window: PlanWindow, blocked: Bool) {
        let left = window.remainingPercent
        if blocked || left < MenuMetrics.redBelow {
            ring = .systemRed
            text = .systemRed
        } else if left < MenuMetrics.yellowBelow {
            ring = .systemYellow
            text = .secondaryLabelColor
        } else {
            ring = .secondaryLabelColor
            text = .secondaryLabelColor
        }
    }
}

/// A clock time when the reset is under a day away; otherwise the weekday, or the date once the
/// weekday could be mistaken for this week's. The tooltip adds the clock time to any reset that is
/// not today, so nothing is lost by the brevity.
func resetPhrase(_ date: Date, precise: Bool = false) -> String {
    let remaining = date.timeIntervalSinceNow
    if precise {
        if localCalendar.isDateInToday(date) { return clockTime(date) }
        let day = localFormatter(remaining < 6 * 24 * 60 * 60 ? "EEE" : "MMM d").string(from: date)
        return "\(day) \(clockTime(date))"
    }
    if remaining < 24 * 60 * 60 { return clockTime(date) }
    return localFormatter(remaining < 6 * 24 * 60 * 60 ? "EEE" : "MMM d").string(from: date)
}

private func clockTime(_ date: Date) -> String {
    let formatter = localFormatter(nil)
    formatter.timeStyle = .short
    formatter.dateStyle = .none
    return formatter.string(from: date)
}

/// Every reset is written in the Mac's own time zone and locale — never UTC, an ISO string, or
/// the daemon's zone — and both follow the system, so a Mac that changes zone shows the new
/// local time.
private var localCalendar: Calendar {
    var calendar = Calendar.autoupdatingCurrent
    calendar.timeZone = TimeZone.autoupdatingCurrent
    return calendar
}

private func localFormatter(_ template: String?) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.locale = Locale.autoupdatingCurrent
    formatter.timeZone = TimeZone.autoupdatingCurrent
    formatter.calendar = localCalendar
    if let template { formatter.setLocalizedDateFormatFromTemplate(template) }
    return formatter
}
