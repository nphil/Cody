import { classifyProtectedRegionName } from "./hardware-safety";

/**
 * Which partitions a write may name, and what it takes.
 *
 *   refused     the eMMC boot areas and RPMB: another part of the chip than the user
 *               area this layer talks to, and the part a device boots from first. No
 *               override exists; a name that looks like one is refused too, wherever
 *               it sits in the partition table.
 *   protected   the boot chain and the radio / identity data a unit cannot be rebuilt
 *               from: writing one is allowed and noted as PROTECTED in the log,
 *               with no extra prompt.
 *   ordinary    everything else (boot, recovery, system, vendor, userdata, ...).
 *
 * Names are compared lower-case with an A/B slot suffix (`_a`, `_b`) removed.
 */
export type PartitionClass =
  | { readonly level: "ordinary" }
  | { readonly level: "protected"; readonly reason: string }
  | { readonly level: "refused"; readonly reason: string };

/** `boot0`, `boot1`, `rpmb` and the kernel's names for them, with anything that follows. */
const BOOT_AREA_OR_RPMB = /^(?:rpmb|boot[01]|mmcblk\d+(?:boot\d*|rpmb))(?:[_:-].*)?$/i;

const BOOT_CHAIN: Readonly<Record<string, true>> = {
  sbl1: true, sbl2: true, sbl3: true, xbl: true, xbl_config: true, abl: true, aboot: true, emmc_appsboot: true, bootloader: true,
  tz: true, hyp: true, rpm: true, aop: true, pmic: true, devcfg: true, dbi: true, ddr: true, lk: true,
  apdp: true, msadp: true, qupfw: true, storsec: true,
};
const BOOT_CHAIN_PREFIXES: readonly string[] = ["cmnlib", "keymaster", "sbl", "xbl"];

const RADIO_AND_IDENTITY: Readonly<Record<string, true>> = {
  modem: true, modemst1: true, modemst2: true, fsg: true, fsc: true, persist: true, devinfo: true, sec: true, misc: true,
};

const PARTITION_TABLE: Readonly<Record<string, true>> = {
  gpt: true, pgpt: true, sgpt: true, primarygpt: true, backupgpt: true, gpt_main0: true, gpt_backup0: true,
};

function baseName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-][ab]$/, "");
}

export function classifyEdlPartition(name: string): PartitionClass {
  const trimmed = name.trim();
  if (BOOT_AREA_OR_RPMB.test(trimmed)) {
    return { level: "refused", reason: `"${name}" is named like an eMMC boot area or RPMB. Those are not part of the user area Cody writes by partition name, and there is no override for them.` };
  }
  const base = baseName(name);
  if (Object.hasOwn(PARTITION_TABLE, base)) {
    return { level: "protected", reason: `"${name}" is a partition table. Rewriting it changes where every partition is; restoring a whole backup set is the way to replace it.` };
  }
  if (Object.hasOwn(BOOT_CHAIN, base) || BOOT_CHAIN_PREFIXES.some((prefix) => base.startsWith(prefix)) || classifyProtectedRegionName(name) !== undefined) {
    return { level: "protected", reason: `"${name}" is part of the boot chain. A bad write can leave the device unable to start, and EDL may be the only way back.` };
  }
  if (Object.hasOwn(RADIO_AND_IDENTITY, base)) {
    return { level: "protected", reason: `"${name}" holds radio calibration or identity data that is unique to this unit and cannot be rebuilt from a firmware package.` };
  }
  return { level: "ordinary" };
}
