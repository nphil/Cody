import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 as noblesha256 } from "@noble/hashes/sha2.js";
import { fileNamePart, parseBackupRegion, parsePrimaryRegion, partitionWriteProblem } from "./edl-disk";
import { evaluateSpan } from "./edl-gpt";
import { EdlError } from "./edl-link";
import { classifyEdlPartition } from "./edl-protect";

/**
 * The manifest of a backup set, and everything a restore decides from it before it touches the device.
 *
 * A set is the files `exec backup` saves - the primary partition table (sectors 0 .. end of its entry array), every
 * partition, the backup partition table at the end of the disk - and one JSON manifest that names each by its SHA-256 and
 * says which unit they came from. Nothing here trusts the manifest alone: a restore parses the SAVED table files too and
 * requires the manifest to agree with them, and it re-hashes every file it is about to write.
 */

export const BACKUP_SET_FORMAT = "cody-edl-backup-set";
export const BACKUP_SET_VERSION = 1;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SET_PARTITIONS = 1024;
/** A saved partition table is a few dozen sectors; this bounds what a hand-edited manifest can make a restore load into memory. */
const MAX_TABLE_SECTORS = 1024;
const MAX_SECTOR = 2 ** 40;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** One saved piece of the disk: where it came from and which file holds it (found by `sha256`, never by name). */
export interface SetRegion {
  readonly firstLba: number;
  readonly sectors: number;
  readonly sha256: string;
  /** The session file's name when the set was taken. Informational. */
  readonly fileName: string;
}

export interface SetPartition extends SetRegion {
  /** Position in the partition entry array (0-based). */
  readonly index: number;
  readonly name: string;
}

/** What identifies the unit a set came from. Everything a restore compares is here. */
export interface SetUnit {
  /** The chip's serial number, 8 hex digits. */
  readonly chipSerial: string | null;
  /** Where the serial came from: the boot ROM, or (when a programmer was already running) the programmer's own account. */
  readonly chipSerialSource: "boot-rom" | "programmer" | null;
  readonly hardwareId: string | null;
  /** The OEM root public-key hash, readable only from the boot ROM. */
  readonly pkHash: string | null;
  readonly emmcSerial: string | null;
  readonly emmcProduct: string | null;
  readonly diskGuid: string;
}

export interface BackupSetManifest {
  readonly format: typeof BACKUP_SET_FORMAT;
  readonly version: typeof BACKUP_SET_VERSION;
  readonly createdAt: string;
  readonly unit: SetUnit;
  readonly geometry: { readonly sectorSize: number; readonly measuredSectors: number };
  readonly programmer: { readonly target: string | null; readonly loaderSha256: string | null };
  readonly gpt: { readonly primary: SetRegion; readonly backup: SetRegion };
  readonly partitions: readonly SetPartition[];
  /** Informational: whether Cody's restore would accept this set. The restore decides for itself. */
  readonly restorable: boolean;
  readonly notRestorableBecause: readonly string[];
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

export function manifestShort(sha256: string): string {
  return sha256.slice(0, 8);
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(noblesha256(bytes));
}

/** A chip serial as 8 lower-case hex digits, from "1a2b3c4d", "0x1A2B3C4D" or a shorter form; null when it is not one. */
export function normalizeChipSerial(text: string | null | undefined): string | null {
  const match = /^(?:0x)?([0-9a-f]{1,16})$/i.exec((text ?? "").trim());
  return match ? match[1]!.toLowerCase().padStart(8, "0") : null;
}

function sameChipSerial(left: string | null | undefined, right: string | null | undefined): boolean {
  const first = normalizeChipSerial(left);
  const second = normalizeChipSerial(right);
  return first !== null && second !== null && first.replace(/^0+/, "") === second.replace(/^0+/, "");
}

function refuse(message: string): never {
  throw new EdlError(message, "refused");
}

// ---- building and encoding --------------------------------------------------------------------------------------------

export interface ManifestInput {
  readonly createdAt: string;
  readonly unit: SetUnit;
  readonly sectorSize: number;
  readonly measuredSectors: number;
  readonly programmerTarget: string | null;
  readonly loaderSha256: string | null;
  readonly primary: SetRegion;
  readonly backup: SetRegion;
  readonly partitions: readonly SetPartition[];
  readonly problems: readonly string[];
}

export function buildManifest(input: ManifestInput): BackupSetManifest {
  const reasons: string[] = [...input.problems];
  if (input.unit.chipSerial === null) reasons.push("The chip serial number is unknown.");
  if (input.unit.pkHash === null) {
    reasons.push("The boot ROM's public-key hash was not read: a programmer was already running when this set was taken. Take it again from a device freshly put into EDL mode, with the loader chosen.");
  }
  if (input.unit.emmcSerial === null) reasons.push("The programmer did not report the eMMC serial number.");
  return {
    format: BACKUP_SET_FORMAT,
    version: BACKUP_SET_VERSION,
    createdAt: input.createdAt,
    unit: input.unit,
    geometry: { sectorSize: input.sectorSize, measuredSectors: input.measuredSectors },
    programmer: { target: input.programmerTarget, loaderSha256: input.loaderSha256 },
    gpt: { primary: input.primary, backup: input.backup },
    partitions: input.partitions,
    restorable: reasons.length === 0,
    notRestorableBecause: reasons,
  };
}

export function encodeManifest(manifest: BackupSetManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

// ---- parsing ----------------------------------------------------------------------------------------------------------

type Fields = Readonly<Record<string, unknown>>;

function bad(path: string, wanted: string): never {
  return refuse(`The backup set's manifest is not usable: ${path} must be ${wanted}. Nothing was written.`);
}

function fields(value: unknown, path: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(path, "an object");
  return Object.fromEntries(Object.entries(value));
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function textField(source: Fields, key: string, path: string, max: number, minimum = 1): string {
  const value = source[key];
  if (typeof value !== "string" || value.length < minimum || value.length > max || CONTROL_CHARACTER.test(value)) bad(`${path}.${key}`, `text of ${minimum} to ${max} characters without control characters`);
  return value as string;
}

function maybeText(source: Fields, key: string, path: string, max: number): string | null {
  return source[key] === null || source[key] === undefined ? null : textField(source, key, path, max);
}

function wholeField(source: Fields, key: string, path: string, minimum: number, maximum: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) bad(`${path}.${key}`, `a whole number from ${minimum} to ${maximum}`);
  return value as number;
}

function digestField(source: Fields, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string" || !SHA256_HEX.test(value)) bad(`${path}.${key}`, "a SHA-256 in lower-case hex (64 digits)");
  return value as string;
}

function regionField(value: unknown, path: string, maxSectors: number): SetRegion {
  const source = fields(value, path);
  return {
    firstLba: wholeField(source, "firstLba", path, 0, MAX_SECTOR),
    sectors: wholeField(source, "sectors", path, 1, maxSectors),
    sha256: digestField(source, "sha256", path),
    fileName: textField(source, "fileName", path, 160),
  };
}

/** Parses and checks a manifest's own fields. It says nothing yet about whether the saved files agree with it. */
export function parseManifest(text: string): BackupSetManifest {
  if (text.length > MAX_MANIFEST_BYTES) refuse(`The manifest is ${text.length} characters long; a backup set's manifest is far smaller. Nothing was written.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("The file is not valid JSON, so it is not a Cody backup set manifest. Nothing was written.");
  }
  const root = fields(raw, "the manifest");
  if (root.format !== BACKUP_SET_FORMAT) refuse("The file is not a Cody EDL backup set manifest. Nothing was written.");
  if (root.version !== BACKUP_SET_VERSION) refuse(`The manifest is version ${String(root.version).slice(0, 12)}, which this Cody does not understand. Nothing was written.`);

  const unit = fields(root.unit, "unit");
  const serialText = maybeText(unit, "chipSerial", "unit", 18);
  const chipSerial = serialText === null ? null : normalizeChipSerial(serialText);
  if (serialText !== null && chipSerial === null) bad("unit.chipSerial", "hex digits");
  const pkText = maybeText(unit, "pkHash", "unit", 128);
  if (pkText !== null && !/^(?:[0-9a-f]{2}){1,64}$/i.test(pkText)) bad("unit.pkHash", "hex digits");
  const source = unit.chipSerialSource;
  if (source !== null && source !== "boot-rom" && source !== "programmer") bad("unit.chipSerialSource", "boot-rom, programmer or null");
  const diskGuid = textField(unit, "diskGuid", "unit", 36).toUpperCase();
  if (!GUID.test(diskGuid)) bad("unit.diskGuid", "a GUID");

  const geometry = fields(root.geometry, "geometry");
  const sectorSize = wholeField(geometry, "sectorSize", "geometry", 512, 4096);
  if (sectorSize !== 512 && sectorSize !== 4096) bad("geometry.sectorSize", "512 or 4096");
  const measuredSectors = wholeField(geometry, "measuredSectors", "geometry", 1, MAX_SECTOR);

  const programmer = fields(root.programmer, "programmer");
  const loader = maybeText(programmer, "loaderSha256", "programmer", 64);
  if (loader !== null && !SHA256_HEX.test(loader)) bad("programmer.loaderSha256", "a SHA-256 in lower-case hex");

  const gpt = fields(root.gpt, "gpt");
  const primary = regionField(gpt.primary, "gpt.primary", MAX_TABLE_SECTORS);
  const backup = regionField(gpt.backup, "gpt.backup", MAX_TABLE_SECTORS);
  if (primary.firstLba !== 0) bad("gpt.primary.firstLba", "0 (the primary table starts the disk)");
  if (backup.firstLba + backup.sectors !== measuredSectors) bad("gpt.backup", "the region that ends at the disk's last sector");

  if (!Array.isArray(root.partitions) || root.partitions.length === 0 || root.partitions.length > MAX_SET_PARTITIONS) bad("partitions", `a list of 1 to ${MAX_SET_PARTITIONS} partitions`);
  const seen = new Set<number>();
  const partitions = (root.partitions as unknown[]).map((entry, position): SetPartition => {
    const path = `partitions[${position}]`;
    const record = fields(entry, path);
    const index = wholeField(record, "index", path, 0, MAX_SET_PARTITIONS);
    if (seen.has(index)) bad(`${path}.index`, "unique");
    seen.add(index);
    const region = regionField(record, path, MAX_SECTOR);
    if (region.firstLba + region.sectors > measuredSectors) bad(path, "inside the disk");
    return { index, name: textField(record, "name", path, 80, 0), ...region };
  });

  const reasons = Array.isArray(root.notRestorableBecause) ? root.notRestorableBecause.filter((item): item is string => typeof item === "string").slice(0, 32) : [];
  return {
    format: BACKUP_SET_FORMAT,
    version: BACKUP_SET_VERSION,
    createdAt: textField(root, "createdAt", "the manifest", 40),
    unit: {
      chipSerial,
      chipSerialSource: source === "boot-rom" || source === "programmer" ? source : null,
      hardwareId: maybeText(unit, "hardwareId", "unit", 32),
      pkHash: pkText === null ? null : pkText.toLowerCase(),
      emmcSerial: maybeText(unit, "emmcSerial", "unit", 64),
      emmcProduct: maybeText(unit, "emmcProduct", "unit", 64),
      diskGuid,
    },
    geometry: { sectorSize, measuredSectors },
    programmer: { target: maybeText(programmer, "target", "programmer", 64), loaderSha256: loader },
    gpt: { primary, backup },
    partitions,
    restorable: root.restorable === true,
    notRestorableBecause: reasons,
  };
}

// ---- which unit is this -----------------------------------------------------------------------------------------------

/** What a restore cannot do without: the set must name the unit well enough to be compared. Empty when it does. */
export function identityGaps(manifest: BackupSetManifest): string[] {
  const gaps: string[] = [];
  if (manifest.unit.chipSerial === null) gaps.push("the chip serial number");
  if (manifest.unit.pkHash === null) gaps.push("the boot ROM's public-key hash");
  if (manifest.unit.emmcSerial === null) gaps.push("the eMMC serial number");
  return gaps;
}

/** The boot ROM's account of the chip against the set's. Empty when they agree. */
export function bootRomMismatches(manifest: BackupSetManifest, identity: { readonly serial: string; readonly pkHash: string | null }): string[] {
  const problems: string[] = [];
  if (!sameChipSerial(manifest.unit.chipSerial, identity.serial)) problems.push(`chip serial number: the set is from 0x${manifest.unit.chipSerial ?? "unknown"}, this device reports 0x${identity.serial}`);
  if (identity.pkHash === null) problems.push("public-key hash: the boot ROM did not report one, so it cannot be compared");
  else if (manifest.unit.pkHash !== identity.pkHash.toLowerCase()) problems.push(`public-key hash: the set is from ${manifest.unit.pkHash ?? "an unknown key"}, this device reports ${identity.pkHash.toLowerCase()}`);
  return problems;
}

/** The programmer's account of the storage against the set's. Empty when they agree. */
export function storageMismatches(manifest: BackupSetManifest, storage: { readonly sectorSize: number; readonly totalSectors: number; readonly serialNumber: string | null; readonly productName: string | null }): string[] {
  const problems: string[] = [];
  if (manifest.unit.emmcSerial !== storage.serialNumber) {
    problems.push(`eMMC serial number: the set is from ${manifest.unit.emmcSerial ?? "an unknown part"}, this device reports ${storage.serialNumber ?? "none"}`);
  }
  if (manifest.unit.emmcProduct !== null && storage.productName !== null && manifest.unit.emmcProduct !== storage.productName) {
    problems.push(`eMMC product name: the set is from ${manifest.unit.emmcProduct}, this device reports ${storage.productName}`);
  }
  if (manifest.geometry.sectorSize !== storage.sectorSize) problems.push(`sector size: the set uses ${manifest.geometry.sectorSize} bytes, this device ${storage.sectorSize}`);
  if (manifest.geometry.measuredSectors !== storage.totalSectors) problems.push(`capacity: the set is from a disk of ${manifest.geometry.measuredSectors} sectors, this device reports ${storage.totalSectors}`);
  return problems;
}

// ---- the plan ---------------------------------------------------------------------------------------------------------

export interface RestoreRegion {
  readonly kind: "partition" | "backup-table" | "primary-table";
  /** What the user is told this is: the partition's name, or the table. */
  readonly label: string;
  /** A fragment safe to put in a file name. */
  readonly slug: string;
  readonly index: number | null;
  readonly firstLba: number;
  readonly sectors: number;
  readonly sha256: string;
  readonly fileName: string;
  /** For a partition on the protected list, why. */
  readonly protectedBecause: string | null;
}

export interface RestorePlan {
  readonly manifest: BackupSetManifest;
  /** In the order they are written: partitions by position on the disk, then the backup table, then the primary table. */
  readonly regions: readonly RestoreRegion[];
}


/**
 * Everything a restore can decide from the manifest and the two saved partition tables alone. Throws a refusal (before
 * the device is touched) unless the tables are intact, describe this disk consistently, and agree with the manifest, and
 * unless every partition may be written by name. The partition files are checked separately, against their digests.
 */
export function planRestore(manifest: BackupSetManifest, primaryBytes: Uint8Array, backupBytes: Uint8Array): RestorePlan {
  const { sectorSize, measuredSectors } = manifest.geometry;
  const guard = <T>(what: string, parse: () => T): T => {
    try {
      return parse();
    } catch (error) {
      if (error instanceof EdlError) return refuse(`${what} cannot be used: ${error.message} Nothing was written.`);
      throw error;
    }
  };
  const primary = guard("The saved primary partition table", () => parsePrimaryRegion(primaryBytes, sectorSize));
  const tail = guard("The saved backup partition table", () => parseBackupRegion(backupBytes, sectorSize));
  const { header } = primary.table;
  if (primary.regionSectors !== manifest.gpt.primary.sectors) refuse(`The manifest says the primary table is ${manifest.gpt.primary.sectors} sectors; the saved table describes ${primary.regionSectors}. Nothing was written.`);
  if (tail.sectors !== manifest.gpt.backup.sectors) refuse(`The manifest says the backup table is ${manifest.gpt.backup.sectors} sectors; the saved table describes ${tail.sectors}. Nothing was written.`);
  if (header.diskGuid !== manifest.unit.diskGuid) refuse(`The manifest names disk ${manifest.unit.diskGuid} but the saved partition table belongs to disk ${header.diskGuid}. Nothing was written.`);
  const span = evaluateSpan(measuredSectors, sectorSize, primary.table, { lastSectorReadable: true, backup: { header: tail.header, table: tail.table, problem: null } });
  if (!span.ok) refuse(`The saved partition tables do not describe a disk of ${measuredSectors} sectors consistently: ${span.reasons.join(" ")} Restoring them would write a broken table. Nothing was written.`);

  const listed = [...manifest.partitions].sort((left, right) => left.index - right.index);
  const table = [...primary.table.partitions].sort((left, right) => left.index - right.index);
  const same = listed.length === table.length && listed.every((entry, position) => {
    const found = table[position]!;
    return entry.index === found.index && entry.name === found.name && entry.firstLba === found.firstLba && entry.sectors === found.sectors;
  });
  if (!same) refuse("The manifest's partition list is not the one in the saved partition table. Nothing was written.");

  for (const part of primary.table.partitions) {
    const kind = classifyEdlPartition(part.name);
    if (kind.level === "refused") refuse(`${kind.reason} The set cannot be restored, because it would write ${part.name}. Nothing was written.`);
    const problem = partitionWriteProblem(primary, part, measuredSectors, sectorSize);
    if (problem) refuse(`${problem} Cody never writes across a partition table or another partition. Nothing was written.`);
  }

  const regions: RestoreRegion[] = [...manifest.partitions]
    .sort((left, right) => left.firstLba - right.firstLba)
    .map((part): RestoreRegion => {
      const kind = classifyEdlPartition(part.name);
      return {
        kind: "partition",
        label: part.name || `partition ${part.index}`,
        slug: `p${part.index}-${fileNamePart(part.name)}`,
        index: part.index,
        firstLba: part.firstLba,
        sectors: part.sectors,
        sha256: part.sha256,
        fileName: part.fileName,
        protectedBecause: kind.level === "protected" ? kind.reason : null,
      };
    });
  regions.push({ kind: "backup-table", label: "the backup partition table", slug: "gpt-backup", index: null, firstLba: manifest.gpt.backup.firstLba, sectors: manifest.gpt.backup.sectors, sha256: manifest.gpt.backup.sha256, fileName: manifest.gpt.backup.fileName, protectedBecause: null });
  regions.push({ kind: "primary-table", label: "the primary partition table", slug: "gpt-primary", index: null, firstLba: manifest.gpt.primary.firstLba, sectors: manifest.gpt.primary.sectors, sha256: manifest.gpt.primary.sha256, fileName: manifest.gpt.primary.fileName, protectedBecause: null });
  return { manifest, regions };
}
