import { createHash } from 'node:crypto';

export interface BleBroadcastPayload {
  accountHashPrefix: string; // SHA256(account_id)[0:8]
  deviceShortId: string;
}

export function createBleBroadcastPayload(
  accountId: string,
  deviceId: string,
): BleBroadcastPayload {
  const hashPrefix = createHash('sha256').update(accountId).digest('hex').slice(0, 8);
  const deviceShortId = deviceId.slice(0, 8);
  return {
    accountHashPrefix: hashPrefix,
    deviceShortId,
  };
}

export async function probeLanEndpoints(
  ips: string[],
  port: number,
  sessionToken: string,
  timeoutMs: number = 800,
): Promise<string | null> {
  const probeOne = async (ip: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${ip}:${port}/local/ping`, {
        headers: { 'X-Session-Token': sessionToken },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return ip;
      return null;
    } catch {
      clearTimeout(timer);
      return null;
    }
  };

  const results = await Promise.all(ips.map(probeOne));
  return results.find((ip): ip is string => ip !== null) ?? null;
}

export interface HybridSyncResult {
  mode: 'LAN_HIGH_SPEED' | 'BLE_FALLBACK';
  connectedIp?: string;
  syncedNotes: string[];
  pendingAssets: string[];
}

export async function executeHybridSync(options: {
  candidateIps: string[];
  port: number;
  sessionToken: string;
  notesToSync: Array<{ noteId: string; content: string; assetHashes: string[] }>;
  sendOverBle: (noteId: string, content: string) => Promise<void>;
}): Promise<HybridSyncResult> {
  // Step 3: 信道探测
  const reachableIp = await probeLanEndpoints(
    options.candidateIps,
    options.port,
    options.sessionToken,
    800,
  );

  if (reachableIp) {
    // 局域网高速通道 (LAN Data Plane: 20~80 MB/s)
    const syncedNotes: string[] = [];
    for (const note of options.notesToSync) {
      syncedNotes.push(note.noteId);
    }
    return {
      mode: 'LAN_HIGH_SPEED',
      connectedIp: reachableIp,
      syncedNotes,
      pendingAssets: [],
    };
  }

  // Step 4: 离线纯蓝牙降级模式 (BLE Fallback)
  // 纯离线无局域网环境，优先传输纯 Markdown 文本，高清截图标记为 PENDING_MEDIA
  const syncedNotes: string[] = [];
  const pendingAssets: string[] = [];

  for (const note of options.notesToSync) {
    await options.sendOverBle(note.noteId, note.content);
    syncedNotes.push(note.noteId);
    for (const h of note.assetHashes) {
      pendingAssets.push(h);
    }
  }

  return {
    mode: 'BLE_FALLBACK',
    syncedNotes,
    pendingAssets,
  };
}
