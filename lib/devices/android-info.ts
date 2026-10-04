/**
 * The two pieces of `fastboot update` / `flashall` that decide WHAT may be
 * flashed: the `android-info.txt` requirements a package declares about the
 * device it is for, and the table of image files and the partitions they go to.
 * Both follow AOSP's fastboot (fastboot/fastboot.cpp) so a package behaves here
 * as it does on a PC.
 */

export interface Requirement {
  readonly line: string;
  /** The device variable to read; `board` is read as `product`. */
  readonly name: string;
  /** `require-for-product:`: the requirement applies only to this product. */
  readonly product?: string;
  /** A `reject` line passes when the value is NOT one of the options. */
  readonly invert: boolean;
  readonly options: readonly string[];
}

export interface AndroidInfo {
  readonly requirements: readonly Requirement[];
  /** Lines fastboot would call a syntax error (it reports them and carries on). */
  readonly syntaxErrors: readonly string[];
}

/** One requirement, parsed like `ParseRequirementLine`. */
function parseRequirementLine(line: string): Requirement | undefined {
  const requireReject = /^(require\s+|reject\s+)?\s*(\S+)\s*=\s*(.*)$/.exec(line);
  const forProduct = requireReject ? undefined : /^require-for-product:\s*(\S+)\s+(\S+)\s*=\s*(.*)$/.exec(line);
  if (!requireReject && !forProduct) return undefined;
  const invert = requireReject ? (requireReject[1] ?? "").trim() === "reject" : false;
  const product = forProduct?.[1];
  const rawName = (requireReject ? requireReject[2] : forProduct![2])!;
  const rawOptions = (requireReject ? requireReject[3] : forProduct![3])!;
  return {
    line,
    name: rawName === "board" ? "product" : rawName,
    ...(product ? { product } : {}),
    invert,
    options: rawOptions.split("|").map((option) => option.trim()),
  };
}

export function parseAndroidInfo(text: string): AndroidInfo {
  const requirements: Requirement[] = [];
  const syntaxErrors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const requirement = parseRequirementLine(line);
    if (requirement) requirements.push(requirement);
    else syntaxErrors.push(line);
  }
  return { requirements, syntaxErrors };
}

export interface RequirementOutcome {
  readonly line: string;
  readonly met: boolean;
  readonly detail: string;
}

/** fastboot's match rule: an option equals the value, or ends in `*` and the value starts with the rest. */
function optionMatches(option: string, value: string): boolean {
  return option === value || (option.endsWith("*") && value.startsWith(option.slice(0, -1)));
}

/**
 * Evaluates every requirement against the device, like `CheckRequirements`.
 * `getvar` answers `undefined` for a variable the bootloader refuses.
 */
export async function checkRequirements(info: AndroidInfo, currentProduct: string | undefined, getvar: (name: string) => Promise<string | undefined>): Promise<RequirementOutcome[]> {
  const outcomes: RequirementOutcome[] = [];
  for (const requirement of info.requirements) {
    if (requirement.name === "partition-exists") {
      // A device that does not know the partition cannot take this package.
      const answer = (await getvar(`has-slot:${requirement.options[0]}`))?.trim();
      const known = answer === "yes" || answer === "no";
      outcomes.push({ line: requirement.line, met: known, detail: known ? `partition ${requirement.options[0]} exists` : `the device does not have the required partition ${requirement.options[0]}` });
      continue;
    }
    if (requirement.product && requirement.product !== currentProduct) {
      outcomes.push({ line: requirement.line, met: true, detail: `ignored: the device is ${currentProduct ?? "unidentified"}, this applies only to ${requirement.product}` });
      continue;
    }
    const value = (await getvar(requirement.name))?.trim();
    if (value === undefined) {
      outcomes.push({ line: requirement.line, met: false, detail: `the bootloader would not report ${requirement.name}` });
      continue;
    }
    const matched = requirement.options.some((option) => optionMatches(option, value));
    const met = requirement.invert ? !matched : matched;
    outcomes.push({
      line: requirement.line,
      met,
      detail: met
        ? `${requirement.name} is ${value}`
        : `device ${requirement.name} is '${value}'; the package ${requirement.invert ? "rejects" : "requires"} ${requirement.options.map((option) => `'${option}'`).join(" or ")}`,
    });
  }
  return outcomes;
}

export interface SetImage {
  /** The image's file name inside the package. */
  readonly file: string;
  /** The partition it is flashed to. */
  readonly partition: string;
}

/**
 * The images `fastboot flashall` / `update` flash, in AOSP's order: boot-critical
 * partitions first, then the operating-system ones. Bootloader, radio, cache,
 * super and userdata are not flashed by `update`, and the `*_other` images that
 * target the inactive slot are not either; `skippedByUpdate` names them so the
 * result can say so.
 */
export const UPDATE_IMAGES: readonly SetImage[] = [
  { file: "boot.img", partition: "boot" },
  { file: "init_boot.img", partition: "init_boot" },
  { file: "dtbo.img", partition: "dtbo" },
  { file: "dt.img", partition: "dts" },
  { file: "pvmfw.img", partition: "pvmfw" },
  { file: "recovery.img", partition: "recovery" },
  { file: "vbmeta.img", partition: "vbmeta" },
  { file: "vbmeta_system.img", partition: "vbmeta_system" },
  { file: "vbmeta_vendor.img", partition: "vbmeta_vendor" },
  { file: "vendor_boot.img", partition: "vendor_boot" },
  { file: "vendor_kernel_boot.img", partition: "vendor_kernel_boot" },
  { file: "odm.img", partition: "odm" },
  { file: "odm_dlkm.img", partition: "odm_dlkm" },
  { file: "product.img", partition: "product" },
  { file: "system.img", partition: "system" },
  { file: "system_dlkm.img", partition: "system_dlkm" },
  { file: "system_ext.img", partition: "system_ext" },
  { file: "vendor.img", partition: "vendor" },
  { file: "vendor_dlkm.img", partition: "vendor_dlkm" },
];

export const SKIPPED_BY_UPDATE: readonly string[] = [
  "bootloader.img",
  "radio.img",
  "cache.img",
  "super.img",
  "userdata.img",
  "boot_other.img",
  "system_other.img",
  "vendor_other.img",
];
