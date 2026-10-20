// Host health read from sysfs (no root, no vcgencmd): the Pi's undervoltage
// flag and CPU temperature. Shipped on the heartbeat so a brownout is visible
// in the cloud and we can tell a power problem apart from a software one without
// SSH (EMFysio, okt 2026 — box viel 's nachts uit, alleen stekkeren hielp).
import { readFile, readdir } from 'node:fs/promises';

export interface Health {
  /** true = undervoltage right now; null = couldn't read (e.g. non-Pi dev box). */
  undervoltage: boolean | null;
  /** CPU temperature in °C, or null when unreadable. */
  tempC: number | null;
}

export async function readHealth(): Promise<Health> {
  const [undervoltage, tempC] = await Promise.all([readUndervoltage(), readTempC()]);
  return { undervoltage, tempC };
}

async function readTempC(): Promise<number | null> {
  try {
    const raw = await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    const milli = Number(raw.trim());
    return Number.isFinite(milli) ? Math.round(milli / 100) / 10 : null; // millideg → 0.1 °C
  } catch {
    return null;
  }
}

async function readUndervoltage(): Promise<boolean | null> {
  // The Raspberry Pi voltage monitor exposes in0_lcrit_alarm (1 = undervoltage)
  // via hwmon. The hwmonN index isn't stable across boots, so find the node by
  // its driver name ("rpi_volt") rather than a hard-coded path.
  const base = '/sys/class/hwmon';
  try {
    for (const dir of await readdir(base)) {
      let name = '';
      try {
        name = (await readFile(`${base}/${dir}/name`, 'utf8')).trim();
      } catch {
        continue;
      }
      if (!/rpi.?volt/i.test(name)) continue;
      try {
        const v = (await readFile(`${base}/${dir}/in0_lcrit_alarm`, 'utf8')).trim();
        return v === '1';
      } catch {
        return null;
      }
    }
  } catch {
    // no hwmon at all → unknown
  }
  return null;
}
