export const calculateHash = async (msg) => {
  try {
    // 1. 将字符串转换为 ArrayBuffer
    const encoder = new TextEncoder();
    const data = encoder.encode(msg);

    // 2. 使用 Web Crypto API 计算 SHA-256 哈希
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);

    // 3. 转换为十六进制字符串
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex;
  } catch (error) {
    console.error("Error calculating hash:", error);
  }
}

export const test = async () => {

}
