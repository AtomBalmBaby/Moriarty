import { xxhash64,xxhash128 } from "hash-wasm"
import { createHash } from "node:crypto"

export type ContentHashAlgorithm = "xxh64" | "xxh3_128" | "sha256"

export const isContentHashAlgorithm = (value: string): value is ContentHashAlgorithm =>
  value === "xxh64" || value === "xxh3_128" || value === "sha256"

const ALGORITHMS: Record<ContentHashAlgorithm, { prefix: string; length: number }> = {
  xxh64: { prefix: "xxh64", length: 16 },
  xxh3_128: { prefix: "xxh3_128", length: 32 },
  sha256: { prefix: "sha256", length: 64 }
}

let algorithmProvider: () => ContentHashAlgorithm = () => "xxh64"

export const setContentHashAlgorithmProvider = (provider: () => ContentHashAlgorithm): void => {
  algorithmProvider = provider
}

export const getContentHashAlgorithm = (): ContentHashAlgorithm => algorithmProvider()

export const fingerprintContent = async (
  text: string,
  algorithm: ContentHashAlgorithm = getContentHashAlgorithm()
): Promise<string> => {
  let digest: string
  switch (algorithm) {
    case "xxh64":
      digest = await xxhash64(text)
      break
    case "xxh3_128":
      digest = await xxhash128(text)
      break
    case "sha256":
      digest = createHash("sha256").update(text, "utf8").digest("hex")
      break
  }
  return `${ALGORITHMS[algorithm].prefix}:${digest}`
}

export const verifyContentFingerprint = async (text: string, fingerprint: string): Promise<boolean> => {
  const separator = fingerprint.indexOf(":")
  const algorithm = separator < 0 ? "sha256" : fingerprint.slice(0, separator)
  const digest = separator < 0 ? fingerprint : fingerprint.slice(separator + 1)
  if (algorithm !== "xxh64" && algorithm !== "xxh3_128" && algorithm !== "sha256") {
    throw new Error(`Unsupported content fingerprint algorithm: ${algorithm}`)
  }
  if (digest.length !== ALGORITHMS[algorithm].length || !/^[a-f0-9]+$/i.test(digest)) {
    throw new Error(`Invalid ${algorithm} content fingerprint`)
  }
  return (await fingerprintContent(text, algorithm)) === `${algorithm}:${digest.toLowerCase()}`
}
