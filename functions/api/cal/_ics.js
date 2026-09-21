// functions/api/cal/_ics.js — build an RFC-5545 iCalendar (.ics) document from the calendar snapshot.
// Pure + dependency-free (Worker-safe), so the feed Function just resolves the member then calls buildICS.
//
// Three event kinds -> VEVENTs:
//   honbasho / special : all-day span. DTSTART;VALUE=DATE = start, DTEND;VALUE=DATE = end+1 (DTEND is
//                        EXCLUSIVE in iCalendar, so a Sep 13–27 tournament ends 20260928).
//   birthday           : all-day, DTSTART at the birth date, RRULE:FREQ=YEARLY -> recurs every year.
//
// TEXT values are escaped (backslash/;/,/newline) and long lines folded at 75 OCTETS per the spec,
// with CRLF line breaks throughout (some calendar clients are strict).

export function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold a single content line to <=75 OCTETS (RFC 5545 §3.1); continuation lines start with a space.
// Measures UTF-8 byte length (not character count) and never splits a multibyte character, so a
// non-ASCII value (an accented event name, etc.) can't over-fold or break mid-codepoint. ASCII is
// unaffected (1 char = 1 octet), so this matches the previous behavior for the romaji this feed carries.
const ENC = new TextEncoder();
function fold(line) {
  if (ENC.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let curBytes = 0;
  let first = true;
  for (const ch of line) {                      // iterate by code point (handles surrogate pairs)
    const chBytes = ENC.encode(ch).length;
    const limit = first ? 75 : 74;              // a continuation line spends 1 octet on its leading space
    if (curBytes + chBytes > limit) {
      out.push(first ? cur : ' ' + cur);
      first = false;
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) out.push(first ? cur : ' ' + cur);
  return out.join('\r\n');
}

const pad = n => String(n).padStart(2, '0');
const compact = ymd => String(ymd).replace(/-/g, '');            // "2026-09-13" -> "20260913"
function plusOneDay(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return compact(ymd);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));     // UTC add-a-day (all-day, tz-free)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
function dtstamp(now = new Date()) {
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

const DOMAIN = 'saltstatsandsumo';

// Build the full VCALENDAR string from a calendar snapshot ({events, birthdays}).
export function buildICS(snapshot, opts = {}) {
  const name = opts.name || 'Salt Stats & Sumo';
  const stamp = dtstamp(opts.now);
  const out = [];
  const push = line => out.push(fold(line));

  push('BEGIN:VCALENDAR');
  push('VERSION:2.0');
  push('PRODID:-//Salt Stats & Sumo//Calendar//EN');
  push('CALSCALE:GREGORIAN');
  push('METHOD:PUBLISH');
  push('X-WR-CALNAME:' + icsEscape(name));
  push('X-WR-CALDESC:' + icsEscape('Honbasho, rikishi birthdays, and crew events.'));

  for (const ev of (snapshot.events || [])) {
    if (!ev.start) continue;
    const end = ev.end || ev.start;                              // single-day span ends same day
    push('BEGIN:VEVENT');
    push('UID:' + (ev.id || ('ev-' + compact(ev.start))) + '@' + DOMAIN);
    push('DTSTAMP:' + stamp);
    push('DTSTART;VALUE=DATE:' + compact(ev.start));
    push('DTEND;VALUE=DATE:' + plusOneDay(end));                 // DTEND is exclusive
    push('SUMMARY:' + icsEscape(ev.title));
    if (ev.location) push('LOCATION:' + icsEscape(ev.location));
    if (ev.url) push('URL:' + icsEscape(ev.url));
    const desc = [ev.notes, ev.kind === 'honbasho' ? 'Grand Sumo Tournament (Honbasho).' : null].filter(Boolean).join(' ');
    if (desc) push('DESCRIPTION:' + icsEscape(desc));
    push('TRANSP:TRANSPARENT');                                  // shows as free time, not "busy"
    push('END:VEVENT');
  }

  for (const b of (snapshot.birthdays || [])) {
    if (!(b.month && b.day)) continue;
    const y = b.bornYear || 2000;
    const start = `${y}${pad(b.month)}${pad(b.day)}`;
    const endExcl = plusOneDay(`${y}-${pad(b.month)}-${pad(b.day)}`);
    push('BEGIN:VEVENT');
    push('UID:' + (b.id || ('bd-' + start)) + '@' + DOMAIN);
    push('DTSTAMP:' + stamp);
    push('DTSTART;VALUE=DATE:' + start);
    push('DTEND;VALUE=DATE:' + endExcl);
    push('RRULE:FREQ=YEARLY');
    push('SUMMARY:' + icsEscape(`${b.name}'s birthday`));
    if (b.bornYear) push('DESCRIPTION:' + icsEscape(`Born ${b.bornYear}.`));
    push('TRANSP:TRANSPARENT');
    push('END:VEVENT');
  }

  push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}
