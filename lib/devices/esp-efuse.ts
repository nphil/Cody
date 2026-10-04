/**
 * Read-only eFuse knowledge for the ESP chips Cody talks to.
 *
 * Every address, mask and bit position below is a fact taken from Espressif's
 * published esptool target definitions (`esptool/targets/<chip>.py` and
 * `espefuse/efuse/<chip>/mem_definition.py`). A chip that is not listed here is
 * reported as UNKNOWN rather than guessed: the callers (chip info, eFuse
 * summary, and the safety gate in front of a flash erase) all treat "unknown"
 * as the cautious answer.
 *
 * Nothing here writes: eFuse programming is irreversible and Cody does not
 * offer it. `readReg` is the one device capability these functions need.
 */

/** Reads one 32-bit chip register (esptool's READ_REG). */
export type ReadReg = (address: number) => Promise<number>;

export interface EfuseBlock {
  readonly name: string;
  /** Address of the first read register of this block. */
  readonly address: number;
  readonly words: number;
  /** Holds key material unless the chip read-protects it. */
  readonly secret: boolean;
  readonly role: string;
}

interface RegisterBits {
  readonly address: number;
  readonly mask: number;
}

interface SecureBootBit extends RegisterBits {
  readonly version: "v1" | "v2";
  /** Chip major revision from which the bit is meaningful (ESP32 v3 for Secure Boot V2). */
  readonly minMajorRevision?: number;
}

export interface EspEfuseLayout {
  /** Odd population count of this field means flash encryption is enabled. */
  readonly flashCryptCnt: RegisterBits;
  readonly secureBoot: readonly SecureBootBit[];
  /** Raw block layout; absent where Cody does not know the chip's block map. */
  readonly blocks?: readonly EfuseBlock[];
  /** Where the four-bit purpose of each key block lives, in key-block order. */
  readonly keyPurposes?: readonly { readonly address: number; readonly shift: number }[];
  readonly purposeNames?: Readonly<Record<number, string>>;
}

const PURPOSES_S2_S3: Readonly<Record<number, string>> = {
  0: "USER/EMPTY",
  1: "RESERVED",
  2: "XTS_AES_256_KEY_1",
  3: "XTS_AES_256_KEY_2",
  4: "XTS_AES_128_KEY",
  5: "HMAC_DOWN_ALL",
  6: "HMAC_DOWN_JTAG",
  7: "HMAC_DOWN_DIGITAL_SIGNATURE",
  8: "HMAC_UP",
  9: "SECURE_BOOT_DIGEST0",
  10: "SECURE_BOOT_DIGEST1",
  11: "SECURE_BOOT_DIGEST2",
};

const PURPOSES_C3_C6: Readonly<Record<number, string>> = {
  0: "USER/EMPTY",
  1: "RESERVED",
  4: "XTS_AES_128_KEY",
  5: "HMAC_DOWN_ALL",
  6: "HMAC_DOWN_JTAG",
  7: "HMAC_DOWN_DIGITAL_SIGNATURE",
  8: "HMAC_UP",
  9: "SECURE_BOOT_DIGEST0",
  10: "SECURE_BOOT_DIGEST1",
  11: "SECURE_BOOT_DIGEST2",
};

const PURPOSES_H2: Readonly<Record<number, string>> = {
  ...PURPOSES_C3_C6,
  1: "ECDSA_KEY",
  2: "XTS_AES_256_KEY_1",
  3: "XTS_AES_256_KEY_2",
};

/** The ESP32-S2/S3/C3/C6/H2 family shares one block map and one key-purpose map; only the base address differs. */
function sevenBlockFamily(base: number, purposeNames: Readonly<Record<number, string>>, flashCryptCnt: RegisterBits, secureBootEn: RegisterBits): EspEfuseLayout {
  const key = (index: number): EfuseBlock => ({
    name: `BLOCK${4 + index}`,
    address: base + 0x9c + index * 0x20,
    words: 8,
    secret: true,
    role: `KEY${index}`,
  });
  return {
    flashCryptCnt,
    secureBoot: [{ ...secureBootEn, version: "v2" }],
    blocks: [
      { name: "BLOCK0", address: base + 0x2c, words: 6, secret: false, role: "system configuration" },
      { name: "BLOCK1", address: base + 0x44, words: 6, secret: false, role: "MAC and SPI/chip fields" },
      { name: "BLOCK2", address: base + 0x5c, words: 8, secret: false, role: "system data" },
      { name: "BLOCK3", address: base + 0x7c, words: 8, secret: false, role: "user data" },
      key(0),
      key(1),
      key(2),
      key(3),
      key(4),
      key(5),
      { name: "BLOCK10", address: base + 0x15c, words: 8, secret: false, role: "system data 2" },
    ],
    keyPurposes: [
      { address: base + 0x34, shift: 24 },
      { address: base + 0x34, shift: 28 },
      { address: base + 0x38, shift: 0 },
      { address: base + 0x38, shift: 4 },
      { address: base + 0x38, shift: 8 },
      { address: base + 0x38, shift: 12 },
    ],
    purposeNames,
  };
}

function standardCounter(base: number): RegisterBits {
  return { address: base + 0x34, mask: 0x7 << 18 };
}

function standardSecureBoot(base: number): RegisterBits {
  return { address: base + 0x38, mask: 1 << 20 };
}

const ESP32_BASE = 0x3ff5a000;
const ESP32_S2_BASE = 0x3f41a000;
const ESP32_S3_BASE = 0x60007000;
const ESP32_C3_BASE = 0x60008800;
const ESP32_C6_BASE = 0x600b0800;
const ESP32_C5_BASE = 0x600b4800;

/**
 * Chips whose security eFuses are known. ESP32-C5, ESP32-C61 and ESP32-P4 are
 * deliberately absent: they are newer than the table above was reviewed
 * against, so they report "unknown" and the erase gate treats them cautiously.
 */
export const ESP_EFUSE_LAYOUTS: Readonly<Record<string, EspEfuseLayout>> = {
  ESP32: {
    flashCryptCnt: { address: ESP32_BASE, mask: 0x7f << 20 },
    secureBoot: [
      { address: ESP32_BASE + 0x18, mask: 1 << 4, version: "v1" },
      { address: ESP32_BASE + 0x18, mask: 1 << 5, version: "v2", minMajorRevision: 3 },
    ],
    blocks: [
      { name: "BLOCK0", address: ESP32_BASE, words: 7, secret: false, role: "system configuration" },
      { name: "BLOCK1", address: ESP32_BASE + 0x38, words: 8, secret: true, role: "flash encryption key" },
      { name: "BLOCK2", address: ESP32_BASE + 0x58, words: 8, secret: true, role: "secure boot key" },
      { name: "BLOCK3", address: ESP32_BASE + 0x78, words: 8, secret: false, role: "custom MAC, calibration and user data" },
    ],
  },
  "ESP32-S2": sevenBlockFamily(ESP32_S2_BASE, PURPOSES_S2_S3, standardCounter(ESP32_S2_BASE), standardSecureBoot(ESP32_S2_BASE)),
  "ESP32-S3": sevenBlockFamily(ESP32_S3_BASE, PURPOSES_S2_S3, standardCounter(ESP32_S3_BASE), standardSecureBoot(ESP32_S3_BASE)),
  "ESP32-C3": sevenBlockFamily(ESP32_C3_BASE, PURPOSES_C3_C6, standardCounter(ESP32_C3_BASE), standardSecureBoot(ESP32_C3_BASE)),
  "ESP32-C6": sevenBlockFamily(ESP32_C6_BASE, PURPOSES_C3_C6, standardCounter(ESP32_C6_BASE), standardSecureBoot(ESP32_C6_BASE)),
  "ESP32-H2": sevenBlockFamily(ESP32_C6_BASE, PURPOSES_H2, standardCounter(ESP32_C6_BASE), standardSecureBoot(ESP32_C6_BASE)),
  "ESP32-C2": {
    flashCryptCnt: { address: ESP32_C3_BASE + 0x30, mask: 0x7 << 7 },
    secureBoot: [{ address: ESP32_C3_BASE + 0x30, mask: 1 << 21, version: "v2" }],
    blocks: [
      { name: "BLOCK0", address: ESP32_C3_BASE + 0x2c, words: 2, secret: false, role: "system configuration" },
      { name: "BLOCK1", address: ESP32_C3_BASE + 0x34, words: 3, secret: false, role: "MAC and chip fields" },
      { name: "BLOCK2", address: ESP32_C3_BASE + 0x40, words: 8, secret: false, role: "system data" },
      { name: "BLOCK3", address: ESP32_C3_BASE + 0x60, words: 8, secret: true, role: "KEY0" },
    ],
  },
};

/** Newer chips whose security eFuses were published after the review above. */
export const ESP_UNREVIEWED_CHIPS: readonly string[] = ["ESP32-C5", "ESP32-C61", "ESP32-P4"];

export function espEfuseBaseAddress(chip: string): number | undefined {
  switch (chip) {
    case "ESP32": return ESP32_BASE;
    case "ESP32-S2": return ESP32_S2_BASE;
    case "ESP32-S3": return ESP32_S3_BASE;
    case "ESP32-C3": case "ESP32-C2": return ESP32_C3_BASE;
    case "ESP32-C6": case "ESP32-H2": return ESP32_C6_BASE;
    case "ESP32-C5": return ESP32_C5_BASE;
    default: return undefined;
  }
}

export type EspSecurityBasis = "efuse-registers" | "not-applicable" | "unreviewed-chip" | "read-failed";

export interface EspSecurityState {
  /** `undefined` means Cody could not establish it: callers must treat that as possibly enabled. */
  readonly secureBoot: boolean | undefined;
  readonly secureBootVersion?: "v1" | "v2";
  readonly flashEncryption: boolean | undefined;
  readonly flashCryptCnt?: number;
  readonly basis: EspSecurityBasis;
  readonly note?: string;
}

function populationCount(value: number): number {
  let count = 0;
  for (let remaining = value >>> 0; remaining !== 0; remaining >>>= 1) count += remaining & 1;
  return count;
}

function fieldValue(register: number, mask: number): number {
  let offset = 0;
  while (offset < 32 && ((mask >>> offset) & 1) === 0) offset += 1;
  return ((register & mask) >>> offset) >>> 0;
}

/**
 * The secure-boot and flash-encryption state of a connected chip, read from its
 * eFuse registers exactly where esptool reads it. Never throws on a register
 * read: a failure is reported as `read-failed` so that detection stays usable.
 */
export async function readEspSecurity(chip: string, readReg: ReadReg, majorRevision?: number): Promise<EspSecurityState> {
  if (chip === "ESP8266") {
    return { secureBoot: false, flashEncryption: false, basis: "not-applicable", note: "ESP8266 has no secure boot or flash encryption eFuses." };
  }
  const layout = ESP_EFUSE_LAYOUTS[chip];
  if (!layout) {
    return {
      secureBoot: undefined,
      flashEncryption: undefined,
      basis: "unreviewed-chip",
      note: `Cody has no reviewed eFuse map for ${chip}; its secure boot and flash encryption state is unknown.`,
    };
  }
  try {
    const counter = fieldValue((await readReg(layout.flashCryptCnt.address)) >>> 0, layout.flashCryptCnt.mask);
    const flashEncryption = (populationCount(counter) & 1) === 1;
    let secureBoot = false;
    let secureBootVersion: "v1" | "v2" | undefined;
    for (const bit of layout.secureBoot) {
      // A bit that only newer silicon defines is skipped only when the revision is known to be older: an unknown revision is read, so a set bit is never missed.
      if (bit.minMajorRevision !== undefined && majorRevision !== undefined && majorRevision < bit.minMajorRevision) continue;
      if (((await readReg(bit.address)) & bit.mask) !== 0) {
        secureBoot = true;
        secureBootVersion ??= bit.version;
      }
    }
    return { secureBoot, ...(secureBootVersion ? { secureBootVersion } : {}), flashEncryption, flashCryptCnt: counter, basis: "efuse-registers" };
  } catch (error) {
    return {
      secureBoot: undefined,
      flashEncryption: undefined,
      basis: "read-failed",
      note: `eFuse registers could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface EfuseKeyPurpose {
  readonly block: string;
  readonly purpose: number;
  readonly name: string;
}

/** The purpose assigned to each key block, for the chips that have key blocks. */
export async function readEfuseKeyPurposes(chip: string, readReg: ReadReg): Promise<readonly EfuseKeyPurpose[] | undefined> {
  const layout = ESP_EFUSE_LAYOUTS[chip];
  if (!layout?.keyPurposes || !layout.blocks) return undefined;
  const keyBlocks = layout.blocks.filter((block) => block.role.startsWith("KEY"));
  const purposes: EfuseKeyPurpose[] = [];
  for (let index = 0; index < layout.keyPurposes.length; index += 1) {
    const where = layout.keyPurposes[index]!;
    const purpose = (((await readReg(where.address)) >>> 0) >>> where.shift) & 0xf;
    purposes.push({ block: keyBlocks[index]!.name, purpose, name: layout.purposeNames?.[purpose] ?? `UNKNOWN(${purpose})` });
  }
  return purposes;
}

export interface EfuseBlockWords {
  readonly block: EfuseBlock;
  readonly words: readonly number[];
}

/** Raw words of every known block, as the read registers hold them. */
export async function readEfuseBlocks(chip: string, readReg: ReadReg, onWord?: (completed: number, total: number) => void): Promise<readonly EfuseBlockWords[] | undefined> {
  const blocks = ESP_EFUSE_LAYOUTS[chip]?.blocks;
  if (!blocks) return undefined;
  const total = blocks.reduce((sum, block) => sum + block.words, 0);
  let completed = 0;
  const result: EfuseBlockWords[] = [];
  for (const block of blocks) {
    const words: number[] = [];
    for (let index = 0; index < block.words; index += 1) {
      words.push((await readReg(block.address + index * 4)) >>> 0);
      completed += 1;
      onWord?.(completed, total);
    }
    result.push({ block, words });
  }
  return result;
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** One text line per block in the layout `espefuse dump` prints: name, read address, then the words. */
export function formatEfuseBlock(entry: EfuseBlockWords): string {
  return `${entry.block.name} (${entry.block.role}) @0x${hex32(entry.block.address)}: ${entry.words.map(hex32).join(" ")}`;
}

/**
 * What is safe to show in an operation's output: a key block's contents stay
 * out of the log (the agent reads that), while its state is still reported.
 */
export function describeEfuseBlock(entry: EfuseBlockWords): string {
  if (!entry.block.secret) return formatEfuseBlock(entry);
  const populated = entry.words.filter((word) => word !== 0).length;
  const state = populated === 0 ? "empty or read-protected (all zero)" : `${populated} of ${entry.words.length} words non-zero; contents withheld from the log`;
  return `${entry.block.name} (${entry.block.role}) @0x${hex32(entry.block.address)}: ${state}`;
}
