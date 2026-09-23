// Reader for the per-Bridge provisioning file the admin drops on the SD-card's
// boot partition (FAT32, visible on macOS/Windows after flashing). See
// BRIDGE-REMOTE-ACCESS-PLAN.md §3.1. Format:
//   { "server_url": "...", "device_uid": "brg_...", "enroll_token": "...",
//     "hostname": "bridge-emfysio-01", "practice": "EMFysio" }
import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('provision-file');

export interface ProvisionFile {
  server_url: string;
  device_uid: string;
  enroll_token: string;
  hostname?: string;
  practice?: string;
}

/** First readable provisioning file across the known boot-partition locations, or null. */
export function readProvisionFile(): ProvisionFile | null {
  for (const p of config.remote.provisionPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ProvisionFile>;
      if (!parsed.server_url || !parsed.device_uid || !parsed.enroll_token) {
        log.warn(`${p} is missing server_url/device_uid/enroll_token — ignoring`);
        continue;
      }
      log.info(`provisioning file found at ${p} (device ${parsed.device_uid}, practice ${parsed.practice ?? '?'})`);
      return parsed as ProvisionFile;
    } catch (e: any) {
      log.warn(`could not read ${p}: ${e.message}`);
    }
  }
  return null;
}
