using System;
using System.Collections.Generic;
using System.Globalization;

// What the tray menu shows, read from the daemon's snapshots and kept the same as the macOS menu:
// plan usage per account in configuration order, then the few top-level tasks and bots that are
// working. C# 5 and ASCII only; see DaemonClient.cs.

/// <summary>Which quota window this is, in the order a row shows them from left to right.</summary>
internal enum PlanWindowKind { Session = 0, Week = 1, Month = 2, Fable = 3 }

internal sealed class PlanWindow
{
    public PlanWindowKind Kind;
    public double UsedPercent;
    public DateTime? ResetsAt;

    /// <summary>What is left, the way a battery reads: 100 when nothing is spent.</summary>
    public double Left { get { return Math.Min(Math.Max(100 - UsedPercent, 0), 100); } }
    public bool IsFull { get { return UsedPercent >= 100; } }

    public static string Label(PlanWindowKind kind)
    {
        switch (kind)
        {
            case PlanWindowKind.Session: return "Session";
            case PlanWindowKind.Week: return "Week";
            case PlanWindowKind.Month: return "Month";
            default: return "Fable";
        }
    }
}

/// <summary>
/// One account's plan: the windows its row shows, and Claude's separate Fable allowance, which is
/// only ever named in the tooltip. An account with no reading yet has no windows and shows as a
/// placeholder in its place.
/// </summary>
internal sealed class PlanEntry
{
    public string ProviderId;
    public string Type;
    public string Name;
    public string PlanName;
    public List<PlanWindow> Windows = new List<PlanWindow>();
    public PlanWindow Fable;
    public bool Exhausted;

    public bool IsPlaceholder { get { return Windows.Count == 0; } }

    public List<PlanWindow> AllWindows
    {
        get
        {
            var all = new List<PlanWindow>(Windows);
            if (Fable != null) all.Add(Fable);
            return all;
        }
    }

    /// <summary>
    /// The window holding the account back: while any window is full, Fable included, the one that
    /// resets last; otherwise the one with the least left.
    /// </summary>
    public PlanWindow Limiting
    {
        get
        {
            PlanWindow limiting = null;
            foreach (PlanWindow window in AllWindows)
                if (window.IsFull && (limiting == null || (window.ResetsAt ?? DateTime.MinValue) > (limiting.ResetsAt ?? DateTime.MinValue)))
                    limiting = window;
            if (limiting != null) return limiting;
            foreach (PlanWindow window in Windows)
                if (limiting == null || window.UsedPercent > limiting.UsedPercent) limiting = window;
            return limiting;
        }
    }

    public bool IsBlocked
    {
        get
        {
            if (Exhausted) return true;
            foreach (PlanWindow window in AllWindows) if (window.IsFull) return true;
            return false;
        }
    }

    /// <summary>Whether this window keeps a blocked account blocked; the week stands in for Fable.</summary>
    public bool IsBlocking(PlanWindow window)
    {
        PlanWindow limiting = Limiting;
        if (!IsBlocked || limiting == null) return false;
        return limiting.Kind == window.Kind || (limiting.Kind == PlanWindowKind.Fable && window.Kind == PlanWindowKind.Week);
    }

    public PlanWindow Window(PlanWindowKind kind)
    {
        foreach (PlanWindow window in Windows) if (window.Kind == kind) return window;
        return null;
    }
}

internal sealed class PlanVendor
{
    public string Type;
    public string Name;
    public List<PlanEntry> Plans = new List<PlanEntry>();
    /// <summary>The window columns every row of this vendor shares, so they line up.</summary>
    public List<PlanWindowKind> Columns = new List<PlanWindowKind>();
}

/// <summary>
/// Keeps the plan rows still between refreshes.
///
/// The daemon starts with no reading for any account and gets them one at a time, and drops a
/// window once it has reset. Shown as reported, rows appeared one by one and pushed each other
/// around, and columns came and went. The book remembers each account's last reading, its name, and
/// every column its vendor has shown: an account without a reading is a placeholder in its place, a
/// reading that lost a window keeps the last one, and a window whose reset has passed is full again.
/// </summary>
internal sealed class PlanBook
{
    private readonly Dictionary<string, PlanEntry> readings = new Dictionary<string, PlanEntry>();
    private readonly Dictionary<string, string> names = new Dictionary<string, string>();
    private readonly HashSet<string> shown = new HashSet<string>();
    private readonly Dictionary<string, HashSet<PlanWindowKind>> columns = new Dictionary<string, HashSet<PlanWindowKind>>();

    /// <summary>Vendors the daemon can read usage for; others never get a row.</summary>
    private static bool IsReadable(string type) { return type == "claude" || type == "codex" || type == "grok"; }

    public List<PlanVendor> Update(UsageProvider[] providers, DateTime now)
    {
        var vendors = new List<PlanVendor>();
        foreach (UsageProvider provider in providers ?? new UsageProvider[0])
        {
            if (provider.Id == null || provider.Enabled == false || provider.Hidden == true) continue;
            string type = provider.Type ?? "unknown";
            if (provider.Configured) names[provider.Id] = provider.Name ?? ProviderName(provider.Id);
            string name;
            if (!names.TryGetValue(provider.Id, out name)) name = ProviderName(provider.Id);
            PlanEntry previous;
            readings.TryGetValue(provider.Id, out previous);
            PlanEntry fresh = Read(provider, type);
            bool awaiting = provider.Refreshing == true || !provider.CheckedAt.HasValue;
            PlanEntry entry;
            if (fresh != null) entry = Carry(fresh, previous, now);
            else if (previous != null) entry = Carry(previous, null, now);
            else if (IsReadable(type) && (awaiting || shown.Contains(provider.Id)))
                entry = new PlanEntry { ProviderId = provider.Id, Type = type };
            else continue;
            entry.Name = name;
            if (!entry.IsPlaceholder) readings[provider.Id] = entry;
            shown.Add(provider.Id);
            HashSet<PlanWindowKind> known;
            if (!columns.TryGetValue(type, out known)) columns[type] = known = new HashSet<PlanWindowKind>();
            foreach (PlanWindow window in entry.Windows) known.Add(window.Kind);
            PlanVendor vendor = vendors.Find(v => v.Type == type);
            if (vendor == null)
            {
                vendor = new PlanVendor { Type = type, Name = VendorName(type) };
                vendors.Add(vendor);
            }
            vendor.Plans.Add(entry);
        }
        foreach (PlanVendor vendor in vendors)
        {
            HashSet<PlanWindowKind> known = columns[vendor.Type];
            if (known.Count == 0) { known = new HashSet<PlanWindowKind>(); known.Add(PlanWindowKind.Session); known.Add(PlanWindowKind.Week); }
            vendor.Columns = new List<PlanWindowKind>(known);
            vendor.Columns.Sort();
        }
        return vendors;
    }

    /// <summary>
    /// The session and the week when the vendor reports them, and a monthly window only when there
    /// is no session, so a week-and-month pair still has both. Null when no window was reported.
    /// </summary>
    private static PlanEntry Read(UsageProvider provider, string type)
    {
        if (provider.Usage == null || provider.Usage.Windows == null) return null;
        UsageWindows windows = provider.Usage.Windows;
        var entry = new PlanEntry
        {
            ProviderId = provider.Id,
            Type = type,
            PlanName = string.IsNullOrEmpty(provider.Usage.PlanName) ? null : provider.Usage.PlanName,
            Exhausted = provider.Usage.Exhausted == true,
            Fable = Window(windows.Fable, PlanWindowKind.Fable),
        };
        AddWindow(entry, windows.Session, PlanWindowKind.Session);
        AddWindow(entry, windows.Week, PlanWindowKind.Week);
        if (windows.Session == null) AddWindow(entry, windows.Month, PlanWindowKind.Month);
        return entry.IsPlaceholder ? null : entry;
    }

    private static void AddWindow(PlanEntry entry, UsageWindow reported, PlanWindowKind kind)
    {
        PlanWindow window = Window(reported, kind);
        if (window != null) entry.Windows.Add(window);
    }

    private static PlanWindow Window(UsageWindow reported, PlanWindowKind kind)
    {
        if (reported == null) return null;
        return new PlanWindow { Kind = kind, UsedPercent = reported.UsedPercent, ResetsAt = FromUnixMs(reported.ResetsAt) };
    }

    /// <summary>
    /// <paramref name="entry"/> with any window it lacks taken from <paramref name="previous"/>, and
    /// every window whose reset has passed shown as a fresh allowance.
    /// </summary>
    private static PlanEntry Carry(PlanEntry entry, PlanEntry previous, DateTime now)
    {
        var windows = new List<PlanWindow>(entry.Windows);
        if (previous != null)
            foreach (PlanWindow window in previous.Windows)
                if (windows.Find(w => w.Kind == window.Kind) == null) windows.Add(window);
        windows.Sort((a, b) => a.Kind.CompareTo(b.Kind));
        PlanWindow fable = entry.Fable ?? (previous == null ? null : previous.Fable);
        bool wasFull = (fable != null && fable.IsFull) || windows.Exists(w => w.IsFull);
        var renewed = windows.ConvertAll(w => Current(w, now));
        PlanWindow renewedFable = fable == null ? null : Current(fable, now);
        bool isFull = (renewedFable != null && renewedFable.IsFull) || renewed.Exists(w => w.IsFull);
        // A spent account is usable again once every full window has reset. One the vendor blocked
        // without a full window has no reset to wait for, so it stays spent until a new reading.
        return new PlanEntry
        {
            ProviderId = entry.ProviderId,
            Type = entry.Type,
            Name = entry.Name,
            PlanName = entry.PlanName ?? (previous == null ? null : previous.PlanName),
            Windows = renewed,
            Fable = renewedFable,
            Exhausted = entry.Exhausted && (isFull || !wasFull),
        };
    }

    private static PlanWindow Current(PlanWindow window, DateTime now)
    {
        if (!window.ResetsAt.HasValue || window.ResetsAt.Value > now) return window;
        return new PlanWindow { Kind = window.Kind, UsedPercent = 0, ResetsAt = null };
    }

    public static DateTime? FromUnixMs(long? ms)
    {
        if (!ms.HasValue) return null;
        return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms.Value);
    }

    /// <summary>A provider ID as words, since a person names their own accounts.</summary>
    public static string ProviderName(string id)
    {
        if (id == "claude" || id == "codex" || id == "grok") return "Current CLI";
        if (id == "bedrock") return "Bedrock";
        return CultureInfo.CurrentCulture.TextInfo.ToTitleCase((id ?? "Provider").Replace('_', ' ').Replace('-', ' ').Replace('.', ' '));
    }

    public static string VendorName(string type)
    {
        switch (type)
        {
            case "claude": return "Claude";
            case "codex": return "Codex";
            case "grok": return "Grok";
            case "bedrock": return "Amazon Bedrock";
            case "smart": return "Pool";
            default: return "Provider";
        }
    }
}

/// <summary>One top-level task or bot, and the agents under it with a turn in flight.</summary>
internal sealed class WorkEntry
{
    public string Id;
    public string Name;
    public bool IsWorking;
    /// <summary>The entry's own agent first, then its working subtasks.</summary>
    public List<string> WorkingAgentIds = new List<string>();
    /// <summary>When the turn shown began, or null while it is not known.</summary>
    public DateTime? Since;
}

internal static class WorkReader
{
    /// <summary>
    /// Bots, and the joined tasks the desktop sidebar shows at its top level: a task an agent opened
    /// from inside another task belongs to that task's work and is left out, the way subtasks are.
    /// </summary>
    public static List<WorkEntry> Read(WorkRow[] bots, WorkRow[] tasks)
    {
        var insideTasks = new HashSet<string>();
        foreach (WorkRow task in tasks) if (task.Agent != null) CollectIds(task.Agent, insideTasks);
        var rows = new List<WorkRow>(bots);
        foreach (WorkRow task in tasks)
            if (task.CreatorAgentId == null || !insideTasks.Contains(task.CreatorAgentId)) rows.Add(task);
        var entries = new List<WorkEntry>();
        foreach (WorkRow row in rows)
        {
            if (row.Id == null || row.Status != "active") continue;
            var entry = new WorkEntry { Id = row.Id, Name = string.IsNullOrEmpty(row.Name) ? "Untitled" : row.Name };
            if (row.Agent != null)
            {
                entry.IsWorking = IsWorking(row.Agent);
                CollectWorking(row.Agent, entry.WorkingAgentIds);
            }
            entries.Add(entry);
        }
        return entries;
    }

    private static void CollectIds(AgentNode agent, HashSet<string> ids)
    {
        if (agent.Id != null) ids.Add(agent.Id);
        if (agent.Subtasks != null) foreach (AgentNode subtask in agent.Subtasks) CollectIds(subtask, ids);
    }

    private static void CollectWorking(AgentNode agent, List<string> ids)
    {
        if (agent.Id != null && agent.Status != null && agent.Status != "idle") ids.Add(agent.Id);
        if (agent.Subtasks != null) foreach (AgentNode subtask in agent.Subtasks) CollectWorking(subtask, ids);
    }

    /// <summary>Working while it runs a turn, a subagent runs, or any subtask under it works.</summary>
    private static bool IsWorking(AgentNode agent)
    {
        if (agent.Status != null && agent.Status != "idle") return true;
        if (agent.Subagents != null && agent.Subagents.Running > 0) return true;
        if (agent.Subtasks != null) foreach (AgentNode subtask in agent.Subtasks) if (IsWorking(subtask)) return true;
        return false;
    }
}

internal static class TrayText
{
    /// <summary>More than this many working tasks and bots collapse into a "+N more" line.</summary>
    public const int SessionLimit = 5;

    /// <summary>Elapsed turn time, written exactly as the desktop writes its running-turn clock.</summary>
    public static string Duration(DateTime since, DateTime now)
    {
        int seconds = Math.Max(0, (int)(now - since).TotalSeconds);
        if (seconds < 60) return seconds + "s";
        int minutes = seconds / 60;
        if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
        return (minutes / 60) + "h " + (minutes % 60) + "m";
    }

    public static string Tokens(long count)
    {
        if (count >= 1000000) return (count / 1000000.0).ToString("0.0", CultureInfo.CurrentCulture) + "M";
        if (count >= 1000) return (count / 1000) + "K";
        return count.ToString(CultureInfo.CurrentCulture);
    }

    /// <summary>
    /// A reset in this PC's local time: a clock time when under a day away, otherwise the weekday,
    /// or the date once a weekday could be mistaken for this week's. Never UTC or an ISO string.
    /// With <paramref name="precise"/>, any reset not today also carries its clock time.
    /// </summary>
    public static string Reset(DateTime resetsAt, DateTime now, bool precise)
    {
        DateTime local = resetsAt.ToLocalTime();
        TimeSpan remaining = resetsAt - now;
        string clock = local.ToString("t", CultureInfo.CurrentCulture);
        string day = remaining < TimeSpan.FromDays(6)
            ? local.ToString("ddd", CultureInfo.CurrentCulture)
            : local.ToString(CultureInfo.CurrentCulture.DateTimeFormat.MonthDayPattern.Replace("MMMM", "MMM"), CultureInfo.CurrentCulture);
        if (precise) return local.Date == now.ToLocalTime().Date ? clock : day + " " + clock;
        return remaining < TimeSpan.FromDays(1) ? clock : day;
    }

    /// <summary>The account and plan in full, then every window with its exact local reset.</summary>
    public static string Tooltip(PlanEntry entry, DateTime now)
    {
        string account = entry.PlanName == null ? entry.Name : entry.Name + " \u00B7 " + entry.PlanName;
        if (entry.IsPlaceholder) return account + "\nWaiting for the first usage reading";
        var lines = new List<string> { account };
        PlanWindow limiting = entry.Limiting;
        if (entry.IsBlocked && limiting != null)
            lines.Add((limiting.IsFull ? PlanWindow.Label(limiting.Kind) + " limit reached" : "Out of usage") +
                (limiting.ResetsAt.HasValue ? ", resets " + Reset(limiting.ResetsAt.Value, now, true) : ""));
        foreach (PlanWindow window in entry.AllWindows)
            lines.Add(PlanWindow.Label(window.Kind) + ": " + Math.Round(window.Left).ToString(CultureInfo.CurrentCulture) + "% left" +
                (window.ResetsAt.HasValue ? ", resets " + Reset(window.ResetsAt.Value, now, true) : ""));
        return string.Join("\n", lines);
    }
}
