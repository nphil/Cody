import type { HardwareContext, HardwareProtocol, HardwareRequest } from "./flasher";
import { hashBlob } from "./blob-stream";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const INTRINSIC_SAFETY_BRAND: unique symbol = Symbol("intrinsic flash safety");

export type ProtectedRegionKind = "preloader" | "lk" | "tee" | "fuses" | "bootloader" | "spi-boot" | "unknown";
export type ProtectedRegionOverride =
  | "allow-preloader"
  | "allow-lk"
  | "allow-tee"
  | "allow-fuses"
  | "allow-bootloader"
  | "allow-spi-boot"
  | "allow-unknown";

export const PROTECTED_REGION_OVERRIDES: Readonly<Record<ProtectedRegionKind, ProtectedRegionOverride>> = {
  preloader: "allow-preloader",
  lk: "allow-lk",
  tee: "allow-tee",
  fuses: "allow-fuses",
  bootloader: "allow-bootloader",
  "spi-boot": "allow-spi-boot",
  unknown: "allow-unknown",
};

export class HardwareSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HardwareSafetyError";
  }
}

/** A complete, protocol-owned chip layout. Never deserialize this from request options. */
export interface FlashLayout {
  readonly protocol: HardwareProtocol;
  readonly chip: string;
  readonly storage: "spi" | "emmc" | "nand" | "nor" | "logical";
  readonly regions: readonly FlashRegion[];
  readonly protections: Readonly<Record<ProtectedRegionKind, "present" | "absent">>;
}

export interface FlashRegion {
  readonly name: string;
  readonly offset: number;
  readonly length: number;
  readonly protection?: ProtectedRegionKind;
}

/** The only safety data that may come from request options. */
export interface FlashSafetyRequest {
  readonly expectedChip?: string;
  readonly protectedOverride?: ProtectedRegionOverride;
}

/**
 * A protocol creates this only after detecting the actual device. `eraseOffset`
 * and `eraseLength` describe every byte its vendor operation can erase, not
 * merely the source payload. The layout must be intrinsic protocol data.
 */
export interface IntrinsicFlashPlan {
  readonly protocol: HardwareProtocol;
  readonly chip: string;
  readonly region: string;
  readonly offset: number;
  readonly eraseOffset: number;
  readonly eraseLength: number;
  readonly layout: FlashLayout;
}

/** Opaque context returned only by bindIntrinsicFlashSafety. */
export interface FlashSafetyContext {
  readonly [INTRINSIC_SAFETY_BRAND]: true;
  readonly protocol: HardwareProtocol;
  readonly chip: string;
  readonly region: string;
  readonly offset: number;
  readonly eraseOffset: number;
  readonly eraseLength: number;
  readonly layout: FlashLayout;
  readonly protectedOverride?: ProtectedRegionOverride;
}

export interface FlashPolicyDecision {
  readonly chip: string;
  readonly target: string;
  readonly offset: number;
  readonly length: number;
  readonly protectedRegion?: ProtectedRegionKind;
}

export interface VerifiedFlashApproval extends FlashPolicyDecision {
  /** SHA-256 of the requested payload. */
  readonly sha256: string;
  /** SHA-256 of the complete final erase-footprint image. */
  readonly programSha256: string;
  readonly backup: string;
  readonly firmware: Blob;
  readonly payloadOffset: number;
}

export interface VerifiedFlashResult extends FlashPolicyDecision {
  readonly verified: true;
  readonly sha256: string;
  readonly programSha256: string;
  readonly readbackSha256: string;
}

export interface VerifiedFlashOperation {
  readonly request: HardwareRequest;
  readonly context: HardwareContext;
  readonly safety: FlashSafetyContext;
  readonly backup: string;
  /** Full expected final image for the complete intrinsic erase footprint. */
  readonly programImage: Blob;
  readonly write: (firmware: Blob, approval: VerifiedFlashApproval) => Promise<void>;
  readonly readback?: (approval: VerifiedFlashApproval) => Promise<Blob>;
}
const INTRINSIC_SAFETY = new WeakSet<FlashSafetyContext>();

interface CheckedRegion extends FlashRegion {
  readonly end: number;
  readonly canonicalName: string;
  readonly protection?: ProtectedRegionKind;
}

function fail(message: string): never {
  throw new HardwareSafetyError(message);
}

function requiredText(value: string, label: string): string {
  const result = value.trim();
  if (!result) fail(`Refusing flash: ${label} is required.`);
  return result;
}

function canonicalName(value: string, label: string): string {
  return requiredText(value, label).toLowerCase();
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`Refusing flash: ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`Refusing flash: ${label} must be a positive safe integer.`);
  }
  return value;
}

function rangeEnd(offset: number, length: number, label: string): number {
  const end = offset + length;
  if (!Number.isSafeInteger(end)) fail(`Refusing flash: ${label} range overflows a safe integer.`);
  return end;
}
function rangesOverlap(left: CheckedRegion, right: CheckedRegion): boolean {
  return left.offset < right.end && right.offset < left.end;
}
function parseProtectedOverride(value: unknown): ProtectedRegionOverride {
  switch (value) {
    case "allow-preloader":
    case "allow-lk":
    case "allow-tee":
    case "allow-fuses":
    case "allow-bootloader":
    case "allow-spi-boot":
    case "allow-unknown":
      return value;
    default:
      fail("Refusing flash: protected override is not a named protected-region override.");
  }
}

/** Parse only optional caller expectations; layouts and ranges in options are rejected. */
export function parseFlashSafety(options: Record<string, unknown> | undefined): FlashSafetyRequest {
  if (!options) return {};
  if (options.safety !== undefined || options.layout !== undefined || options.protections !== undefined) {
    fail("Refusing flash: caller-supplied safety layouts and protections are not accepted.");
  }
  const expectedChip = options.expectedChip;
  if (expectedChip !== undefined && typeof expectedChip !== "string") {
    fail("Refusing flash: expectedChip must be a string.");
  }
  const override = options.protectedOverride;
  return {
    ...(expectedChip === undefined ? {} : { expectedChip: requiredText(expectedChip, "expectedChip") }),
    ...(override === undefined ? {} : { protectedOverride: parseProtectedOverride(override) }),
  };
}

/** Bind an exact request to a protocol-produced, detected-device plan. */
export function bindIntrinsicFlashSafety(
  request: HardwareRequest,
  options: Record<string, unknown> | undefined,
  plan: IntrinsicFlashPlan,
): FlashSafetyContext {
  const requested = parseFlashSafety(options);
  if (request.protocol !== plan.protocol || request.action !== "flash") {
    fail("Refusing flash: intrinsic plan does not match the flash request protocol.");
  }
  if (request.target !== plan.region || request.offset !== plan.offset) {
    fail("Refusing flash: target and offset must exactly match the intrinsic detected-device plan.");
  }
  if (requested.expectedChip && canonicalName(requested.expectedChip, "expectedChip") !== canonicalName(plan.chip, "detected chip")) {
    fail(`Refusing flash: expected chip ${requested.expectedChip} does not match detected chip ${plan.chip}.`);
  }
  requireNonNegativeInteger(plan.eraseOffset, "intrinsic erase offset");
  requirePositiveInteger(plan.eraseLength, "intrinsic erase length");
  const safety: FlashSafetyContext = {
    [INTRINSIC_SAFETY_BRAND]: true,
    protocol: plan.protocol,
    chip: requiredText(plan.chip, "detected chip"),
    region: requiredText(plan.region, "intrinsic region"),
    offset: requireNonNegativeInteger(plan.offset, "intrinsic payload offset"),
    eraseOffset: plan.eraseOffset,
    eraseLength: plan.eraseLength,
    layout: plan.layout,
    ...(requested.protectedOverride ? { protectedOverride: requested.protectedOverride } : {}),
  };
  checkedLayout(safety);
  assessIntrinsicFootprint(safety, safety.eraseOffset, safety.eraseLength);
  INTRINSIC_SAFETY.add(safety);
  return safety;
}

/**
 * Match sensitive partition names independently of a reviewed layout. A layout
 * cannot relabel `lk_a` or `eFuses` into safety: those names remain protected.
 */
export function classifyProtectedRegionName(name: string): ProtectedRegionKind | undefined {
  const compact = canonicalName(name, "region").replace(/[^a-z0-9]/g, "");
  if (compact.startsWith("preloader")) return "preloader";
  if (compact.startsWith("lk")) return "lk";
  if (compact.startsWith("tee")) return "tee";
  if (compact.startsWith("efuse") || compact.startsWith("fuse")) return "fuses";
  if (compact.startsWith("bootloader")) return "bootloader";
  return undefined;
}

function checkedLayout(safety: FlashSafetyContext): readonly CheckedRegion[] {
  const layout = safety.layout;
  const safetyChip = canonicalName(safety.chip, "chip");
  if (canonicalName(layout.chip, "layout chip") !== safetyChip) {
    fail(`Refusing flash: chip ${safety.chip} does not match reviewed layout ${layout.chip}.`);
  }
  if (layout.protocol !== safety.protocol) {
    fail(`Refusing flash: ${safety.protocol} request cannot use a ${layout.protocol} layout.`);
  }
  if (!Array.isArray(layout.regions) || layout.regions.length === 0) {
    fail("Refusing flash: a reviewed, non-empty device layout is required.");
  }

  const regions = layout.regions.map((region): CheckedRegion => {
    const offset = requireNonNegativeInteger(region.offset, `offset for region ${region.name}`);
    const length = requirePositiveInteger(region.length, `length for region ${region.name}`);
    const name = canonicalName(region.name, "layout region name");
    const inferredProtection = classifyProtectedRegionName(region.name);
    if (region.protection && inferredProtection && region.protection !== inferredProtection) {
      fail(`Refusing flash: region ${region.name} conflicts with its required ${inferredProtection} protection.`);
    }
    return {
      ...region,
      offset,
      length,
      end: rangeEnd(offset, length, `region ${region.name}`),
      canonicalName: name,
      protection: region.protection ?? inferredProtection,
    };
  });

  for (let index = 0; index < regions.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < regions.length; otherIndex += 1) {
      if (rangesOverlap(regions[index], regions[otherIndex])) {
        fail(`Refusing flash: reviewed layout regions ${regions[index].name} and ${regions[otherIndex].name} overlap.`);
      }
    }
  }

  for (const kind of Object.keys(PROTECTED_REGION_OVERRIDES) as ProtectedRegionKind[]) {
    const status = layout.protections[kind];
    if (status !== "present" && status !== "absent") {
      fail(`Refusing flash: reviewed layout must explicitly mark ${kind} present or absent.`);
    }
    const matchingRegions = regions.filter((region) => region.protection === kind);
    if (status === "present" && matchingRegions.length === 0) {
      fail(`Refusing flash: layout marks ${kind} present without a protected range.`);
    }
    if (status === "absent" && matchingRegions.length > 0) {
      fail(`Refusing flash: layout marks ${kind} absent but declares protected range ${matchingRegions[0].name}.`);
    }
  }


  return regions;
}

/**
 * Refuse writes outside an exact reviewed range. The returned decision is safe
 * to pass directly to the destructive confirmation and verifier helpers.
 */
export function assessFlashWritePolicy(safety: FlashSafetyContext, length: number): FlashPolicyDecision {
  const offset = requireNonNegativeInteger(safety.offset, "write offset");
  const writeLength = requirePositiveInteger(length, "firmware length");
  const end = rangeEnd(offset, writeLength, "write");
  const target = requiredText(safety.region, "region");
  const targetName = canonicalName(target, "region");
  const regions = checkedLayout(safety);
  const matches = regions.filter((region) => region.canonicalName === targetName);
  if (matches.length !== 1) {
    fail(`Refusing flash: region ${target} is not uniquely described by the reviewed layout.`);
  }

  const region = matches[0];
  if (offset < region.offset || end > region.end) {
    fail(`Refusing flash: ${target} write [${offset}, ${end}) escapes reviewed range [${region.offset}, ${region.end}).`);
  }

  if (region.protection) {
    const expectedOverride = PROTECTED_REGION_OVERRIDES[region.protection];
    if (safety.protectedOverride !== expectedOverride) {
      fail(`Refusing flash: ${target} is protected (${region.protection}); exact override ${expectedOverride} is required.`);
    }
  } else if (safety.protectedOverride) {
    fail(`Refusing flash: override ${safety.protectedOverride} does not apply to unprotected region ${target}.`);
  }

  return {
    chip: requiredText(safety.chip, "chip"),
    target,
    offset,
    length: writeLength,
    ...(region.protection ? { protectedRegion: region.protection } : {}),
  };
}

/**
 * Validate a contiguous physical write/erase footprint against every intrinsic
 * layout range it crosses. Unlike target-name policy this permits a reviewed
 * factory image to span adjacent ranges while retaining each range's protection.
 */
function assessIntrinsicFootprint(safety: FlashSafetyContext, offset: number, length: number): FlashPolicyDecision {
  const start = requireNonNegativeInteger(offset, "intrinsic footprint offset");
  const footprintLength = requirePositiveInteger(length, "intrinsic footprint length");
  const end = rangeEnd(start, footprintLength, "intrinsic footprint");
  const regions = checkedLayout(safety)
    .filter((region) => region.offset < end && region.end > start)
    .slice()
    .sort((left, right) => left.offset - right.offset);
  let cursor = start;
  let protection: ProtectedRegionKind | undefined;
  for (const region of regions) {
    if (region.offset > cursor) {
      fail(`Refusing flash: intrinsic footprint has an unknown gap [${cursor}, ${region.offset}).`);
    }
    if (region.end <= cursor) continue;
    if (region.protection) {
      if (protection && protection !== region.protection) {
        fail(`Refusing flash: footprint crosses multiple protected regions (${protection}, ${region.protection}).`);
      }
      protection = region.protection;
    }
    cursor = region.end;
    if (cursor >= end) break;
  }
  if (cursor < end) fail(`Refusing flash: intrinsic footprint escapes reviewed ranges at ${cursor}.`);

  if (protection) {
    const expectedOverride = PROTECTED_REGION_OVERRIDES[protection];
    if (safety.protectedOverride !== expectedOverride) {
      fail(`Refusing flash: footprint includes protected ${protection}; exact override ${expectedOverride} is required.`);
    }
  } else if (safety.protectedOverride) {
    fail(`Refusing flash: override ${safety.protectedOverride} does not apply to the intrinsic footprint.`);
  }

  return {
    chip: requiredText(safety.chip, "chip"),
    target: requiredText(safety.region, "region"),
    offset: start,
    length: footprintLength,
    ...(protection ? { protectedRegion: protection } : {}),
  };
}
/** SHA-256 in canonical lowercase hexadecimal, with bounded working memory. */
export async function sha256Blob(blob: Blob): Promise<string> {
  return hashBlob(blob);
}

export function normalizeSha256(value: string, label = "SHA-256"): string {
  const hash = requiredText(value, label).toLowerCase();
  if (!SHA256_HEX.test(hash)) fail(`Refusing flash: ${label} must be a 64-character hexadecimal SHA-256.`);
  return hash;
}

/** Hash firmware before the write and bind any caller-provided expected digest to it. */
export async function hashFirmware(blob: Blob, expectedSha256?: string): Promise<string> {
  const actual = await sha256Blob(blob);
  if (expectedSha256 && normalizeSha256(expectedSha256, "request SHA-256") !== actual) {
    fail("Refusing flash: supplied SHA-256 does not match firmware.");
  }
  return actual;
}

/** Verify the exact post-write range. A device acknowledgement or delivery CRC is not a readback verifier. */
export async function verifyReadback(expectedSha256: string, expectedLength: number, readback: Blob): Promise<string> {
  const expected = normalizeSha256(expectedSha256, "expected SHA-256");
  if (readback.size !== expectedLength) {
    fail(`Readback verification failed: expected ${expectedLength} bytes but received ${readback.size}.`);
  }
  const actual = await sha256Blob(readback);
  if (actual !== expected) fail("Readback verification failed: SHA-256 does not match the firmware.");
  return actual;
}

function requireFlashRequest(request: HardwareRequest, safety: FlashSafetyContext): void {
  if (request.action !== "flash") fail(`Refusing ${request.action}: verified flash guard only permits flash actions.`);
  if (request.protocol !== safety.protocol) {
    fail(`Refusing flash: request protocol ${request.protocol} does not match safety protocol ${safety.protocol}.`);
  }
  if (request.target !== safety.region) {
    fail("Refusing flash: request target must exactly match the reviewed safety region.");
  }
  if (request.offset !== safety.offset) {
    fail("Refusing flash: request offset must exactly match the reviewed safety offset.");
  }
}

function requireBackup(backup: string): string {
  const reference = backup.trim();
  if (!reference) fail("Refusing flash: a persistent pre-write backup escrow reference is required.");
  return reference;
}

/**
 * The only generic flash execution path. It establishes layout protection and
 * readback capability before the risk is declared; calls the write once;
 * then returns success only after exact-image readback SHA-256 verification.
 */
export async function runVerifiedFlash(operation: VerifiedFlashOperation): Promise<VerifiedFlashResult> {
  if (!INTRINSIC_SAFETY.has(operation.safety)) {
    fail("Refusing flash: safety context must be bound from an intrinsic detected-device plan.");
  }
  if (typeof operation.write !== "function") fail("Refusing flash: protocol write implementation is required.");
  if (typeof operation.readback !== "function") {
    fail(`Refusing flash: ${operation.safety.protocol} on ${operation.safety.chip} cannot provide post-write image readback verification.`);
  }
  if (!(operation.programImage instanceof Blob)) {
    fail("Refusing flash: a complete final erase-footprint image is required.");
  }

  requireFlashRequest(operation.request, operation.safety);
  const payload = operation.context.input;
  if (!payload) fail("Refusing flash: firmware input is required.");
  const payloadEnd = rangeEnd(operation.safety.offset, payload.size, "payload");
  const eraseEnd = rangeEnd(operation.safety.eraseOffset, operation.safety.eraseLength, "intrinsic erase footprint");
  if (operation.safety.offset < operation.safety.eraseOffset || payloadEnd > eraseEnd) {
    fail("Refusing flash: payload escapes the intrinsic erase footprint.");
  }
  if (operation.programImage.size !== operation.safety.eraseLength) {
    fail("Refusing flash: final image must cover the complete intrinsic erase footprint.");
  }

  const payloadSha256 = await hashFirmware(payload, operation.request.sha256);
  assessIntrinsicFootprint(operation.safety, operation.safety.offset, payload.size);
  const eraseDecision = assessIntrinsicFootprint(operation.safety, operation.safety.eraseOffset, operation.safety.eraseLength);
  const programSha256 = operation.programImage === payload
    ? payloadSha256
    : await sha256Blob(operation.programImage);
  const backup = requireBackup(operation.backup);
  const approval: VerifiedFlashApproval = {
    ...eraseDecision,
    sha256: payloadSha256,
    programSha256,
    backup,
    firmware: operation.programImage,
    payloadOffset: operation.safety.offset,
  };

  await operation.context.confirm({
    action: "flash",
    target: approval.target,
    sha256: approval.sha256,
    offset: operation.safety.offset,
    length: payload.size,
    programSha256: approval.programSha256,
    programOffset: approval.offset,
    programLength: approval.length,
    ...(approval.protectedRegion === "unknown"
      ? { details: `Unclassified ${operation.safety.protocol} target ${JSON.stringify(approval.target)}: role and topology are unknown.` }
      : {}),
    backup: approval.backup,
  });

  await operation.write(operation.programImage, approval);
  const readback = await operation.readback(approval);
  const readbackSha256 = await verifyReadback(approval.programSha256, approval.length, readback);

  return { ...eraseDecision, verified: true, sha256: payloadSha256, programSha256, readbackSha256 };
}
