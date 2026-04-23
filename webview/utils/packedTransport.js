import { decode } from "msgpack-lite";

export function decodePackedBase64(base64Value) {
  if (!base64Value || typeof base64Value !== "string") return null;
  try {
    const bytes = Uint8Array.from(atob(base64Value), (char) => char.charCodeAt(0));
    return decode(bytes);
  } catch {
    return null;
  }
}