import { createHmac, timingSafeEqual } from "node:crypto";

type TelegramInitData = {
  telegramUserId: number;
  displayName: string | null;
};

function hexToBuffer(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function verifyAndParseTelegramInitData(initDataRaw: string, botToken: string): TelegramInitData {
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) {
    throw new Error("Missing hash in initData");
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHex = createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const provided = hexToBuffer(hash);
  const computed = hexToBuffer(computedHex);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    throw new Error("Invalid Telegram initData signature");
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new Error("Missing user payload in initData");
  }

  const user = JSON.parse(userRaw) as {
    id?: number;
    first_name?: string;
    last_name?: string;
    username?: string;
  };

  if (!user.id) {
    throw new Error("Telegram user id not present");
  }

  const fallbackName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const displayName = user.username ?? (fallbackName || null);

  return {
    telegramUserId: user.id,
    displayName
  };
}
