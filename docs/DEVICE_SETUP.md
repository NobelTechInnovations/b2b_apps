# Connecting a fingerprint / biometric machine

How punches get from the terminal on your wall into Nexus attendance — and
from there into payroll.

## How it works, in one picture

```
 Fingerprint terminal ──► punch file ──► device bridge ──► Nexus ──► attendance ──► payroll
   (eSSL, ZKTeco…)        attlog.dat       (small program)    /api/device-sync
                          or CSV export
```

**Punches from the machine are recorded automatically.** No one approves them —
the terminal is the evidence.

**Anything typed in by a person needs approval.** HR marking a day, the
check-in / check-out buttons, or an employee saying "I forgot to punch" all
become *requests*. They reach attendance — and therefore payroll — only after
someone with the *approve attendance* permission accepts them. Nobody can
approve their own request.

## Why there is a bridge

Most terminals sold in India (eSSL, ZKTeco, Realtime, Mantra, Identix) do **not**
call web addresses. They keep punches in their memory and hand them over as a
file — on a USB stick (`1_attlog.dat`), or as a CSV from the vendor's desktop
software (eTimeTrackLite, ZKTime, etc.).

The bridge (`tools/device-bridge/bridge.js`) reads that file and sends the
punches to Nexus. It is one file, needs only Node.js 18+, and is safe to run as
often as you like — duplicates are ignored.

## Setup — about 15 minutes

### 1. Register the machine in Nexus

HR → **Devices** → **Add device**. Give it a name ("Main gate").

You will be shown an **endpoint** and a **device key** (`nxd_…`).
**Copy the key now** — it is shown once and stored only as a fingerprint of
itself. If it is lost, use *Rotate key* and update the bridge.

### 2. Make the machine and Nexus agree on who is who

Each person is enrolled on the terminal under a number. Nexus has to know which
employee that number means. Two ways:

| Easiest | Also fine |
|---|---|
| Enrol people on the terminal **using their Nexus employee code** (`EMP-001`, or just `1` if your terminal only takes digits and you map it). Nexus matches these automatically. | Keep the terminal's numbers, and map each one under HR → Devices → **Enrolment** (`1001` → Ravi Patil). |

Nothing is lost if you get this wrong. A punch from an unknown number is
**parked**, not dropped. It shows up under Enrolment as "waiting to be mapped";
map it and every punch it already sent is adopted and those days rebuilt.

### 3. Choose how the punch file reaches the bridge

**A — USB stick (works with every terminal, no network needed)**

1. On the terminal: *Menu → Pen Drive Mgmt → Download Attendance Data*.
2. Plug the stick into any computer with Node.js and run:

```bash
node tools/device-bridge/bridge.js \
  --file /Volumes/USB/1_attlog.dat \
  --key nxd_your_key_here \
  --url https://your-nexus-address/api/device-sync/punches
```

Do this daily, or at least before running payroll.

**B — An office PC that runs the vendor software (hands-off)**

If the terminal is on your network and its software (eTimeTrackLite etc.)
already downloads punches to a PC, set that software to export to a folder,
and leave the bridge watching it:

```bash
node tools/device-bridge/bridge.js \
  --watch "C:\Attendance\Exports" \
  --interval 300 \
  --key nxd_your_key_here \
  --url https://your-nexus-address/api/device-sync/punches
```

To keep it running across restarts on Windows, add it to *Task Scheduler*
("At log on", "Restart on failure"). On macOS/Linux, a `launchd`/`systemd`
unit or `pm2` works.

The bridge remembers what it has sent in `.nexus-bridge-state.json` next to
the file, so re-running it over the same export sends only new punches.

### 4. Check it landed

HR → Devices → **Punch log** shows every raw punch as received. HR →
**Attendance** shows the days built from them, with hours, lateness and
overtime worked out from each person's shift.

## Things that trip people up

| Symptom | Cause | Fix |
|---|---|---|
| Every time is off by 5½ hours | Terminal clock is local time; the bridge assumes India (`+05:30`) | Pass `--tz +04:00` etc. for other zones |
| Times are consistently a few minutes wrong | The terminal's own clock has drifted | Set the time on the terminal; it does not sync itself |
| Everyone appears "in" all day | The terminal records every punch as check-in | Run with `--state ignore` — Nexus then pairs punches in/out itself |
| "UNMATCHED" in the bridge output | Terminal number not known to Nexus | Map it under Devices → Enrolment |
| `401 Unknown device key` | Key mistyped, rotated, or device disabled | Copy the current key from Devices; rotate if unsure |
| HR corrected a day and the machine later sent punches for it | Intended | An **approved manual day is not overwritten** by later punches. The punches are kept in the log for anyone who wants to question the decision |

## Security

- The key only ever unlocks the one workspace it was created in.
- It is stored as a hash; nobody at Nexus can read it back.
- Disable a device (Devices → Disable) to stop it immediately; rotate the key
  if a stick or PC with it is lost.
- The bridge only ever *sends* punches. It cannot read anything from Nexus.

## Not yet supported

**Direct push from the terminal ("ADMS" / "cloud server" mode).** Many newer
eSSL and ZKTeco terminals can post punches straight to a server with no PC in
between, using the vendor's `iclock` protocol. Nexus does not speak that
protocol yet, so today every terminal goes through the bridge. Adding it would
remove the bridge entirely for those models — say if you want it prioritised.
